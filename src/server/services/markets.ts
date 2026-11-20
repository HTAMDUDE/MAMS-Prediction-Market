import { Prisma, type Market } from "@/generated/prisma/client";
import { marketB, isPreset } from "@/lib/constants";
import { prisma, type Db } from "@/lib/db";
import * as lmsr from "@/lib/lmsr";
import { adjustBalance, assertAdmin, lockMarket, TradeError, type Actor } from "./permissions";

export type MarketState = "open" | "closed" | "proposed" | "disputed" | "resolved" | "cancelled";

/**
 * open | closed (past close date, awaiting a proposed result) | proposed (result proposed, challenge window running)
 * | resolved | cancelled. `bundles` upgrades proposed to disputed when a challenge is waiting.
 */
export function marketState(m: Pick<Market, "status" | "proposedOutcomeId" | "closesAt">, now = new Date()): MarketState {
  if (m.status === "resolved" || m.status === "cancelled") return m.status;
  if (m.proposedOutcomeId !== null) return "proposed";
  return now >= m.closesAt ? "closed" : "open";
}

export const isBinary = (labels: string[]) => labels.length === 2 && labels[0].toLowerCase() === "yes" && labels[1].toLowerCase() === "no";

export type OutcomeView = { id: number; label: string; shares: number; price: number };
export type Bundle = {
  m: Market;
  state: MarketState;
  binary: boolean;
  outcomes: OutcomeView[];
  volume: number;
  traders: number;
};

/** Markets plus their outcomes, current prices and trade stats, loaded in four queries however many markets there are. */
export async function bundles(db: Db, markets: Market[]): Promise<Bundle[]> {
  if (markets.length === 0) return [];
  const ids = markets.map((m) => m.id);
  const [outs, stats, disputed] = await Promise.all([
    db.outcome.findMany({ where: { marketId: { in: ids } }, orderBy: { position: "asc" } }),
    db.$queryRaw<{ marketId: number; volume: number; traders: bigint }[]>`
      SELECT "marketId", COALESCE(SUM(ABS(amount)), 0)::float8 AS volume, COUNT(DISTINCT "userId") AS traders
      FROM "Trade" WHERE "marketId" IN (${Prisma.join(ids)}) GROUP BY "marketId"`,
    db.dispute.findMany({ where: { marketId: { in: ids }, handledAt: null }, select: { marketId: true }, distinct: ["marketId"] }),
  ]);
  const statBy = new Map(stats.map((s) => [s.marketId, s]));
  const disputedIds = new Set(disputed.map((d) => d.marketId));
  const now = new Date();
  return markets.map((m) => {
    const mine = outs.filter((o) => o.marketId === m.id);
    const ps =
      m.status === "resolved"
        ? mine.map((o) => (o.id === m.resolvedOutcomeId ? 1 : 0))
        : lmsr.prices(mine.map((o) => o.shares), m.b);
    let state = marketState(m, now);
    if (state === "proposed" && disputedIds.has(m.id)) state = "disputed";
    const s = statBy.get(m.id);
    return {
      m,
      state,
      binary: isBinary(mine.map((o) => o.label)),
      outcomes: mine.map((o, i) => ({ id: o.id, label: o.label, shares: o.shares, price: ps[i] })),
      volume: s?.volume ?? 0,
      traders: Number(s?.traders ?? 0),
    };
  });
}

export async function bundle(db: Db, m: Market): Promise<Bundle> {
  return (await bundles(db, [m]))[0];
}

export async function getOutcomes(db: Db, marketId: number) {
  return db.outcome.findMany({ where: { marketId }, orderBy: { position: "asc" } });
}

export async function snapshotPrices(db: Db, marketId: number, b: number) {
  const outs = await getOutcomes(db, marketId);
  const ps = lmsr.prices(outs.map((o) => o.shares), b);
  await db.priceHistory.create({ data: { marketId, prices: ps.map((p) => Math.round(p * 1e5) / 1e5) } });
}

export type NewMarket = {
  question: string;
  description: string;
  category: string;
  closesAt: Date;
  labels: string[];
  b: number;
  rulesSource: string;
  rulesOtherwise: string;
};

export async function createMarket(db: Db, f: NewMarket, createdById: string | null = null): Promise<number> {
  const m = await db.market.create({
    data: {
      question: f.question, description: f.description, category: f.category, b: f.b, closesAt: f.closesAt,
      createdById, rulesSource: f.rulesSource, rulesOtherwise: f.rulesOtherwise,
      outcomes: { create: f.labels.map((label, position) => ({ label, position })) },
    },
  });
  await snapshotPrices(db, m.id, f.b);
  return m.id;
}

/** Create a market as an admin (the "Create a market" form). */
export async function createMarketAsAdmin(actor: Actor, f: NewMarket): Promise<number> {
  assertAdmin(actor);
  return prisma.$transaction((tx) => createMarket(tx, f, actor.id));
}

