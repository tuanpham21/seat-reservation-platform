export class PaymentHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "PaymentHttpError";
  }
}

export function toPaymentErrorResponse(error: unknown): Response {
  if (error instanceof PaymentHttpError) {
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          details: error.details
        }
      },
      { status: error.status }
    );
  }

  console.error(error);

  return Response.json(
    {
      error: {
        code: "payment_internal_error",
        message: "Unable to process payment request."
      }
    },
    { status: 500 }
  );
}
