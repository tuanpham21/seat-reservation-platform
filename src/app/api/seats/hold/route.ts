import { NextResponse, type NextRequest } from "next/server";
import { bootServerRuntime } from "@/server/runtime";
import { checkRateLimit } from "@/server/auth/rate-limit";
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

function seatRateLimitedResponse(retryAfterMs: number) {
  return NextResponse.json(
    {
      error: {
        code: "RATE_LIMITED",
        message: "Too many seat changes. Try again shortly."
      }
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1_000)))
      }
    }
  );
}

export async function POST(request: NextRequest) {
  try {
    await bootServerRuntime();
    const userId = await requireRequestUserId(request);
    const rateLimit = checkRateLimit(`seat-hold:${userId}`, {
      limit: 30,
      windowMs: 60_000
    });
    if (!rateLimit.allowed) {
      return seatRateLimitedResponse(rateLimit.retryAfterMs);
    }
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
    await bootServerRuntime();
    const userId = await requireRequestUserId(request);
    const rateLimit = checkRateLimit(`seat-hold:${userId}`, {
      limit: 30,
      windowMs: 60_000
    });
    if (!rateLimit.allowed) {
      return seatRateLimitedResponse(rateLimit.retryAfterMs);
    }
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