/** Void a market: everyone gets back what they net-spent on it. */
export async function cancelMarket(actor: Actor, marketId: number) {
  assertAdmin(actor);
  await prisma.$transaction(async (tx) => {
    await lockMarket(tx, marketId);
    const m = await tx.market.findUnique({ where: { id: marketId } });
    if (!m || m.status !== "open") throw new TradeError("Only unresolved markets can be cancelled.");
    await refundNetSpend(tx, marketId);
    await tx.market.update({ where: { id: marketId }, data: { status: "cancelled", resolvedAt: new Date() } });
  }, { timeout: 30000 });
}

async function refundNetSpend(tx: Db, marketId: number) {
  const rows = await tx.trade.groupBy({ by: ["userId"], where: { marketId }, _sum: { amount: true } });
  for (const r of rows) {
    const net = r._sum.amount ?? 0;
    if (net > 0) await adjustBalance(tx, r.userId, net);
  }
}

/** Remove a market entirely. If it was never settled, everyone's net spend is refunded first. Payouts from an already-resolved market are kept. */
export async function deleteMarket(actor: Actor, marketId: number) {
  assertAdmin(actor);
  await prisma.$transaction(async (tx) => {
    await lockMarket(tx, marketId);
    const m = await tx.market.findUnique({ where: { id: marketId } });
    if (!m) throw new TradeError("Market not found.");
    if (m.status === "open") await refundNetSpend(tx, marketId);
    await tx.market.delete({ where: { id: marketId } }); // children cascade; proposals.marketId is set to null
  }, { timeout: 30000 });
}

export type EditMarketInput = {
  question: string;
  category: string;
  closesAt: Date;
  description: string;
  rulesSource: string;
  rulesOtherwise: string;
  liquidity: string | null;
  /** Free-form outcome list (only used while nobody has bet). */
  labels: string[];
  /** New names by outcome id (only used once somebody has bet). */
  renames: Record<number, string>;
};

/**
 * Edit a market. Text, category and closing time can always change. Once anyone has bet, the written rules and
 * liquidity are locked and outcomes can only be renamed, so prices and payouts stay fair.
 */
export async function editMarket(actor: Actor, marketId: number, input: EditMarketInput) {
  assertAdmin(actor);
  await prisma.$transaction(async (tx) => {
    await lockMarket(tx, marketId);
    const m = await tx.market.findUnique({ where: { id: marketId } });
    if (!m) throw new TradeError("Market not found.");
    const outs = await getOutcomes(tx, marketId);
    const hasTrades = (await tx.trade.count({ where: { marketId } })) > 0;
    const labels = hasTrades ? outs.map((o) => (input.renames[o.id] ?? "").trim().slice(0, 60)) : input.labels;

    if (m.proposedOutcomeId !== null && m.status === "open" && input.closesAt > new Date()) {
      throw new TradeError("A result is proposed for this market. Withdraw it before moving the closing time later.");
    }
    if (!labels.every(Boolean) || new Set(labels.map((x) => x.toLowerCase())).size !== labels.length) {
      throw new TradeError("Outcome names must be filled in and different from each other.");
    }
    if (labels.length < 2 || labels.length > 8) throw new TradeError("Give 2–8 distinct outcomes, one per line.");

    await tx.market.update({
      where: { id: marketId },
      data: { question: input.question, category: input.category, closesAt: input.closesAt },
    });
    if (hasTrades) {
      for (const o of outs) await tx.outcome.update({ where: { id: o.id }, data: { label: (input.renames[o.id] ?? o.label).trim().slice(0, 60) } });
      return;
    }
    const b = isPreset(input.liquidity) ? marketB(input.liquidity, labels.length) : m.b;
    await tx.market.update({
      where: { id: marketId },
      data: {
        description: input.description.slice(0, 2000), rulesSource: input.rulesSource.slice(0, 300),
        rulesOtherwise: input.rulesOtherwise.slice(0, 1000), b,
      },
    });
    const sameLabels = outs.length === labels.length && outs.every((o, i) => o.label === labels[i]);
    if (!sameLabels) {
      await tx.outcome.deleteMany({ where: { marketId } });
      await tx.outcome.createMany({ data: labels.map((label, position) => ({ marketId, label, position })) });
    }
    if (b !== m.b || !sameLabels) {
      await tx.priceHistory.deleteMany({ where: { marketId } });
      await snapshotPrices(tx, marketId, b);
    }
  }, { timeout: 30000 });
}

export async function addClarification(actor: Actor, marketId: number, body: string) {
  assertAdmin(actor);
  if (!(await prisma.market.findUnique({ where: { id: marketId }, select: { id: true } }))) throw new TradeError("Market not found.");
  if (body.length < 5 || body.length > 500) throw new TradeError("A clarification needs 5–500 characters.");
  await prisma.clarification.create({ data: { marketId, adminId: actor.id, body } });
}

export async function addComment(userId: string, marketId: number, body: string) {
  if (!body) throw new TradeError("Comment can't be empty.");
  if (body.length > 500) throw new TradeError("Keep comments under 500 characters.");
  if (!(await prisma.market.findUnique({ where: { id: marketId }, select: { id: true } }))) throw new TradeError("Market not found.");
  await prisma.comment.create({ data: { marketId, userId, body } });
}
