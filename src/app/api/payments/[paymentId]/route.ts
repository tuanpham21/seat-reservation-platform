import { requirePaymentUser } from "@/server/payments/auth";
import { toPaymentErrorResponse } from "@/server/payments/errors";
import { getPaymentStatus } from "@/server/payments/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: {
    params: {
      paymentId: string;
    };
  }
) {
  try {
    const user = await requirePaymentUser(request);
    const status = await getPaymentStatus(context.params.paymentId, user.id);

    return Response.json(status);
  } catch (error) {
    return toPaymentErrorResponse(error);
  }
}
