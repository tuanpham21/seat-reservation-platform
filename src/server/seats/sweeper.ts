import { publishSeatAvailabilityChanged } from "./events";
import { resolveHoldTtlMs } from "./policy";
import { expireActiveSeatHolds } from "./service";
import { prisma } from "../prisma";

export type SeatHoldSweeperSnapshot = {
  running: boolean;
  stopped: boolean;
  intervalMs: number;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastExpiredCount: number;
  totalExpiredCount: number;
  lastError: string | null;
};

export type SeatHoldSweeperHandle = {
  kind: "seat-hold-sweeper";
  kick: () => void;
  stop: () => Promise<void>;
  snapshot: () => SeatHoldSweeperSnapshot;
};

export function resolveSeatHoldSweepIntervalMs(ttlMs = resolveHoldTtlMs()) {
  return Math.min(Math.max(Math.floor(ttlMs / 2), 1_000), 30_000);
}

export async function sweepExpiredSeatHoldsOnce(options: { now?: Date } = {}) {
  const now = options.now ?? new Date();
  const expiredCount = await expireActiveSeatHolds(prisma, now);

  if (expiredCount > 0) {
    publishSeatAvailabilityChanged({
      reason: "hold_expired"
    });
  }

  return {
    now,
    expiredCount
  };
}

export function startSeatHoldSweeper(
  options: {
    intervalMs?: number;
  } = {}
): SeatHoldSweeperHandle {
  const intervalMs = options.intervalMs ?? resolveSeatHoldSweepIntervalMs();
  const state: SeatHoldSweeperSnapshot = {
    running: false,
    stopped: false,
    intervalMs,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastExpiredCount: 0,
    totalExpiredCount: 0,
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
      const startedAt = new Date();
      state.lastStartedAt = startedAt.toISOString();

      try {
        const result = await sweepExpiredSeatHoldsOnce({ now: startedAt });
        state.lastExpiredCount = result.expiredCount;
        state.totalExpiredCount += result.expiredCount;
        state.lastError = null;
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : "Unknown sweeper error";
        console.error("Seat hold sweeper failed.", error);
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
    kind: "seat-hold-sweeper",
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
