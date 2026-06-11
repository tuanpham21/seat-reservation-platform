import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOLD_TTL_MS,
  getHoldExpiresAt,
  getSeatAvailabilityStatus,
  isExpired,
  resolveHoldTtlMs
} from "./policy";

describe("seat hold policy", () => {
  it("defaults holds to 10 minutes", () => {
    expect(resolveHoldTtlMs(undefined)).toBe(DEFAULT_HOLD_TTL_MS);
  });

  it("uses a positive SEAT_HOLD_TTL_SECONDS value", () => {
    expect(resolveHoldTtlMs("30")).toBe(30_000);
  });

  it("falls back to the default for invalid TTL values", () => {
    expect(resolveHoldTtlMs("0")).toBe(DEFAULT_HOLD_TTL_MS);
    expect(resolveHoldTtlMs("-5")).toBe(DEFAULT_HOLD_TTL_MS);
    expect(resolveHoldTtlMs("not-a-number")).toBe(DEFAULT_HOLD_TTL_MS);
  });

  it("calculates and compares hold expiration inclusively", () => {
    const now = new Date("2026-06-11T00:00:00.000Z");
    const expiresAt = getHoldExpiresAt(now, 60_000);

    expect(expiresAt.toISOString()).toBe("2026-06-11T00:01:00.000Z");
    expect(isExpired(expiresAt, new Date("2026-06-11T00:00:59.999Z"))).toBe(false);
    expect(isExpired(expiresAt, new Date("2026-06-11T00:01:00.000Z"))).toBe(true);
  });
});

describe("seat availability policy", () => {
  it("marks seats by confirmed reservation before holds", () => {
    expect(
      getSeatAvailabilityStatus({
        isEnabled: true,
        hasConfirmedReservation: true,
        activeHoldUserId: "user-1",
        viewerUserId: "user-1"
      })
    ).toBe("reserved");
  });

  it("identifies the viewer's own active hold", () => {
    expect(
      getSeatAvailabilityStatus({
        isEnabled: true,
        hasConfirmedReservation: false,
        activeHoldUserId: "user-1",
        viewerUserId: "user-1"
      })
    ).toBe("held_by_you");
  });

  it("does not expose another user's hold as the viewer's hold", () => {
    expect(
      getSeatAvailabilityStatus({
        isEnabled: true,
        hasConfirmedReservation: false,
        activeHoldUserId: "user-2",
        viewerUserId: "user-1"
      })
    ).toBe("held");
  });
});
