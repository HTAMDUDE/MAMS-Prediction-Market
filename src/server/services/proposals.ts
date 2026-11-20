import { MAX_PENDING_PROPOSALS } from "@/lib/constants";
import { prisma } from "@/lib/db";
import type { MarketFields } from "@/lib/validation";
import { createMarket } from "./markets";
import { assertAdmin, TradeError, type Actor } from "./permissions";

export async function createProposal(userId: string, f: MarketFields) {
  const pending = await prisma.proposal.count({ where: { userId, status: "pending" } });
  if (pending >= MAX_PENDING_PROPOSALS) {
    throw new TradeError(`You already have ${MAX_PENDING_PROPOSALS} proposals waiting. Wait for an admin to review them.`);
  }
  await prisma.proposal.create({
    data: {
      userId, question: f.question, description: f.description, category: f.category, outcomes: f.labels,
      closesAt: f.closesAt, rulesSource: f.rulesSource, rulesOtherwise: f.rulesOtherwise,
    },
  });
}

export const myProposals = (userId: string) =>
  prisma.proposal.findMany({ where: { userId }, orderBy: { id: "desc" }, take: 20 });

export async function withdrawProposal(userId: string, id: number) {
  const { count } = await prisma.proposal.deleteMany({ where: { id, userId, status: "pending" } });
  if (!count) throw new TradeError("That proposal can't be withdrawn.");
}

/** Approve a proposal (the admin may have tweaked every field): creates the market, credited to the proposer. */
export async function approveProposal(actor: Actor, id: number, f: MarketFields, note: string) {
  assertAdmin(actor);
  return prisma.$transaction(async (tx) => {
    const p = await tx.proposal.findUnique({ where: { id }, include: { user: true } });
    if (!p) throw new TradeError("Proposal not found.");
    const { count } = await tx.proposal.updateMany({
      where: { id, status: "pending" },
      data: { status: "approved", reviewNote: note.slice(0, 500), reviewedById: actor.id, reviewedAt: new Date() },
    });
    if (!count) throw new TradeError("This proposal was already reviewed."); // another admin got there first
    const marketId = await createMarket(tx, f, p.userId);
    await tx.proposal.update({ where: { id }, data: { marketId } });
    return { marketId, proposer: p.user.displayUsername ?? p.user.username ?? "the proposer" };
  });
}

export async function rejectProposal(actor: Actor, id: number, note: string) {
  assertAdmin(actor);
  const { count } = await prisma.proposal.updateMany({
    where: { id, status: "pending" },
    data: { status: "rejected", reviewNote: note.slice(0, 500), reviewedById: actor.id, reviewedAt: new Date() },
  });
  if (!count) throw new TradeError("This proposal was already reviewed.");
}
