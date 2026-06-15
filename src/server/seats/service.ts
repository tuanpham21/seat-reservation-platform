import { PrismaClient, ReservationStatus, SeatHoldStatus } from "@prisma/client";
import { SeatDomainError, isPrismaUniqueConstraintError } from "./errors";
import { publishSeatAvailabilityChanged } from "./events";
import { getHoldExpiresAt, getSeatAvailabilityStatus, resolveHoldTtlMs } from "./policy";
import { prisma } from "../prisma";
import { runSerializableTransaction } from "../transactions";

type SeatDb = Pick<PrismaClient, "seat" | "seatHold" | "reservation">;

export type SeatAvailability = {
  id: string;
  label: string;
  sortOrder: number;
  status: ReturnType<typeof getSeatAvailabilityStatus>;
  hold: {
    id: string;
    expiresAt: Date;
  } | null;
};

export type SeatHoldResult = {
  hold: {
    id: string;
    seatId: string;
    userId: string;
    status: typeof SeatHoldStatus.active;
    expiresAt: Date;
  };
  seat: {
    id: string;
    label: string;
    sortOrder: number;
  };
  replacedHoldId: string | null;
};

export async function expireActiveSeatHolds(db: SeatDb = prisma, now = new Date()) {
  const result = await db.seatHold.updateMany({
    where: {
      status: SeatHoldStatus.active,
      expiresAt: {
        lte: now
      }
    },
    data: {
      status: SeatHoldStatus.expired
    }
  });

  return result.count;
}

export async function listSeatAvailability(input: {
  viewerUserId?: string | null;
  now?: Date;
} = {}) {
  const now = input.now ?? new Date();

  return runSerializableTransaction(async (tx) => {
    await expireActiveSeatHolds(tx, now);

    const seats = await tx.seat.findMany({
      orderBy: {
        sortOrder: "asc"
      },
      include: {
        holds: {
          where: {
            status: SeatHoldStatus.active
          },
          select: {
            id: true,
            userId: true,
            expiresAt: true
          },
          take: 1
        },
        reservations: {
          where: {
            status: ReservationStatus.confirmed
          },
          select: {
            id: true
          },
          take: 1
        }
      }
    });

    return seats.map<SeatAvailability>((seat) => {
      const activeHold = seat.holds[0] ?? null;
      const heldByViewer = Boolean(
        activeHold && input.viewerUserId && activeHold.userId === input.viewerUserId
      );

      return {
        id: seat.id,
        label: seat.label,
        sortOrder: seat.sortOrder,
        status: getSeatAvailabilityStatus({
          isEnabled: seat.isEnabled,
          hasConfirmedReservation: seat.reservations.length > 0,
          activeHoldUserId: activeHold?.userId ?? null,
          viewerUserId: input.viewerUserId
        }),
        hold: heldByViewer
          ? {
              id: activeHold!.id,
              expiresAt: activeHold!.expiresAt
            }
          : null
      };
    });
  });
}

export async function holdSeat(input: {
  seatId: string;
  userId: string;
  now?: Date;
  ttlMs?: number;
}) {
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? resolveHoldTtlMs();

  try {
    const outcome = await runSerializableTransaction(async (tx) => {
      await expireActiveSeatHolds(tx, now);

      const seat = await tx.seat.findUnique({
        where: {
          id: input.seatId
        },
        select: {
          id: true,
          label: true,
          sortOrder: true,
          isEnabled: true
        }
      });

      if (!seat) {
        throw new SeatDomainError("SEAT_NOT_FOUND", "Seat does not exist.");
      }

      if (!seat.isEnabled) {
        throw new SeatDomainError("SEAT_UNAVAILABLE", "Seat is not available.");
      }

      const confirmedReservation = await tx.reservation.findFirst({
        where: {
          seatId: seat.id,
          status: ReservationStatus.confirmed
        },
        select: {
          id: true
        }
      });

      if (confirmedReservation) {
        throw new SeatDomainError("SEAT_UNAVAILABLE", "Seat already has a confirmed reservation.");
      }

      const existingUserHold = await tx.seatHold.findFirst({
        where: {
          userId: input.userId,
          status: SeatHoldStatus.active
        },
        select: {
          id: true,
          seatId: true,
          expiresAt: true
        }
      });

      if (existingUserHold?.seatId === seat.id) {
        return {
          changed: false,
          result: {
            hold: {
              id: existingUserHold.id,
              seatId: seat.id,
              userId: input.userId,
              status: SeatHoldStatus.active,
              expiresAt: existingUserHold.expiresAt
            },
            seat,
            replacedHoldId: null
          }
        };
      }

      let replacedHoldId: string | null = null;

      if (existingUserHold) {
        await tx.seatHold.update({
          where: {
            id: existingUserHold.id
          },
          data: {
            status: SeatHoldStatus.released,
            releasedAt: now
          }
        });
        replacedHoldId = existingUserHold.id;
      }

      const hold = await tx.seatHold.create({
        data: {
          seatId: seat.id,
          userId: input.userId,
          status: SeatHoldStatus.active,
          expiresAt: getHoldExpiresAt(now, ttlMs)
        },
        select: {
          id: true,
          seatId: true,
          userId: true,
          status: true,
          expiresAt: true
        }
      });

      return {
        changed: true,
        result: {
          hold: {
            id: hold.id,
            seatId: hold.seatId,
            userId: hold.userId,
            status: SeatHoldStatus.active,
            expiresAt: hold.expiresAt
          },
          seat,
          replacedHoldId
        }
      };
    });

    if (outcome.changed) {
      publishSeatAvailabilityChanged({
        reason: "hold_created"
      });
    }

    return outcome.result;
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      throw new SeatDomainError("SEAT_UNAVAILABLE", "Seat or user already has an active hold.");
    }

    throw error;
  }
}

export async function releaseActiveHold(input: {
  userId: string;
  holdId?: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();

  const result = await runSerializableTransaction(async (tx) => {
    await expireActiveSeatHolds(tx, now);

    const released = await tx.seatHold.updateMany({
      where: {
        id: input.holdId,
        userId: input.userId,
        status: SeatHoldStatus.active
      },
      data: {
        status: SeatHoldStatus.released,
        releasedAt: now
      }
    });

    return {
      released: released.count > 0
    };
  });

  if (result.released) {
    publishSeatAvailabilityChanged({
      reason: "hold_released"
    });
  }

  return result;
}
