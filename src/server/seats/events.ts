export type SeatAvailabilityChange = {
  reason:
    | "hold_created"
    | "hold_released"
    | "hold_expired"
    | "payment_hold_released"
    | "reservation_finalized";
};

type SeatAvailabilityListener = (event: SeatAvailabilityChange) => void;

const globalForSeatEvents = globalThis as typeof globalThis & {
  __seatReservationSeatEventListeners?: Set<SeatAvailabilityListener>;
};

const listeners = globalForSeatEvents.__seatReservationSeatEventListeners ?? new Set();

globalForSeatEvents.__seatReservationSeatEventListeners = listeners;

export function publishSeatAvailabilityChanged(event: SeatAvailabilityChange) {
  for (const listener of listeners) {
    listener(event);
  }
}

export function subscribeSeatAvailabilityChanged(listener: SeatAvailabilityListener) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}
