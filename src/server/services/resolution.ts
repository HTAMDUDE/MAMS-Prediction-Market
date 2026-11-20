import { DISPUTE_WINDOW_MS } from "@/lib/constants";
import { prisma, type Tx } from "@/lib/db";
import { getOutcomes } from "./markets";
import { adjustBalance, assertAdmin, lockMarket, TradeError, type Actor } from "./permissions";

async function handleOpenDisputes(tx: Tx, marketId: number) {
  await tx.dispute.updateMany({ where: { marketId, handledAt: null }, data: { handledAt: new Date() } });
}

/**
 * Pay out a market. `automatic` is used when a challenge window ends: it only goes ahead if the proposed result is
 * still the same, the window is over and nobody has an unhandled dispute. Returns how many positions were paid.
 */
async function resolveInTx(tx: Tx, marketId: number, outcomeId: number, resolvedById: string | null, automatic: boolean) {
  await lockMarket(tx, marketId);
  const m = await tx.market.findUnique({ where: { id: marketId } });
  if (!m || m.status !== "open") throw new TradeError("Only unresolved markets can be resolved.");
  if (!(await getOutcomes(tx, marketId)).some((o) => o.id === outcomeId)) throw new TradeError("Unknown outcome.");
  if (automatic) {
    if (
      m.proposedOutcomeId !== outcomeId || !m.finalizesAt || m.finalizesAt > new Date() ||
      (await tx.dispute.count({ where: { marketId, handledAt: null } })) > 0
    ) throw new TradeError("Not ready to finalize.");
  }
  const winners = await tx.position.findMany({ where: { outcomeId } });
  for (const w of winners) await adjustBalance(tx, w.userId, w.shares);
  await tx.market.update({
    where: { id: marketId },
    data: { status: "resolved", resolvedOutcomeId: outcomeId, resolvedAt: new Date(), resolvedById },
  });
  await handleOpenDisputes(tx, marketId);
  return winners.length;
}

/** Nobody is paid yet: an admin names the winner and the result finalizes after the challenge window. */
export async function proposeResult(actor: Actor, marketId: number, outcomeId: number) {
  assertAdmin(actor);
  await prisma.$transaction(async (tx) => {
    await lockMarket(tx, marketId);
    const m = await tx.market.findUnique({ where: { id: marketId } });
    if (!m || m.status !== "open") throw new TradeError("Only unresolved markets can have a result proposed.");
    if (new Date() < m.closesAt) throw new TradeError("Betting hasn't closed yet. Propose a result once it has.");
    if (!(await getOutcomes(tx, marketId)).some((o) => o.id === outcomeId)) throw new TradeError("Unknown outcome.");
    const now = new Date();
    await tx.market.update({
      where: { id: marketId },
      data: { proposedOutcomeId: outcomeId, proposedById: actor.id, proposedAt: now, finalizesAt: new Date(now.getTime() + DISPUTE_WINDOW_MS) },
    });
    await handleOpenDisputes(tx, marketId); // proposing again restarts the window and clears disputes
  });
}

/** Take back a proposed result before it finalizes. */
export async function retractResult(actor: Actor, marketId: number) {
  assertAdmin(actor);
  await prisma.$transaction(async (tx) => {
    await lockMarket(tx, marketId);
    const m = await tx.market.findUnique({ where: { id: marketId } });
    if (!m || m.status !== "open" || m.proposedOutcomeId === null) throw new TradeError("There's no proposed result to withdraw.");
    await tx.market.update({
      where: { id: marketId },
      data: { proposedOutcomeId: null, proposedById: null, proposedAt: null, finalizesAt: null },
    });
    await handleOpenDisputes(tx, marketId);
  });
}

/** An admin confirms a disputed result right away; winners are paid immediately. */
export async function confirmResult(actor: Actor, marketId: number): Promise<number> {
  assertAdmin(actor);
  const m = await prisma.market.findUnique({ where: { id: marketId } });
  if (!m) throw new TradeError("Market not found.");
  const disputes = await prisma.dispute.count({ where: { marketId, handledAt: null } });
  if (m.proposedOutcomeId === null || disputes === 0) {
    throw new TradeError("Only a disputed result needs confirming; others finalize on their own.");
  }
  return prisma.$transaction((tx) => resolveInTx(tx, marketId, m.proposedOutcomeId!, actor.id, false), { timeout: 60000 });
}

/** Pay out every market whose challenge window ended with no unhandled dispute. Called on page loads and by cron. */
export async function finalizeDue(): Promise<number> {
  const due = await prisma.market.findMany({
    where: { status: "open", proposedOutcomeId: { not: null }, finalizesAt: { lte: new Date() } },
    select: { id: true, proposedOutcomeId: true, proposedById: true },
  });
  let done = 0;
  for (const m of due) {
    try {
      await prisma.$transaction((tx) => resolveInTx(tx, m.id, m.proposedOutcomeId!, m.proposedById, true), { timeout: 60000 });
      done++;
    } catch (e) {
      if (!(e instanceof TradeError)) throw e; // a dispute arrived, or another request already finalized it
    }
  }
  return done;
}

export async function addDispute(userId: string, marketId: number, reason: string) {
  const m = await prisma.market.findUnique({ where: { id: marketId } });
  if (!m || m.status !== "open" || m.proposedOutcomeId === null) throw new TradeError("There's no proposed result to dispute.");
  if ((await prisma.trade.count({ where: { userId, marketId } })) === 0) {
    throw new TradeError("Only people who traded in this market can dispute its result.");
  }
  if (reason.length < 10 || reason.length > 500) throw new TradeError("Explain the problem in 10–500 characters.");
  if (await prisma.dispute.findFirst({ where: { marketId, userId, handledAt: null } })) throw new TradeError("You already disputed this result.");
  await prisma.dispute.create({ data: { marketId, userId, reason } });
}
