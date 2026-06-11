import { PaymentStatus, SeatHoldStatus } from "@prisma/client";
import { z } from "zod";

import { PaymentHttpError } from "./errors";
import { buildCheckoutMetadata } from "./metadata";
import { SEAT_RESERVATION_PRICE } from "./price";
import { prisma } from "../prisma";
import { getStripeClient } from "./stripe";

export const CreateCheckoutRequestSchema = z.object({
  holdId: z.string().min(1)
});

export type CreateCheckoutSessionInput = {
  userId: string;
  holdId: string;
  requestOrigin: string;
  now?: Date;
};

export async function createCheckoutSession(input: CreateCheckoutSessionInput) {
  const now = input.now ?? new Date();
  const seatHold = await prisma.seatHold.findFirst({
    where: {
      id: input.holdId,
      userId: input.userId,
      status: SeatHoldStatus.active
    },
    select: {
      id: true,
      expiresAt: true
    }
  });

  if (!seatHold) {
    throw new PaymentHttpError(409, "hold_not_payable", "Hold is not available for payment.");
  }

  if (now.getTime() >= seatHold.expiresAt.getTime()) {
    throw new PaymentHttpError(409, "hold_expired", "Hold expired before payment started.");
  }

  const activePayment = await prisma.payment.findFirst({
    where: {
      userId: input.userId,
      seatHoldId: seatHold.id,
      status: {
        in: [PaymentStatus.checkout_created, PaymentStatus.processing]
      }
    },
    select: {
      id: true,
      stripeCheckoutSessionId: true,
      checkoutUrl: true
    }
  });

  if (activePayment?.checkoutUrl) {
    return {
      paymentId: activePayment.id,
      checkoutSessionId: activePayment.stripeCheckoutSessionId,
      checkoutUrl: activePayment.checkoutUrl
    };
  }

  const payment = await prisma.payment.create({
    data: {
      userId: input.userId,
      seatHoldId: seatHold.id,
      amountCents: SEAT_RESERVATION_PRICE.unitAmountCents,
      currency: SEAT_RESERVATION_PRICE.currency,
      status: PaymentStatus.checkout_created,
      metadata: {
        pricing: "fixed_usd_50"
      }
    },
    select: {
      id: true
    }
  });

  const metadata = buildCheckoutMetadata({
    paymentId: payment.id,
    holdId: seatHold.id,
    userId: input.userId
  });

  const session = await getStripeClient().checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    client_reference_id: payment.id,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: SEAT_RESERVATION_PRICE.currency,
          unit_amount: SEAT_RESERVATION_PRICE.unitAmountCents,
          product_data: {
            name: SEAT_RESERVATION_PRICE.productName
          }
        }
      }
    ],
    metadata,
    payment_intent_data: {
      metadata
    },
    success_url: `${input.requestOrigin}/payments/success?paymentId=${payment.id}`,
    cancel_url: `${input.requestOrigin}/payments/cancel?paymentId=${payment.id}`
  });

  if (!session.url) {
    throw new PaymentHttpError(
      502,
      "stripe_checkout_url_missing",
      "Stripe did not return a Checkout URL."
    );
  }

  await prisma.payment.update({
    where: {
      id: payment.id
    },
    data: {
      stripeCheckoutSessionId: session.id,
      checkoutUrl: session.url,
      providerStatus: session.status
    }
  });

  return {
    paymentId: payment.id,
    checkoutSessionId: session.id,
    checkoutUrl: session.url
  };
}
