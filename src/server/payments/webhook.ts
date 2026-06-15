import { PaymentStatus, Prisma, ReservationStatus, SeatHoldStatus } from "@prisma/client";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import type Stripe from "stripe";

import { getPaymentIdFromMetadata, STRIPE_METADATA_KEYS } from "./metadata";
import { prisma } from "../prisma";
import { publishSeatAvailabilityChanged } from "../seats/events";
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

export type EnqueueStripeWebhookResult = {
  status: "accepted" | "duplicate";
  eventId: string;
  paymentId?: string;
};

export type StripeWebhookInboxDrainResult = {
  processedCount: number;
  lastEventId: string | null;
};

export type StripeWebhookInboxWorkerSnapshot = {
  running: boolean;
  stopped: boolean;
  intervalMs: number;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastProcessedCount: number;
  totalProcessedCount: number;
  lastEventId: string | null;
  lastError: string | null;
};

export type StripeWebhookInboxWorkerHandle = {
  kind: "stripe-webhook-inbox";
  kick: () => void;
  stop: () => Promise<void>;
  snapshot: () => StripeWebhookInboxWorkerSnapshot;
};

type PendingStripeEventRecord = {
  stripeEventId: string;
  paymentId: string | null;
  payload: Prisma.JsonValue;
};

const SEAT_ALREADY_RESERVED_REVIEW_REASON = "seat_already_reserved_at_payment_confirmation";
const STRIPE_VALIDATION_REVIEW_REASON = "stripe_checkout_validation_mismatch";
const SEAT_AVAILABILITY_CHANGE_ACTIONS = new Set([
  "marked_expired_and_released_hold",
  "marked_failed_and_released_hold",
  "reservation_finalized"
]);

function isUniqueConstraintError(error: unknown) {
  return error instanceof PrismaClientKnownRequestError && error.code === "P2002";
}

function publishSeatAvailabilityChangeForAction(action?: string) {
  if (!action || !SEAT_AVAILABILITY_CHANGE_ACTIONS.has(action)) {
    return;
  }

  publishSeatAvailabilityChanged({
    reason: action === "reservation_finalized" ? "reservation_finalized" : "payment_hold_released"
  });
}

function paymentIntentIdFromSession(session: Stripe.Checkout.Session) {
  if (typeof session.payment_intent === "string") {
    return session.payment_intent;
  }

  return session.payment_intent?.id ?? null;
}

function getPaymentIdFromStripeEvent(event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.expired":
      return getPaymentIdFromMetadata((event.data.object as Stripe.Checkout.Session).metadata);
    case "payment_intent.payment_failed":
      return getPaymentIdFromMetadata((event.data.object as Stripe.PaymentIntent).metadata);
    default:
      return null;
  }
}

