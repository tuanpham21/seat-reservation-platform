import {
  startStripeWebhookInboxWorker,
  type StripeWebhookInboxWorkerHandle
} from "./payments/webhook-worker";
import { disconnectPrisma, pingPrisma } from "./prisma";
import { startSeatHoldSweeper, type SeatHoldSweeperHandle } from "./seats/sweeper";
import { getShutdownSnapshot, installShutdownHooks, registerShutdownHandler } from "./shutdown";

type RuntimeWorkerSnapshots = {
  seatHoldSweeper: ReturnType<SeatHoldSweeperHandle["snapshot"]> | null;
  stripeWebhookInbox: ReturnType<StripeWebhookInboxWorkerHandle["snapshot"]> | null;
};

type RuntimeState = {
  startedAt: string | null;
  bootPromise: Promise<void> | null;
  seatHoldSweeper: SeatHoldSweeperHandle | null;
  stripeWebhookInbox: StripeWebhookInboxWorkerHandle | null;
};

const globalForRuntime = globalThis as typeof globalThis & {
  __seatReservationRuntimeState?: RuntimeState;
};

const runtimeState =
  globalForRuntime.__seatReservationRuntimeState ??
  {
    startedAt: null,
    bootPromise: null,
    seatHoldSweeper: null,
    stripeWebhookInbox: null
  };

globalForRuntime.__seatReservationRuntimeState = runtimeState;

function getWorkerSnapshots(): RuntimeWorkerSnapshots {
  return {
    seatHoldSweeper: runtimeState.seatHoldSweeper?.snapshot() ?? null,
    stripeWebhookInbox: runtimeState.stripeWebhookInbox?.snapshot() ?? null
  };
}

export function getRuntimeSnapshot() {
  return {
    startedAt: runtimeState.startedAt,
    shutdown: getShutdownSnapshot(),
    workers: getWorkerSnapshots()
  };
}

export function bootServerRuntime() {
  if (runtimeState.bootPromise) {
    return runtimeState.bootPromise;
  }

  runtimeState.bootPromise = (async () => {
    if (runtimeState.startedAt) {
      return;
    }

    runtimeState.startedAt = new Date().toISOString();

    installShutdownHooks();

    runtimeState.seatHoldSweeper ??= startSeatHoldSweeper();
    runtimeState.stripeWebhookInbox ??= startStripeWebhookInboxWorker();

    registerShutdownHandler("seat-hold-sweeper", async () => {
      await runtimeState.seatHoldSweeper?.stop();
    });

    registerShutdownHandler("stripe-webhook-inbox", async () => {
      await runtimeState.stripeWebhookInbox?.stop();
    });

    registerShutdownHandler("prisma", async () => {
      await disconnectPrisma();
    });
  })();

  return runtimeState.bootPromise;
}

export function notifyStripeWebhookEnqueued() {
  void bootServerRuntime().then(() => {
    runtimeState.stripeWebhookInbox?.kick();
  });
}

export async function getRuntimeReadiness() {
  await bootServerRuntime();

  const snapshot = getRuntimeSnapshot();
  const workerErrors = Object.entries(snapshot.workers)
    .filter(([, worker]) => worker?.lastError)
    .map(([name, worker]) => ({
      name,
      error: worker?.lastError ?? null
    }));

  if (snapshot.shutdown.shuttingDown) {
    return {
      ready: false,
      reason: "shutting_down",
      snapshot
    };
  }

  if (workerErrors.length > 0) {
    return {
      ready: false,
      reason: "worker_error",
      workerErrors,
      snapshot
    };
  }

  try {
    await pingPrisma();

    return {
      ready: true,
      snapshot
    };
  } catch (error) {
    return {
      ready: false,
      reason: "database_unavailable",
      error: error instanceof Error ? error.message : "Unknown database error",
      snapshot
    };
  }
}
