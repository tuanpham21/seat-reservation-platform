export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      ok: true,
      status: "live"
    },
    {
      headers: {
        "cache-control": "no-store"
      }
    }
  );
}
