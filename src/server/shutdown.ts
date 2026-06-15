type ShutdownSignal = NodeJS.Signals | "manual";

type ShutdownHandler = (signal: ShutdownSignal) => Promise<void> | void;

type ShutdownState = {
  handlers: Map<string, ShutdownHandler>;
  installed: boolean;
  shuttingDown: boolean;
  signal: ShutdownSignal | null;
  completedAt: Date | null;
  shutdownPromise: Promise<void> | null;
};

const globalForShutdown = globalThis as typeof globalThis & {
  __seatReservationShutdownState?: ShutdownState;
};

const shutdownState =
  globalForShutdown.__seatReservationShutdownState ??
  {
    handlers: new Map<string, ShutdownHandler>(),
    installed: false,
    shuttingDown: false,
    signal: null,
    completedAt: null,
    shutdownPromise: null
  };

globalForShutdown.__seatReservationShutdownState = shutdownState;

export function registerShutdownHandler(name: string, handler: ShutdownHandler) {
  shutdownState.handlers.set(name, handler);
}

export function unregisterShutdownHandler(name: string) {
  shutdownState.handlers.delete(name);
}

export function getShutdownSnapshot() {
  return {
    installed: shutdownState.installed,
    shuttingDown: shutdownState.shuttingDown,
    signal: shutdownState.signal,
    handlerCount: shutdownState.handlers.size,
    completedAt: shutdownState.completedAt?.toISOString() ?? null
  };
}

export async function runShutdown(signal: ShutdownSignal = "manual") {
  if (shutdownState.shutdownPromise) {
    return shutdownState.shutdownPromise;
  }

  shutdownState.shuttingDown = true;
  shutdownState.signal = signal;

  shutdownState.shutdownPromise = (async () => {
    for (const [name, handler] of shutdownState.handlers) {
      try {
        await handler(signal);
      } catch (error) {
        console.error(`Shutdown handler failed: ${name}`, error);
      }
    }

    shutdownState.completedAt = new Date();
  })();

  return shutdownState.shutdownPromise;
}

export function installShutdownHooks() {
  if (shutdownState.installed || process.env.NODE_ENV === "test") {
    return;
  }

  shutdownState.installed = true;

  const handleSignal = (signal: NodeJS.Signals) => {
    void runShutdown(signal).finally(() => {
      process.exit(0);
    });
  };

  process.once("SIGTERM", handleSignal);
  process.once("SIGINT", handleSignal);
}
