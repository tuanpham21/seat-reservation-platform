export const DEFAULT_HOLD_TTL_MS = 10 * 60 * 1000;
export const HOLD_TTL_ENV = "SEAT_HOLD_TTL_SECONDS";

export type SeatAvailabilityStatus = "available" | "held" | "held_by_you" | "reserved" | "disabled";

export function resolveHoldTtlMs(envValue = process.env[HOLD_TTL_ENV]) {
  if (!envValue) {
    return DEFAULT_HOLD_TTL_MS;
  }

  const ttlSeconds = Number(envValue);

  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return DEFAULT_HOLD_TTL_MS;
  }

  return Math.floor(ttlSeconds * 1000);
}

export function getHoldExpiresAt(now: Date, ttlMs = resolveHoldTtlMs()) {
  return new Date(now.getTime() + ttlMs);
}

export function isExpired(expiresAt: Date, now: Date) {
  return expiresAt.getTime() <= now.getTime();
}

export function getSeatAvailabilityStatus(input: {
  isEnabled: boolean;
  hasConfirmedReservation: boolean;
  activeHoldUserId: string | null;
  viewerUserId?: string | null;
}): SeatAvailabilityStatus {
  if (!input.isEnabled) {
    return "disabled";
  }

  if (input.hasConfirmedReservation) {
    return "reserved";
  }

  if (!input.activeHoldUserId) {
    return "available";
  }

  return input.viewerUserId && input.activeHoldUserId === input.viewerUserId ? "held_by_you" : "held";
}
