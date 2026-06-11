import { describe, expect, it, afterEach } from "vitest";

import { PaymentHttpError } from "./errors";
import {
  getStripeSecretKey,
  resetStripeClientForTests,
  toStripeCheckoutHttpError
} from "./stripe";

const originalStripeSecretKey = process.env.STRIPE_SECRET_KEY;

afterEach(() => {
  if (originalStripeSecretKey === undefined) {
    delete process.env.STRIPE_SECRET_KEY;
  } else {
    process.env.STRIPE_SECRET_KEY = originalStripeSecretKey;
  }
  resetStripeClientForTests();
});

describe("Stripe checkout configuration", () => {
  it("rejects the bundled placeholder secret before creating Checkout sessions", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_replace_me";

    expect(() => getStripeSecretKey()).toThrowError(
      expect.objectContaining({
        status: 503,
        code: "stripe_secret_placeholder"
      })
    );
  });

  it("translates Stripe authentication failures into configuration errors", () => {
    const error = toStripeCheckoutHttpError({
      type: "StripeAuthenticationError",
      statusCode: 401
    });

    expect(error).toBeInstanceOf(PaymentHttpError);
    expect(error).toMatchObject({
      status: 503,
      code: "stripe_authentication_failed"
    });
  });
});
