import type { NextRequest } from "next/server";
import { bootServerRuntime } from "@/server/runtime";
import { getOptionalRequestUserId, seatApiErrorResponse } from "@/server/seats/api";
import { subscribeSeatAvailabilityChanged } from "@/server/seats/events";
import { listSeatAvailability } from "@/server/seats/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
const HEARTBEAT_MS = 15_000;

function encodeSseChunk(event: string, payload: unknown) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export async function GET(request: NextRequest) {
  try {
    await bootServerRuntime();
    const viewerUserId = await getOptionalRequestUserId(request);

    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        let heartbeat: NodeJS.Timeout | null = null;
        let sendSnapshotPromise: Promise<void> | null = null;
        let rerunSnapshot = false;

        const close = () => {
          if (closed) {
            return;
          }

          closed = true;

          if (heartbeat) {
            clearInterval(heartbeat);
            heartbeat = null;
          }

          unsubscribe();
          controller.close();
        };

        const sendSnapshot = () => {
          if (closed) {
            return Promise.resolve();
          }

          if (sendSnapshotPromise) {
            rerunSnapshot = true;
            return sendSnapshotPromise ?? Promise.resolve();
          }

          sendSnapshotPromise = (async () => {
            const seats = await listSeatAvailability({ viewerUserId });

            if (!closed) {
              controller.enqueue(
                encodeSseChunk("snapshot", {
                  type: "snapshot",
                  seats
                })
              );
            }
          })()
            .catch(() => {
              close();
            })
            .finally(() => {
              sendSnapshotPromise = null;
              if (!closed && rerunSnapshot) {
                rerunSnapshot = false;
                void sendSnapshot();
              }
            });

          return sendSnapshotPromise;
        };

        const unsubscribe = subscribeSeatAvailabilityChanged(() => {
          void sendSnapshot();
        });

        request.signal.addEventListener("abort", close);

        heartbeat = setInterval(() => {
          if (!closed) {
            controller.enqueue(encodeSseChunk("heartbeat", { ok: true }));
          }
        }, HEARTBEAT_MS);

        await sendSnapshot();
      }
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-store",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream"
      }
    });
  } catch (error) {
    return seatApiErrorResponse(error);
  }
}
