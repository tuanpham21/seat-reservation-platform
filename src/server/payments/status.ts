import { PaymentHttpError } from "./errors";
import { prisma } from "../prisma";

export async function getPaymentStatus(paymentId: string, userId: string) {
  const payment = await prisma.payment.findFirst({
    where: {
      id: paymentId,
      userId
    },
    select: {
      id: true,
      seatHoldId: true,
      amountCents: true,
      currency: true,
      status: true,
      providerStatus: true,
      requiresReviewReason: true,
      createdAt: true,
      updatedAt: true,
      seatHold: {
        select: {
          reservation: {
            select: {
              id: true
            }
          }
        }
      }
    }
  });

  if (!payment) {
    throw new PaymentHttpError(404, "payment_not_found", "Payment was not found.");
  }

  return {
    paymentId: payment.id,
    holdId: payment.seatHoldId,
    amountCents: payment.amountCents,
    currency: payment.currency,
    businessState: payment.status,
    providerStatus: payment.providerStatus,
    reservationId: payment.seatHold.reservation?.id ?? null,
    requiresReviewReason: payment.requiresReviewReason,
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString()
  };
}
