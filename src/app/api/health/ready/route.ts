import { getRuntimeReadiness } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const readiness = await getRuntimeReadiness();

  if (readiness.ready) {
    return Response.json(
      {
        ok: true,
        status: "ready"
      },
      {
        headers: {
          "cache-control": "no-store"
        }
      }
    );
  }

  return Response.json(
    {
      ok: false,
      status: "degraded",
      reason: readiness.reason
    },
    {
      status: 503,
      headers: {
        "cache-control": "no-store"
      }
    }
  );
}
