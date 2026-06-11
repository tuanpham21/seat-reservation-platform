import { PaymentStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  HOLD_EXPIRED_REVIEW_REASON,
  resolveCompletedCheckoutState
} from "./state";

describe("completed checkout state", () => {
  it("marks successful payment as paid when the hold is still valid", () => {
    const result = resolveCompletedCheckoutState(
      {
        expiresAt: new Date("2026-06-11T10:05:00.000Z"),
        isActive: true
      },
      new Date("2026-06-11T10:04:59.000Z")
    );

    expect(result).toEqual({
      status: PaymentStatus.succeeded,
      requiresReviewReason: null
    });
  });

  it("requires review when Stripe confirms after the hold expires", () => {
    const result = resolveCompletedCheckoutState(
      {
        expiresAt: new Date("2026-06-11T10:05:00.000Z"),
        isActive: true
      },
      new Date("2026-06-11T10:05:00.000Z")
    );

    expect(result).toEqual({
      status: PaymentStatus.requires_review,
      requiresReviewReason: HOLD_EXPIRED_REVIEW_REASON
    });
  });
});
