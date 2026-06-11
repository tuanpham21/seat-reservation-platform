import { PaymentStatus, Prisma, ReservationStatus, SeatHoldStatus } from "@prisma/client";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import type Stripe from "stripe";

import { getPaymentIdFromMetadata, STRIPE_METADATA_KEYS } from "./metadata";
import { prisma } from "../prisma";
import { runSerializableTransaction } from "../transactions";
import {
  PAYMENT_TERMINAL_STATES,
  resolveCompletedCheckoutState
} from "./state";
import { SEAT_RESERVATION_PRICE } from "./price";

type PaymentTransaction = Prisma.TransactionClient;

type StripeWebhookResult = {
  status: "processed" | "duplicate";
  eventId: string;
  paymentId?: string;
  action?: string;
};

const SEAT_ALREADY_RESERVED_REVIEW_REASON = "seat_already_reserved_at_payment_confirmation";
const STRIPE_VALIDATION_REVIEW_REASON = "stripe_checkout_validation_mismatch";

function isUniqueConstraintError(error: unknown) {
  return error instanceof PrismaClientKnownRequestError && error.code === "P2002";
}

function paymentIntentIdFromSession(session: Stripe.Checkout.Session) {
  if (typeof session.payment_intent === "string") {
    return session.payment_intent;
  }

  return session.payment_intent?.id ?? null;
}

async function recordEvent(tx: PaymentTransaction, event: Stripe.Event) {
  try {
    await tx.paymentEvent.create({
      data: {
        stripeEventId: event.id,
        eventType: event.type,
        payload: event as unknown as Prisma.InputJsonValue
      }
    });

    return true;
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return false;
    }

    throw error;
  }
}

async function markEventProcessed(
  tx: PaymentTransaction,
  event: Stripe.Event,
  paymentId: string | undefined,
  now: Date
) {
  await tx.paymentEvent.update({
    where: {
      stripeEventId: event.id
    },
    data: {
      paymentId,
      processedAt: now
    }
  });
}

async function completeCheckoutSession(
  tx: PaymentTransaction,
  event: Stripe.Event,
  session: Stripe.Checkout.Session,
  now: Date
) {
  const paymentId = getPaymentIdFromMetadata(session.metadata);

  if (!paymentId) {
    return {
      action: "ignored_missing_payment_metadata"
    };
  }

  const payment = await tx.payment.findUnique({
    where: {
      id: paymentId
    },
    include: {
      seatHold: {
        include: {
          reservation: true
        }
      }
    }
  });

  if (!payment) {
    return {
      paymentId,
      action: "ignored_unknown_payment"
    };
  }

  const stripePaymentIntentId = paymentIntentIdFromSession(session);
  const providerStatus = session.payment_status ?? session.status;

  const validation = validateCheckoutSession(event, session, payment);
  if (!validation.valid) {
    await tx.payment.update({
      where: {
        id: payment.id
      },
      data: {
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId,
        providerStatus,
        status: PaymentStatus.requires_review,
        requiresReviewReason: STRIPE_VALIDATION_REVIEW_REASON
      }
    });

    return {
      paymentId: payment.id,
      action: `marked_requires_review_${validation.reason}`
    };
  }

  if (PAYMENT_TERMINAL_STATES.has(payment.status) && payment.status !== PaymentStatus.expired) {
    await tx.payment.update({
      where: {
        id: payment.id
      },
      data: {
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId,
        providerStatus
      }
    });

    return {
      paymentId: payment.id,
      action: "ignored_terminal_payment"
    };
  }

  if (session.payment_status !== "paid") {
    await tx.payment.update({
      where: {
        id: payment.id
      },
      data: {
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId,
        providerStatus,
        status: PaymentStatus.processing
      }
    });

    return {
      paymentId: payment.id,
      action: "marked_processing"
    };
  }

  const resolution = resolveCompletedCheckoutState(
    {
      expiresAt: payment.seatHold.expiresAt,
      isActive: payment.seatHold.status === SeatHoldStatus.active
    },
    now
  );

  if (resolution.status === PaymentStatus.requires_review) {
    await tx.payment.update({
      where: {
        id: payment.id
      },
      data: {
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId,
        providerStatus,
        status: PaymentStatus.requires_review,
        requiresReviewReason: resolution.requiresReviewReason
      }
    });

    return {
      paymentId: payment.id,
      action: "marked_requires_review"
    };
  }

  const confirmedSeatReservation = await tx.reservation.findFirst({
    where: {
      seatId: payment.seatHold.seatId,
      status: ReservationStatus.confirmed,
      NOT: {
        seatHoldId: payment.seatHoldId
      }
    },
    select: {
      id: true
    }
  });

  if (confirmedSeatReservation) {
    await tx.payment.update({
      where: {
        id: payment.id
      },
      data: {
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId,
        providerStatus,
        status: PaymentStatus.requires_review,
        requiresReviewReason: SEAT_ALREADY_RESERVED_REVIEW_REASON
      }
    });

    return {
      paymentId: payment.id,
      action: "marked_requires_review_seat_reserved"
    };
  }

  await tx.reservation.upsert({
    where: {
      seatHoldId: payment.seatHoldId
    },
    update: {},
    create: {
      seatId: payment.seatHold.seatId,
      userId: payment.userId,
      seatHoldId: payment.seatHoldId
    }
  });

  await tx.seatHold.update({
    where: {
      id: payment.seatHoldId
    },
    data: {
      status: SeatHoldStatus.converted,
      convertedAt: now
    }
  });

  await tx.payment.update({
    where: {
      id: payment.id
    },
    data: {
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId,
      providerStatus,
      status: PaymentStatus.succeeded,
      requiresReviewReason: null
    }
  });

  return {
    paymentId: payment.id,
    action: "reservation_finalized"
  };
}

