import { prisma } from "@/lib/db";
import { logAudit, userLabel } from "./audit";
import { assertAdmin, canManage, findOwnerId, NOT_ALLOWED, TradeError, type Actor } from "./permissions";

export const HIDDEN_PLACEHOLDER = "This comment was hidden by an admin.";

/** A market's comments, newest first. Hidden comments only show their text to admins. */
export async function loadComments(marketId: number, viewerIsAdmin: boolean) {
  const rows = await prisma.comment.findMany({ where: { marketId }, orderBy: { id: "desc" }, include: { user: true } });
  return rows.map((c) => ({
    id: c.id,
    userId: c.userId,
    authorIsAdmin: c.user.isAdmin,
    username: c.user.displayUsername ?? c.user.username ?? "?",
    createdAt: c.createdAt,
    hidden: c.hidden,
    body: c.hidden && !viewerIsAdmin ? null : c.body, // never sent to non-admins
  }));
}

async function moderatable(actor: Actor, commentId: number) {
  assertAdmin(actor);
  const c = await prisma.comment.findUnique({ where: { id: commentId }, include: { user: { select: { id: true } } } });
  if (!c) throw new TradeError("That comment no longer exists.");
  // Same rule as for people: admins moderate regular users (and themselves); only the owner moderates admins.
  if (c.userId !== actor.id && !(await canManage(actor, c.userId))) throw new TradeError(NOT_ALLOWED);
  return c;
}

const excerpt = (s: string) => (s.length > 80 ? `${s.slice(0, 80)}…` : s);

export async function setCommentHidden(actor: Actor, commentId: number, hidden: boolean) {
  const c = await moderatable(actor, commentId);
  await prisma.comment.update({ where: { id: commentId }, data: { hidden } });
  await logAudit(actor, hidden ? "comment.hide" : "comment.unhide", {
    targetType: "comment", targetId: commentId, targetLabel: await userLabel(c.userId), detail: `Market #${c.marketId}: “${excerpt(c.body)}”`,
  });
}

export async function deleteComment(actor: Actor, commentId: number) {
  const c = await moderatable(actor, commentId);
  await prisma.comment.delete({ where: { id: commentId } });
  await logAudit(actor, "comment.delete", {
    targetType: "comment", targetId: commentId, targetLabel: await userLabel(c.userId), detail: `Market #${c.marketId}: “${excerpt(c.body)}”`,
  });
}

/** Turn commenting off for a user (trading is separate), or back on if it was off. */
export async function toggleCommentMute(actor: Actor, userId: string) {
  assertAdmin(actor);
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!u) throw new TradeError("User not found.");
  if (!(await canManage(actor, userId))) throw new TradeError(NOT_ALLOWED);
  if (userId === (await findOwnerId())) throw new TradeError("The owner can't be muted.");
  const label = await userLabel(userId);
  if (await prisma.commentMute.findUnique({ where: { userId } })) {
    await prisma.commentMute.delete({ where: { userId } });
    await logAudit(actor, "user.comment_unmute", { targetType: "user", targetId: userId, targetLabel: label });
    return { muted: false, username: label };
  }
  await prisma.commentMute.create({ data: { userId } });
  await logAudit(actor, "user.comment_mute", { targetType: "user", targetId: userId, targetLabel: label });
  return { muted: true, username: label };
}
