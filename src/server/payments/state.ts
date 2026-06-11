import { PaymentStatus } from "@prisma/client";

export const PAYMENT_TERMINAL_STATES = new Set<PaymentStatus>([
  PaymentStatus.succeeded,
  PaymentStatus.requires_review,
  PaymentStatus.failed,
  PaymentStatus.expired
]);

export const HOLD_EXPIRED_REVIEW_REASON = "hold_expired_before_payment_confirmation";
export const HOLD_INACTIVE_REVIEW_REASON = "hold_inactive_before_payment_confirmation";

export type CompletedCheckoutResolution =
  | {
      status: typeof PaymentStatus.succeeded;
      requiresReviewReason: null;
    }
  | {
      status: typeof PaymentStatus.requires_review;
      requiresReviewReason:
        | typeof HOLD_EXPIRED_REVIEW_REASON
        | typeof HOLD_INACTIVE_REVIEW_REASON;
    };

export function resolveCompletedCheckoutState(
  hold: { expiresAt: Date; isActive: boolean },
  now: Date
): CompletedCheckoutResolution {
  if (!hold.isActive) {
    return {
      status: PaymentStatus.requires_review,
      requiresReviewReason: HOLD_INACTIVE_REVIEW_REASON
    };
  }

  if (now.getTime() >= hold.expiresAt.getTime()) {
    return {
      status: PaymentStatus.requires_review,
      requiresReviewReason: HOLD_EXPIRED_REVIEW_REASON
    };
  }

  return {
    status: PaymentStatus.succeeded,
    requiresReviewReason: null
  };
}