async function expireCheckoutSession(tx: PaymentTransaction, session: Stripe.Checkout.Session) {
  const paymentId = getPaymentIdFromMetadata(session.metadata);

  if (!paymentId) {
    return {
      action: "ignored_missing_payment_metadata"
    };
  }

  const payment = await tx.payment.findUnique({
    where: {
      id: paymentId
    },
    select: {
      id: true,
      status: true,
      stripeCheckoutSessionId: true
    }
  });

  if (!payment) {
    return {
      paymentId,
      action: "ignored_unknown_payment"
    };
  }

  if (
    (!payment.stripeCheckoutSessionId || payment.stripeCheckoutSessionId === session.id) &&
    !PAYMENT_TERMINAL_STATES.has(payment.status)
  ) {
    await tx.payment.update({
      where: {
        id: payment.id
      },
      data: {
        stripeCheckoutSessionId: session.id,
        providerStatus: session.status,
        status: PaymentStatus.expired
      }
    });
  }

  return {
    paymentId: payment.id,
    action: "marked_expired"
  };
}

async function failPaymentIntent(tx: PaymentTransaction, paymentIntent: Stripe.PaymentIntent) {
  const paymentId = getPaymentIdFromMetadata(paymentIntent.metadata);

  const payment = paymentId
    ? await tx.payment.findUnique({
        where: {
          id: paymentId
        }
      })
    : await tx.payment.findUnique({
        where: {
          stripePaymentIntentId: paymentIntent.id
        }
      });

  if (!payment) {
    return {
      paymentId: paymentId ?? undefined,
      action: "ignored_unknown_payment"
    };
  }

  if (!PAYMENT_TERMINAL_STATES.has(payment.status)) {
    await tx.payment.update({
      where: {
        id: payment.id
      },
      data: {
        stripePaymentIntentId: paymentIntent.id,
        providerStatus: paymentIntent.status,
        status: PaymentStatus.failed
      }
    });
  }

  return {
    paymentId: payment.id,
    action: "marked_failed"
  };
}

async function applyStripeEvent(tx: PaymentTransaction, event: Stripe.Event, now: Date) {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return completeCheckoutSession(tx, event, event.data.object as Stripe.Checkout.Session, now);
    case "checkout.session.expired":
      return expireCheckoutSession(tx, event.data.object as Stripe.Checkout.Session);
    case "payment_intent.payment_failed":
      return failPaymentIntent(tx, event.data.object as Stripe.PaymentIntent);
    default:
      return {
        action: "ignored_unhandled_event"
      };
  }
}

export async function processStripeWebhookEvent(
  event: Stripe.Event,
  options: {
    now?: Date;
  } = {}
): Promise<StripeWebhookResult> {
  const now = options.now ?? new Date();

  return runSerializableTransaction(async (tx) => {
    const isNewEvent = await recordEvent(tx, event);

    if (!isNewEvent) {
      return {
        status: "duplicate",
        eventId: event.id
      };
    }

    const result = await applyStripeEvent(tx, event, now);
    await markEventProcessed(tx, event, result.paymentId, now);

    return {
      status: "processed",
      eventId: event.id,
      paymentId: result.paymentId,
      action: result.action
    };
  });
}

function validateCheckoutSession(
  event: Stripe.Event,
  session: Stripe.Checkout.Session,
  payment: Prisma.PaymentGetPayload<{ include: { seatHold: true } }>
) {
  const metadata = session.metadata ?? {};

  const checks = [
    ["live_mode", event.livemode === false],
    [
      "checkout_session",
      !payment.stripeCheckoutSessionId || payment.stripeCheckoutSessionId === session.id
    ],
    ["client_reference", session.client_reference_id === payment.id],
    ["payment_id", metadata[STRIPE_METADATA_KEYS.paymentId] === payment.id],
    ["hold_id", metadata[STRIPE_METADATA_KEYS.holdId] === payment.seatHoldId],
    ["user_id", metadata[STRIPE_METADATA_KEYS.userId] === payment.userId],
    ["amount", typeof session.amount_total !== "number" || session.amount_total === payment.amountCents],
    ["currency", !session.currency || session.currency === payment.currency],
    ["fixed_amount", payment.amountCents === SEAT_RESERVATION_PRICE.unitAmountCents],
    ["fixed_currency", payment.currency === SEAT_RESERVATION_PRICE.currency]
  ] as const;

  const failed = checks.find(([, passed]) => !passed);
  return failed ? { valid: false, reason: failed[0] } : { valid: true, reason: null };
}
