import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { PaymentHttpError } from "../payments/errors";
import { requirePaymentUser } from "../payments/auth";
import { SeatDomainError, isSeatDomainError } from "./errors";

export async function getOptionalRequestUserId(request: Request) {
  try {
    const user = await requirePaymentUser(request);
    return user.id;
  } catch (error) {
    if (error instanceof PaymentHttpError && error.status === 401) {
      return null;
    }

    throw error;
  }
}

export async function requireRequestUserId(request: Request) {
  const user = await requirePaymentUser(request);
  return user.id;
}

export function seatApiErrorResponse(error: unknown) {
  if (isSeatDomainError(error)) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message
        }
      },
      {
        status: error.status
      }
    );
  }

  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: "Request body is invalid.",
          issues: error.issues
        }
      },
      {
        status: 400
      }
    );
  }

  if (error instanceof PaymentHttpError) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          details: error.details
        }
      },
      {
        status: error.status
      }
    );
  }

  console.error(error);

  return NextResponse.json(
    {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Unexpected server error."
      }
    },
    {
      status: 500
    }
  );
}
