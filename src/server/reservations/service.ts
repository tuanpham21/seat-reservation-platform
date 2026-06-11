import { ReservationStatus, SeatHoldStatus } from "@prisma/client";
import {
  SeatDomainError,
  isPrismaUniqueConstraintError
} from "../seats/errors";
import { prisma } from "../prisma";
import { expireActiveSeatHolds } from "../seats/service";
import { runSerializableTransaction } from "../transactions";

export async function confirmReservationFromHold(input: {
  holdId: string;
  userId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();

  try {
    return await runSerializableTransaction(async (tx) => {
      await expireActiveSeatHolds(tx, now);

      const hold = await tx.seatHold.findUnique({
        where: {
          id: input.holdId
        },
        select: {
          id: true,
          seatId: true,
          userId: true,
          status: true,
          expiresAt: true
        }
      });

      if (!hold || hold.userId !== input.userId) {
        throw new SeatDomainError("HOLD_NOT_FOUND", "Seat hold does not exist.");
      }

      if (hold.status !== SeatHoldStatus.active) {
        throw new SeatDomainError("HOLD_EXPIRED", "Seat hold is no longer active.");
      }

      const confirmedReservation = await tx.reservation.findFirst({
        where: {
          seatId: hold.seatId,
          status: ReservationStatus.confirmed
        },
        select: {
          id: true
        }
      });

      if (confirmedReservation) {
        throw new SeatDomainError("RESERVATION_CONFLICT", "Seat already has a confirmed reservation.");
      }

      await tx.seatHold.update({
        where: {
          id: hold.id
        },
        data: {
          status: SeatHoldStatus.converted,
          convertedAt: now
        }
      });

      return tx.reservation.create({
        data: {
          seatId: hold.seatId,
          userId: hold.userId,
          seatHoldId: hold.id,
          status: ReservationStatus.confirmed,
          confirmedAt: now
        }
      });
    });
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      throw new SeatDomainError("RESERVATION_CONFLICT", "Reservation conflicts with existing state.");
    }

    throw error;
  }
}

export async function cancelReservation(input: {
  reservationId: string;
  userId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();

  const result = await prisma.reservation.updateMany({
    where: {
      id: input.reservationId,
      userId: input.userId,
      status: ReservationStatus.confirmed
    },
    data: {
      status: ReservationStatus.cancelled,
      cancelledAt: now
    }
  });

  return {
    cancelled: result.count > 0
  };
}
