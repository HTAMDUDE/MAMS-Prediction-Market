import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { quoteSchema } from "@/lib/validation";
import { ensureFinalized } from "@/server/finalize";
import { TradeError } from "@/server/services/permissions";
import { quoteTrade } from "@/server/services/trading";

/** Preview a trade without making it. Works logged out (price preview only). */
export async function GET(req: NextRequest) {
  const parsed = quoteSchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "Enter a valid amount." });
  const { market, outcome, action, value } = parsed.data;
  await ensureFinalized();
  const user = await getCurrentUser();
  try {
    const q = await quoteTrade(user?.id ?? null, market, outcome, action, value);
    return NextResponse.json({ ok: true, shares: q.shares, coins: q.coins, avg_price: q.avgPrice, new_price: q.newPrice });
  } catch (e) {
    if (e instanceof TradeError) return NextResponse.json({ ok: false, error: e.message });
    throw e;
  }
}
