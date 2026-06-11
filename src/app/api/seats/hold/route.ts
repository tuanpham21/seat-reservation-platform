import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRequestUserId, seatApiErrorResponse } from "@/server/seats/api";
import { holdSeat, releaseActiveHold } from "@/server/seats/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createHoldSchema = z.object({
  seatId: z.string().min(1)
});

const releaseHoldSchema = z.object({
  holdId: z.string().min(1).optional()
});

async function readJsonBody(request: NextRequest) {
  return request.json().catch(() => ({}));
}

export async function POST(request: NextRequest) {
  try {
    const userId = await requireRequestUserId(request);
    const body = createHoldSchema.parse(await readJsonBody(request));
    const result = await holdSeat({
      userId,
      seatId: body.seatId
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return seatApiErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const userId = await requireRequestUserId(request);
    const body = releaseHoldSchema.parse(await readJsonBody(request));
    const result = await releaseActiveHold({
      userId,
      holdId: body.holdId
    });

    return NextResponse.json(result);
  } catch (error) {
    return seatApiErrorResponse(error);
  }
}
