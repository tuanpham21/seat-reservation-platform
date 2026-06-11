export const STRIPE_METADATA_KEYS = Object.freeze({
  paymentId: "payment_id",
  holdId: "hold_id",
  userId: "user_id"
});

export type CheckoutMetadataInput = {
  paymentId: string;
  holdId: string;
  userId: string;
};

export function buildCheckoutMetadata(input: CheckoutMetadataInput): Record<string, string> {
  return {
    [STRIPE_METADATA_KEYS.paymentId]: input.paymentId,
    [STRIPE_METADATA_KEYS.holdId]: input.holdId,
    [STRIPE_METADATA_KEYS.userId]: input.userId
  };
}

export function getPaymentIdFromMetadata(metadata: Record<string, string> | null | undefined) {
  return metadata?.[STRIPE_METADATA_KEYS.paymentId] ?? null;
}
