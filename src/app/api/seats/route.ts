import { NextResponse, type NextRequest } from "next/server";
import { bootServerRuntime } from "@/server/runtime";
import { getOptionalRequestUserId, seatApiErrorResponse } from "@/server/seats/api";
import { listSeatAvailability } from "@/server/seats/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await bootServerRuntime();
    const viewerUserId = await getOptionalRequestUserId(request);
    const seats = await listSeatAvailability({ viewerUserId });

    return NextResponse.json(
      { seats },
      {
        headers: {
          "Cache-Control": "no-store",
          Vary: "Authorization"
        }
      }
    );
  } catch (error) {
    return seatApiErrorResponse(error);
  }
}
