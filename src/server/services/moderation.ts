import { cents } from "@/lib/constants";
import { prisma, type Tx } from "@/lib/db";
import { logAudit, userLabel } from "./audit";
import { snapshotPrices } from "./markets";
import { adjustBalance, assertAdmin, canManage, findOwnerId, lockMarket, NOT_ALLOWED, TradeError, type Actor } from "./permissions";

/**
 * Undo a user's bets in an unresolved market: give back what they net-spent, remove their shares from the market
 * (reversing their effect on prices) and erase their trades. Must run inside a transaction (with the market locked).
 * Returns the amount refunded.
 */
export async function refundUserInMarket(tx: Tx, userId: string, marketId: number): Promise<number> {
  const m = await tx.market.findUnique({ where: { id: marketId } });
  if (!m || m.status !== "open") return 0; // resolved/cancelled markets are already settled
  if ((await tx.trade.count({ where: { userId, marketId } })) === 0) return 0;
  const net = (await tx.trade.aggregate({ where: { userId, marketId }, _sum: { amount: true } }))._sum.amount ?? 0;
  const positions = await tx.position.findMany({ where: { userId, outcome: { marketId } } });
  for (const p of positions) {
    await tx.outcome.update({ where: { id: p.outcomeId }, data: { shares: { decrement: p.shares } } });
  }
  await tx.position.deleteMany({ where: { userId, outcome: { marketId } } });
  await tx.trade.deleteMany({ where: { userId, marketId } });
  const refund = cents(Math.max(net, 0)); // if they already sold at a profit, there's nothing to give back
  if (refund > 0) await adjustBalance(tx, userId, refund);
  await snapshotPrices(tx, marketId, m.b);
  return refund;
}

export async function blockUserInMarket(actor: Actor, marketId: number, usernameInput: string) {
  assertAdmin(actor);
  if (!(await prisma.market.findUnique({ where: { id: marketId }, select: { id: true } }))) throw new TradeError("Market not found.");
  const name = usernameInput.trim();
  const u = await prisma.user.findUnique({ where: { username: name.toLowerCase() }, select: { id: true, username: true, displayUsername: true } });
  if (!u) throw new TradeError(`No user named “${name}”.`);
  if (!(await canManage(actor, u.id))) throw new TradeError(NOT_ALLOWED);
  const refund = await prisma.$transaction(async (tx) => {
    await lockMarket(tx, marketId);
    await tx.marketBlock.upsert({
      where: { marketId_userId: { marketId, userId: u.id } }, create: { marketId, userId: u.id }, update: {},
    });
    return refundUserInMarket(tx, u.id, marketId);
  }, { timeout: 30000 });
  const username = u.displayUsername ?? u.username ?? name;
  await logAudit(actor, "market.block", {
    targetType: "user", targetId: u.id, targetLabel: username, detail: `Market #${marketId}.${refund ? ` Refunded Ⓜ${refund.toFixed(2)}.` : ""}`,
  });
  return { username, refund };
}

export async function unblockUserInMarket(actor: Actor, marketId: number, userId: string) {
  assertAdmin(actor);
  await prisma.marketBlock.deleteMany({ where: { marketId, userId } });
  await logAudit(actor, "market.unblock", { targetType: "user", targetId: userId, targetLabel: await userLabel(userId), detail: `Market #${marketId}.` });
}

/** Turn trading off for a user (refunding their open bets everywhere), or back on if it was off. */
export async function toggleTradingBan(actor: Actor, userId: string) {
  assertAdmin(actor);
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, username: true, displayUsername: true } });
  if (!u) throw new TradeError("User not found.");
  const label = u.displayUsername ?? u.username ?? "That user";
  if (!(await canManage(actor, userId))) throw new TradeError(NOT_ALLOWED);
  if (userId === (await findOwnerId())) throw new TradeError("The owner can't be banned from trading.");
  if (await prisma.tradeBan.findUnique({ where: { userId } })) {
    await prisma.tradeBan.delete({ where: { userId } });
    await logAudit(actor, "user.unban", { targetType: "user", targetId: userId, targetLabel: label });
    return { banned: false, refund: 0, username: label };
  }
  const refund = await prisma.$transaction(async (tx) => {
    await tx.tradeBan.upsert({ where: { userId }, create: { userId }, update: {} });
    const markets = await tx.trade.findMany({ where: { userId }, distinct: ["marketId"], select: { marketId: true }, orderBy: { marketId: "asc" } });
    let total = 0;
    for (const { marketId } of markets) {
      await lockMarket(tx, marketId); // ascending order, so concurrent bans can't deadlock
      total += await refundUserInMarket(tx, userId, marketId);
    }
    return total;
  }, { timeout: 60000 });
  await logAudit(actor, "user.ban", {
    targetType: "user", targetId: userId, targetLabel: label, detail: refund ? `Refunded Ⓜ${refund.toFixed(2)} from open bets.` : "",
  });
  return { banned: true, refund, username: label };
}

export async function grantBalance(actor: Actor, userId: string, amountInput: number) {
  assertAdmin(actor);
  const amount = cents(amountInput);
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100000) {
    throw new TradeError("Enter an amount between -100,000 and 100,000.");
  }
  if (!(await canManage(actor, userId))) throw new TradeError(NOT_ALLOWED);
  await adjustBalance(prisma, userId, amount, { floorAtZero: true });
  await logAudit(actor, "user.grant", {
    targetType: "user", targetId: userId, targetLabel: await userLabel(userId), detail: `${amount > 0 ? "+" : "−"}Ⓜ${Math.abs(amount).toFixed(2)}`,
  });
  return amount;
}

export async function toggleAdmin(actor: Actor, userId: string) {
  if (!actor.isOwner) throw new TradeError("Only the site owner can add or remove admins.");
  if (userId === actor.id) throw new TradeError("You can't remove your own admin access.");
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
  if (!u) throw new TradeError("User not found.");
  await prisma.user.update({ where: { id: userId }, data: { isAdmin: !u.isAdmin } });
  await logAudit(actor, u.isAdmin ? "user.admin_off" : "user.admin_on", { targetType: "user", targetId: userId, targetLabel: await userLabel(userId) });
}
