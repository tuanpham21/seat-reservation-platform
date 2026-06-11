import { Prisma } from "@prisma/client";

export type SeatDomainErrorCode =
  | "UNAUTHENTICATED"
  | "INVALID_REQUEST"
  | "SEAT_NOT_FOUND"
  | "SEAT_UNAVAILABLE"
  | "HOLD_NOT_FOUND"
  | "HOLD_EXPIRED"
  | "RESERVATION_CONFLICT";

const STATUS_BY_CODE: Record<SeatDomainErrorCode, number> = {
  UNAUTHENTICATED: 401,
  INVALID_REQUEST: 400,
  SEAT_NOT_FOUND: 404,
  SEAT_UNAVAILABLE: 409,
  HOLD_NOT_FOUND: 404,
  HOLD_EXPIRED: 409,
  RESERVATION_CONFLICT: 409
};

export class SeatDomainError extends Error {
  readonly code: SeatDomainErrorCode;
  readonly status: number;

  constructor(code: SeatDomainErrorCode, message: string) {
    super(message);
    this.name = "SeatDomainError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

export function isSeatDomainError(error: unknown): error is SeatDomainError {
  return error instanceof SeatDomainError;
}

export function isPrismaUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
