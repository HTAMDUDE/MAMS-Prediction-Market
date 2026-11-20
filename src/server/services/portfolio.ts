import { prisma, type Db } from "@/lib/db";
import * as lmsr from "@/lib/lmsr";
import { bundles, type Bundle } from "./markets";

/**
 * {userId → {marketId → cash-out value}} for every unresolved market. Each value is what the user's whole holding in
 * that market would sell for right now, so buying can't inflate it.
 */
export async function openBookValues(db: Db = prisma): Promise<Map<string, Map<number, number>>> {
  const markets = await db.market.findMany({ where: { status: "open" }, include: { outcomes: { orderBy: { position: "asc" } } } });
  const byId = new Map(markets.map((m) => [m.id, m]));
  const positions = await db.position.findMany({
    where: { shares: { gt: 0 }, outcome: { market: { status: "open" } } },
    include: { outcome: { select: { marketId: true } } },
  });
  const holdings = new Map<string, number[]>(); // `${userId}:${marketId}` → share vector
  for (const p of positions) {
    const m = byId.get(p.outcome.marketId);
    if (!m) continue;
    const key = `${p.userId}:${m.id}`;
    const vec = holdings.get(key) ?? new Array<number>(m.outcomes.length).fill(0);
    vec[m.outcomes.findIndex((o) => o.id === p.outcomeId)] = p.shares;
    holdings.set(key, vec);
  }
  const result = new Map<string, Map<number, number>>();
  for (const [key, h] of holdings) {
    const [userId, marketIdStr] = key.split(":");
    const m = byId.get(Number(marketIdStr))!;
    const value = lmsr.liquidationValue(m.outcomes.map((o) => o.shares), m.b, h);
    if (!result.has(userId)) result.set(userId, new Map());
    result.get(userId)!.set(m.id, value);
  }
  return result;
}

export async function netWorths(db: Db = prisma): Promise<Map<string, number>> {
  const users = await db.user.findMany({ select: { id: true, balance: true } });
  const worth = new Map(users.map((u) => [u.id, u.balance]));
  for (const [userId, perMarket] of await openBookValues(db)) {
    let sum = 0;
    for (const v of perMarket.values()) sum += v;
    worth.set(userId, (worth.get(userId) ?? 0) + sum);
  }
  return worth;
}

export async function getLeaderboard(currentUserId: string | null) {
  const [worth, users, counts] = await Promise.all([
    netWorths(),
    prisma.user.findMany({ select: { id: true, username: true, displayUsername: true, balance: true } }),
    prisma.trade.groupBy({ by: ["userId"], _count: { _all: true } }),
  ]);
  const tradeCount = new Map(counts.map((c) => [c.userId, c._count._all]));
  return users
    .map((u) => ({
      username: u.displayUsername ?? u.username ?? "?",
      worth: worth.get(u.id) ?? u.balance,
      balance: u.balance,
      trades: tradeCount.get(u.id) ?? 0,
      isMe: u.id === currentUserId,
    }))
    .sort((a, b) => b.worth - a.worth);
}

export type PortfolioItem = {
  marketId: number;
  question: string;
  label: string;
  shares: number;
  cost: number;
  price: number;
  value: number;
  bundle: Bundle;
  /** For cancelled markets: what this user actually got back (their net spend, never negative). */
  refund: number;
};

export async function getPortfolio(userId: string) {
  const rows = await prisma.position.findMany({
    where: { userId },
    include: { outcome: { include: { market: true } } },
    orderBy: { outcome: { market: { closesAt: "asc" } } },
  });
  const marketList = [...new Map(rows.map((r) => [r.outcome.market.id, r.outcome.market])).values()];
  const bs = new Map((await bundles(prisma, marketList)).map((b) => [b.m.id, b]));
  const cancelledIds = marketList.filter((m) => m.status === "cancelled").map((m) => m.id);
  const refunds = new Map(
    (cancelledIds.length
      ? await prisma.trade.groupBy({ by: ["marketId"], where: { userId, marketId: { in: cancelledIds } }, _sum: { amount: true } })
      : []
    ).map((g) => [g.marketId, Math.max(g._sum.amount ?? 0, 0)]),
  );
  const active: PortfolioItem[] = [];
  const settled: PortfolioItem[] = [];
  for (const r of rows) {
    const b = bs.get(r.outcome.marketId)!;
    const i = b.outcomes.findIndex((o) => o.id === r.outcomeId);
    const price = b.outcomes[i].price;
    let value: number;
    if (b.m.status === "open") value = lmsr.sellValue(b.outcomes.map((o) => o.shares), b.m.b, i, r.shares); // what the shares would sell for now
    else if (b.m.status === "cancelled") value = 0; // refunded when the market was cancelled
    else value = r.shares * price;
    const item = { marketId: b.m.id, question: b.m.question, label: r.outcome.label, shares: r.shares, cost: r.cost, price, value, bundle: b, refund: refunds.get(b.m.id) ?? 0 };
    (b.m.status === "open" ? active : settled).push(item);
  }
  settled.sort((a, c) => (c.bundle.m.resolvedAt?.getTime() ?? 0) - (a.bundle.m.resolvedAt?.getTime() ?? 0)); // newest result first
  const trades = await prisma.trade.findMany({
    where: { userId }, orderBy: { id: "desc" }, take: 30,
    include: { outcome: { select: { label: true } }, market: { select: { question: true } } },
  });
  const [worths, books, me] = await Promise.all([netWorths(), openBookValues(), prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { balance: true } })]);
  // Joint per-market value, so the KPI matches net worth even when someone holds several outcomes of a market.
  let invested = 0;
  for (const v of books.get(userId)?.values() ?? []) invested += v;
  return {
    active, settled, trades, worth: worths.get(userId) ?? me.balance, balance: me.balance, invested,
    rowsTotal: active.reduce((a, i) => a + i.value, 0),
  };
}
