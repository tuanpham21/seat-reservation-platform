import { afterEach, describe, expect, it, vi } from "vitest";

const originalAppUrl = process.env.APP_URL;

async function loadCheckoutModule() {
  vi.resetModules();
  return import("./checkout");
}

afterEach(() => {
  if (originalAppUrl === undefined) {
    delete process.env.APP_URL;
  } else {
    process.env.APP_URL = originalAppUrl;
  }

  vi.resetModules();
});

describe("Stripe Checkout return URLs", () => {
  it("uses APP_URL as the canonical callback origin", async () => {
    process.env.APP_URL = "https://review.example.com/base";

    const { buildReturnUrl } = await loadCheckoutModule();

    expect(buildReturnUrl("/payments/success", "payment-1")).toBe(
      "https://review.example.com/payments/success?paymentId=payment-1"
    );
    expect(buildReturnUrl("/payments/cancel", "payment-1")).toBe(
      "https://review.example.com/payments/cancel?paymentId=payment-1"
    );
  });
});
