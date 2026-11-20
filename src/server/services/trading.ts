import { CURRENCY, cents, EPS, MIN_BET } from "@/lib/constants";
import { prisma, type Db } from "@/lib/db";
import * as lmsr from "@/lib/lmsr";
import { getOutcomes, marketState, snapshotPrices } from "./markets";
import { adjustBalance, lockMarket, lockUser, TradeError } from "./permissions";

export type TradeAction = "buy" | "sell";

/** Why this user can't trade in this market, or null if they can. */
export async function tradeBlockReason(db: Db, userId: string, marketId: number): Promise<string | null> {
  if (await db.tradeBan.findUnique({ where: { userId } })) return "An admin has turned off trading for your account.";
  if (await db.marketBlock.findUnique({ where: { marketId_userId: { marketId, userId } } })) {
    return "An admin has blocked you from betting on this market.";
  }
  return null;
}

/**
 * Validate a trade and price it. Returns shares bought/sold and coins spent/received. Throws TradeError with a
 * user-facing message. balance/held may be null to skip those checks (used for logged-out quotes). Shared by
 * executeTrade and the /api/quote preview so they always agree.
 */
export function checkTrade(
  m: { b: number },
  outs: { shares: number; label: string }[],
  idx: number,
  action: TradeAction,
  value: number,
  balance: number | null = null,
  held: number | null = null,
): { shares: number; coins: number } {
  const q = outs.map((o) => o.shares);
  const label = outs[idx].label;
  if (action === "buy") {
    const amount = cents(value);
    if (amount < MIN_BET) throw new TradeError(`Minimum bet is ${MIN_BET.toFixed(0)} ${CURRENCY}.`);
    if (balance !== null && amount > balance + EPS) throw new TradeError("You don't have enough MAMS Bucks for that bet.");
    return { shares: lmsr.sharesForAmount(q, m.b, idx, amount), coins: amount };
  }
  if (action === "sell") {
    let shares = value;
    if (held !== null && Math.abs(shares - held) < 1e-6) shares = held;
    if (shares <= EPS) throw new TradeError("Enter a number of shares to sell.");
    if (held !== null && shares > held + EPS) throw new TradeError(`You only own ${held.toFixed(2)} shares of “${label}”.`);
    return { shares, coins: Math.floor(lmsr.sellValue(q, m.b, idx, shares) * 100) / 100 };
  }
  throw new TradeError("Unknown action.");
}

/** Buy (value = coins to spend) or sell (value = shares to sell). Returns a status message. */
export async function executeTrade(userId: string, marketId: number, outcomeId: number, action: TradeAction, value: number): Promise<string> {
  return prisma.$transaction(async (tx) => {
    await lockMarket(tx, marketId);
    const m = await tx.market.findUnique({ where: { id: marketId } });
    if (!m) throw new TradeError("Market not found.");
    if (marketState(m) !== "open") throw new TradeError("This market is no longer accepting bets.");
    const block = await tradeBlockReason(tx, userId, marketId);
    if (block) throw new TradeError(block);
    const outs = await getOutcomes(tx, marketId);
    const idx = outs.findIndex((o) => o.id === outcomeId);
    if (idx < 0) throw new TradeError("Unknown outcome.");
    const label = outs[idx].label;
    await lockUser(tx, userId);
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { balance: true } });
    const pos = await tx.position.findUnique({ where: { userId_outcomeId: { userId, outcomeId } } });
    const held = pos?.shares ?? 0;
    const heldCost = pos?.cost ?? 0;

    const { shares, coins } = checkTrade(m, outs, idx, action, value, user.balance, held);
    const q = outs.map((o) => o.shares);
    q[idx] += action === "buy" ? shares : -shares;
    const nowPct = lmsr.prices(q, m.b)[idx] * 100;

    let dShares: number, dCash: number, newShares: number, newCost: number, msg: string;
    if (action === "buy") {
      dShares = shares; dCash = -coins;
      newShares = held + shares; newCost = heldCost + coins;
      msg = `Bought ${shares.toFixed(2)} shares of “${label}” for ${coins.toFixed(2)} ${CURRENCY} — now ${nowPct.toFixed(0)}%.`;
    } else {
      dShares = -shares; dCash = coins;
      newShares = held - shares;
      newCost = held > 0 ? heldCost * (newShares / held) : 0;
      msg = `Sold ${shares.toFixed(2)} shares of “${label}” for ${coins.toFixed(2)} ${CURRENCY} — now ${nowPct.toFixed(0)}%.`;
    }

    await tx.outcome.update({ where: { id: outcomeId }, data: { shares: { increment: dShares } } });
    await adjustBalance(tx, userId, dCash);
    if (newShares <= 1e-9) {
      await tx.position.deleteMany({ where: { userId, outcomeId } });
    } else {
      await tx.position.upsert({
        where: { userId_outcomeId: { userId, outcomeId } },
        create: { userId, outcomeId, shares: newShares, cost: newCost },
        update: { shares: newShares, cost: newCost },
      });
    }
    await tx.trade.create({ data: { userId, marketId, outcomeId, shares: dShares, amount: -dCash } });
    await snapshotPrices(tx, marketId, m.b);
    return msg;
  }, { timeout: 15000 });
}

/** Preview a trade without making it (logged-out visitors still get a price preview). */
export async function quoteTrade(userId: string | null, marketId: number, outcomeId: number, action: TradeAction, value: number) {
  const m = await prisma.market.findUnique({ where: { id: marketId } });
  if (!m || marketState(m) !== "open") throw new TradeError("This market is no longer accepting bets.");
  const outs = await getOutcomes(prisma, marketId);
  const idx = outs.findIndex((o) => o.id === outcomeId);
  if (idx < 0) throw new TradeError("Unknown outcome.");
  let balance: number | null = null;
  let held: number | null = null;
  if (userId) {
    const block = await tradeBlockReason(prisma, userId, marketId);
    if (block) throw new TradeError(block);
    const [user, pos] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { balance: true } }),
      prisma.position.findUnique({ where: { userId_outcomeId: { userId, outcomeId } } }),
    ]);
    balance = user.balance;
    held = pos?.shares ?? 0;
  }
  const { shares, coins } = checkTrade(m, outs, idx, action, value, balance, held);
  const q = outs.map((o) => o.shares);
  q[idx] += action === "buy" ? shares : -shares;
  return {
    shares: Math.round(shares * 1e4) / 1e4,
    coins,
    avgPrice: shares ? coins / shares : 0,
    newPrice: lmsr.prices(q, m.b)[idx],
  };
}
