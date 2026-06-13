import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PaymentHttpError } from "./errors";
import {
  assertStripeCheckoutReady,
  getStripeSecretKey,
  getStripeWebhookSecret,
  resetStripeClientForTests,
  toStripeCheckoutHttpError
} from "./stripe";

const originalStripeSecretKey = process.env.STRIPE_SECRET_KEY;
const originalStripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const originalStripeWebhookSecretFile = process.env.STRIPE_WEBHOOK_SECRET_FILE;

afterEach(() => {
  if (originalStripeSecretKey === undefined) {
    delete process.env.STRIPE_SECRET_KEY;
  } else {
    process.env.STRIPE_SECRET_KEY = originalStripeSecretKey;
  }
  if (originalStripeWebhookSecret === undefined) {
    delete process.env.STRIPE_WEBHOOK_SECRET;
  } else {
    process.env.STRIPE_WEBHOOK_SECRET = originalStripeWebhookSecret;
  }
  if (originalStripeWebhookSecretFile === undefined) {
    delete process.env.STRIPE_WEBHOOK_SECRET_FILE;
  } else {
    process.env.STRIPE_WEBHOOK_SECRET_FILE = originalStripeWebhookSecretFile;
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

  it("keeps placeholder Stripe secret errors ahead of webhook readiness checks", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_replace_me";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_replace_me";

    expect(() => assertStripeCheckoutReady()).toThrowError(
      expect.objectContaining({
        status: 503,
        code: "stripe_secret_placeholder"
      })
    );
  });

  it("blocks Checkout when a test secret is configured before webhook forwarding is ready", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_ready";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_replace_me";
    delete process.env.STRIPE_WEBHOOK_SECRET_FILE;

    expect(() => assertStripeCheckoutReady()).toThrowError(
      expect.objectContaining({
        status: 503,
        code: "stripe_webhook_not_ready",
        details: {
          cause: "stripe_webhook_secret_missing"
        }
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

  it("uses a generated webhook secret file when the environment value is a placeholder", () => {
    const directory = mkdtempSync(join(tmpdir(), "stripe-secret-"));
    const secretFile = join(directory, "webhook-secret");

    try {
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_replace_me";
      process.env.STRIPE_WEBHOOK_SECRET_FILE = secretFile;
      writeFileSync(secretFile, "whsec_from_file\n");

      expect(getStripeWebhookSecret()).toBe("whsec_from_file");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("prefers a valid generated webhook secret file over stale environment values", () => {
    const directory = mkdtempSync(join(tmpdir(), "stripe-secret-"));
    const secretFile = join(directory, "webhook-secret");

    try {
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_stale_env";
      process.env.STRIPE_WEBHOOK_SECRET_FILE = secretFile;
      writeFileSync(secretFile, "whsec_from_file\n");

      expect(getStripeWebhookSecret()).toBe("whsec_from_file");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("falls back to an explicitly configured webhook secret when the generated file is missing", () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_from_env";
    process.env.STRIPE_WEBHOOK_SECRET_FILE = "/tmp/seat-reservation-missing-whsec";

    expect(getStripeWebhookSecret()).toBe("whsec_from_env");
  });

  it("rejects invalid generated webhook secret file contents when no usable environment secret exists", () => {
    const directory = mkdtempSync(join(tmpdir(), "stripe-secret-"));
    const secretFile = join(directory, "webhook-secret");

    try {
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_replace_me";
      process.env.STRIPE_WEBHOOK_SECRET_FILE = secretFile;
      writeFileSync(secretFile, "not-a-webhook-secret\n");

      expect(() => getStripeWebhookSecret()).toThrowError(
        expect.objectContaining({
          status: 500,
          code: "stripe_webhook_secret_invalid"
        })
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
