import { NextResponse, type NextRequest } from "next/server";
import { finalizeDue } from "@/server/services/resolution";

// Backup for the finalize-on-page-load behaviour: Vercel Cron calls this daily (see vercel.json).
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ finalized: await finalizeDue() });
}