async function recordEvent(
  tx: PaymentTransaction,
  event: Stripe.Event,
  paymentId = getPaymentIdFromStripeEvent(event)
) {
  try {
    await tx.paymentEvent.create({
      data: {
        stripeEventId: event.id,
        eventType: event.type,
        paymentId: paymentId ?? undefined,
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

async function releaseActiveHoldForPayment(
  tx: PaymentTransaction,
  payment: {
    seatHoldId: string;
    userId: string;
  },
  now: Date
) {
  const released = await tx.seatHold.updateMany({
    where: {
      id: payment.seatHoldId,
      userId: payment.userId,
      status: SeatHoldStatus.active
    },
    data: {
      status: SeatHoldStatus.released,
      releasedAt: now
    }
  });

  return released.count > 0;
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

async function expireCheckoutSession(
  tx: PaymentTransaction,
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
    select: {
      id: true,
      seatHoldId: true,
      userId: true,
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
    await releaseActiveHoldForPayment(tx, payment, now);
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

    return {
      paymentId: payment.id,
      action: "marked_expired_and_released_hold"
    };
  }

  return {
    paymentId: payment.id,
    action: "marked_expired"
  };
}

async function failPaymentIntent(
  tx: PaymentTransaction,
  paymentIntent: Stripe.PaymentIntent,
  now: Date
) {
  const paymentId = getPaymentIdFromMetadata(paymentIntent.metadata);

  const payment = paymentId
    ? await tx.payment.findUnique({
        where: {
          id: paymentId
        },
        select: {
          id: true,
          seatHoldId: true,
          userId: true,
          status: true
        }
      })
    : await tx.payment.findUnique({
        where: {
          stripePaymentIntentId: paymentIntent.id
        },
        select: {
          id: true,
          seatHoldId: true,
          userId: true,
          status: true
        }
      });

  if (!payment) {
    return {
      paymentId: paymentId ?? undefined,
      action: "ignored_unknown_payment"
    };
  }

  if (!PAYMENT_TERMINAL_STATES.has(payment.status)) {
    await releaseActiveHoldForPayment(tx, payment, now);
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

    return {
      paymentId: payment.id,
      action: "marked_failed_and_released_hold"
    };
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
      return expireCheckoutSession(tx, event.data.object as Stripe.Checkout.Session, now);
    case "payment_intent.payment_failed":
      return failPaymentIntent(tx, event.data.object as Stripe.PaymentIntent, now);
    default:
      return {
        action: "ignored_unhandled_event"
      };
  }
}

async function claimNextPendingStripeEvent(tx: PaymentTransaction) {
  const rows = await tx.$queryRaw<PendingStripeEventRecord[]>(Prisma.sql`
    SELECT
      id AS "stripeEventId",
      payment_id AS "paymentId",
      payload
    FROM payment_events
    WHERE processed_at IS NULL
    ORDER BY created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  `);

  return rows[0] ?? null;
}

async function processClaimedStripeEvent(
  tx: PaymentTransaction,
  record: PendingStripeEventRecord,
  now: Date
) {
  const event = record.payload as unknown as Stripe.Event;
  const result = await applyStripeEvent(tx, event, now);
  await markEventProcessed(tx, event, result.paymentId ?? record.paymentId ?? undefined, now);

  return {
    eventId: record.stripeEventId,
    paymentId: result.paymentId,
    action: result.action
  };
}

export async function enqueueStripeWebhookEvent(
  event: Stripe.Event
): Promise<EnqueueStripeWebhookResult> {
  const paymentId = getPaymentIdFromStripeEvent(event);

  return runSerializableTransaction(async (tx) => {
    const isNewEvent = await recordEvent(tx, event, paymentId);

    return {
      status: isNewEvent ? "accepted" : "duplicate",
      eventId: event.id,
      paymentId: paymentId ?? undefined
    };
  });
}

export async function processStripeWebhookEvent(
  event: Stripe.Event,
  options: {
    now?: Date;
  } = {}
): Promise<StripeWebhookResult> {
  const now = options.now ?? new Date();
  const paymentId = getPaymentIdFromStripeEvent(event);

  const result: StripeWebhookResult = await runSerializableTransaction(async (tx) => {
    const isNewEvent = await recordEvent(tx, event, paymentId);

    if (!isNewEvent) {
      return {
        status: "duplicate",
        eventId: event.id,
        paymentId: paymentId ?? undefined
      };
    }

    const result = await applyStripeEvent(tx, event, now);
    await markEventProcessed(tx, event, result.paymentId ?? paymentId ?? undefined, now);

    return {
      status: "processed",
      eventId: event.id,
      paymentId: result.paymentId,
      action: result.action
    };
  });

  publishSeatAvailabilityChangeForAction(result.action);

  return result;
}

export async function processQueuedStripeWebhookEvent(
  stripeEventId: string,
  options: {
    now?: Date;
  } = {}
): Promise<StripeWebhookResult> {
  const now = options.now ?? new Date();

  const result: StripeWebhookResult = await runSerializableTransaction(async (tx) => {
    const record = await tx.paymentEvent.findUnique({
      where: {
        stripeEventId
      },
      select: {
        stripeEventId: true,
        payload: true,
        processedAt: true,
        paymentId: true
      }
    });

    if (!record || record.processedAt) {
      return {
        status: "duplicate",
        eventId: stripeEventId,
        paymentId: record?.paymentId ?? undefined
      };
    }

    const result = await processClaimedStripeEvent(
      tx,
      {
        stripeEventId: record.stripeEventId,
        paymentId: record.paymentId,
        payload: record.payload
      },
      now
    );

    return {
      status: "processed",
      eventId: stripeEventId,
      paymentId: result.paymentId,
      action: result.action
    };
  });

  publishSeatAvailabilityChangeForAction(result.action);

  return result;
}

export async function drainPendingStripeWebhookEvents(
  options: {
    maxEvents?: number;
  } = {}
): Promise<StripeWebhookInboxDrainResult> {
  const maxEvents = options.maxEvents ?? 25;
  let processedCount = 0;
  let lastEventId: string | null = null;

  while (processedCount < maxEvents) {
    const result = await runSerializableTransaction(async (tx) => {
      const record = await claimNextPendingStripeEvent(tx);

      if (!record) {
        return null;
      }

      return processClaimedStripeEvent(tx, record, new Date());
    });

    if (!result) {
      break;
    }

    publishSeatAvailabilityChangeForAction(result.action);
    processedCount += 1;
    lastEventId = result.eventId;
  }

  return {
    processedCount,
    lastEventId
  };
}

export function startStripeWebhookInboxWorker(
  options: {
    intervalMs?: number;
    maxEventsPerRun?: number;
  } = {}
): StripeWebhookInboxWorkerHandle {
  const intervalMs = options.intervalMs ?? 1_000;
  const maxEventsPerRun = options.maxEventsPerRun ?? 25;
  const state: StripeWebhookInboxWorkerSnapshot = {
    running: false,
    stopped: false,
    intervalMs,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastProcessedCount: 0,
    totalProcessedCount: 0,
    lastEventId: null,
    lastError: null
  };

  let timer: NodeJS.Timeout | null = null;
  let runningPromise: Promise<void> | null = null;
  let rerunImmediately = false;

  const schedule = (delayMs: number) => {
    if (state.stopped) {
      return;
    }

    if (runningPromise) {
      rerunImmediately = true;
      return;
    }

    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delayMs);
  };

  const run = async () => {
    if (state.stopped || runningPromise) {
      return runningPromise ?? Promise.resolve();
    }

    runningPromise = (async () => {
      state.running = true;
      state.lastStartedAt = new Date().toISOString();

      try {
        const result = await drainPendingStripeWebhookEvents({
          maxEvents: maxEventsPerRun
        });

        state.lastProcessedCount = result.processedCount;
        state.totalProcessedCount += result.processedCount;
        state.lastEventId = result.lastEventId;
        state.lastError = null;

        if (result.processedCount === maxEventsPerRun) {
          rerunImmediately = true;
        }
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : "Unknown webhook worker error";
        console.error("Stripe webhook inbox worker failed.", error);
      } finally {
        state.running = false;
        state.lastCompletedAt = new Date().toISOString();
        runningPromise = null;

        if (!state.stopped) {
          const nextDelay = rerunImmediately ? 0 : intervalMs;
          rerunImmediately = false;
          schedule(nextDelay);
        }
      }
    })();

    return runningPromise;
  };

  schedule(0);

  return {
    kind: "stripe-webhook-inbox",
    kick() {
      schedule(0);
    },
    async stop() {
      state.stopped = true;

      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      await runningPromise;
    },
    snapshot() {
      return { ...state };
    }
  };
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
