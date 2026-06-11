import { describe, expect, it } from "vitest";

import {
  buildCheckoutMetadata,
  getPaymentIdFromMetadata,
  STRIPE_METADATA_KEYS
} from "./metadata";

describe("Stripe payment metadata", () => {
  it("includes the payment, hold, and user identifiers", () => {
    const metadata = buildCheckoutMetadata({
      paymentId: "pay_123",
      holdId: "hold_456",
      userId: "user_789"
    });

    expect(metadata).toEqual({
      [STRIPE_METADATA_KEYS.paymentId]: "pay_123",
      [STRIPE_METADATA_KEYS.holdId]: "hold_456",
      [STRIPE_METADATA_KEYS.userId]: "user_789"
    });
    expect(getPaymentIdFromMetadata(metadata)).toBe("pay_123");
  });
});
