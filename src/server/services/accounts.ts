import type { Prisma } from "@/generated/prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { LEGACY_EMAIL_DOMAIN } from "@/lib/username";
import { emailSchema } from "@/lib/validation";
import { logAudit, userLabel } from "./audit";
import { refundUserInMarket } from "./moderation";
import { assertAdmin, canManage, findOwnerId, lockMarket, NOT_ALLOWED, TradeError, type Actor } from "./permissions";

export const USER_PAGE_SIZE = 25;
export const USER_FILTERS = ["all", "admins", "banned", "muted", "unverified"] as const;
export type UserFilter = (typeof USER_FILTERS)[number];

export const isLegacyEmail = (email: string) => email.toLowerCase().endsWith(`@${LEGACY_EMAIL_DOMAIN}`);

/** Users for Admin → Users: searchable by username or email, filterable, 25 per page. */
export async function listUsers(actor: Actor, opts: { q?: string; filter?: string; page?: number } = {}) {
  assertAdmin(actor);
  const q = opts.q?.trim();
  const filter: UserFilter = (USER_FILTERS as readonly string[]).includes(opts.filter ?? "") ? (opts.filter as UserFilter) : "all";
  const ownerId = await findOwnerId(); // the owner always counts as an admin, whatever their stored flag says
  const where: Prisma.UserWhereInput = {
    AND: [
      q ? { OR: [
        { username: { contains: q, mode: "insensitive" } },
        { displayUsername: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
      ] } : {},
      filter === "admins" ? { OR: [{ isAdmin: true }, ...(ownerId ? [{ id: ownerId }] : [])] } : {},
      filter === "banned" ? { tradeBan: { isNot: null } } : {},
      filter === "muted" ? { commentMute: { isNot: null } } : {},
      filter === "unverified" ? { emailVerified: false } : {},
    ],
  };
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where, orderBy: { username: "asc" }, skip: (page - 1) * USER_PAGE_SIZE, take: USER_PAGE_SIZE,
      include: { tradeBan: { select: { userId: true } }, commentMute: { select: { userId: true } } },
    }),
    prisma.user.count({ where }),
  ]);
  return {
    total, page, pages: Math.max(1, Math.ceil(total / USER_PAGE_SIZE)), filter, q: q ?? "",
    rows: users.map((u) => ({
      id: u.id,
      username: u.displayUsername ?? u.username ?? u.name,
      email: u.email,
      legacyEmail: isLegacyEmail(u.email),
      emailVerified: u.emailVerified,
      balance: u.balance,
      isAdmin: u.isAdmin || u.id === ownerId,
      isOwner: u.id === ownerId,
      banned: u.tradeBan !== null,
      muted: u.commentMute !== null,
      createdAt: u.createdAt,
    })),
  };
}

async function manageable(actor: Actor, userId: string) {
  assertAdmin(actor);
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, emailVerified: true } });
  if (!u) throw new TradeError("User not found.");
  if (!(await canManage(actor, userId))) throw new TradeError(NOT_ALLOWED);
  return u;
}

/**
 * Give a user a new email (fixing a typo, or adding one to an imported account). They have to verify the new address,
 * so a link is sent to it and they can't log in until they do.
 */
export async function updateUserEmail(actor: Actor, userId: string, input: string) {
  const u = await manageable(actor, userId);
  const parsed = emailSchema.safeParse(input);
  if (!parsed.success) throw new TradeError("Enter a valid email address.");
  const email = parsed.data;
  if (isLegacyEmail(email)) throw new TradeError("Use a real email address.");
  if (email === u.email.toLowerCase()) throw new TradeError("That's already their email.");
  if (await prisma.user.findFirst({ where: { email, NOT: { id: userId } }, select: { id: true } })) {
    throw new TradeError("Another account already uses that email.");
  }
  await prisma.user.update({ where: { id: userId }, data: { email, emailVerified: false } });
  await auth.api.sendVerificationEmail({ body: { email } });
  await logAudit(actor, "user.email_change", { targetType: "user", targetId: userId, targetLabel: await userLabel(userId), detail: `${u.email} → ${email}` });
  return email;
}

/** Vouch for an email without a link (e.g. you spoke to them). Lets them log in right away. */
export async function markEmailVerified(actor: Actor, userId: string) {
  const u = await manageable(actor, userId);
  if (u.emailVerified) throw new TradeError("That email is already verified.");
  await prisma.user.update({ where: { id: userId }, data: { emailVerified: true } });
  await logAudit(actor, "user.verify", { targetType: "user", targetId: userId, targetLabel: await userLabel(userId), detail: u.email });
}

export async function resendVerification(actor: Actor, userId: string) {
  const u = await manageable(actor, userId);
  if (u.emailVerified) throw new TradeError("That email is already verified.");
  if (isLegacyEmail(u.email)) throw new TradeError("This account has no real email yet. Set one first.");
  await auth.api.sendVerificationEmail({ body: { email: u.email } });
  await logAudit(actor, "user.resend_verification", { targetType: "user", targetId: userId, targetLabel: await userLabel(userId), detail: u.email });
}

/**
 * Delete an account. Their bets in unresolved markets are reversed first (shares leave the market and prices are
 * restored), then their trades, positions, comments, proposals, disputes, sessions and blocks go with them. Payouts from
 * resolved markets stay as they were. Admins must be demoted first, and the owner and your own account can't be deleted.
 */
export async function deleteUser(actor: Actor, userId: string) {
  assertAdmin(actor);
  if (userId === actor.id) throw new TradeError("You can't delete your own account.");
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, isAdmin: true } });
  if (!target) throw new TradeError("User not found.");
  if (userId === (await findOwnerId())) throw new TradeError("The owner's account can't be deleted.");
  if (!(await canManage(actor, userId))) throw new TradeError(NOT_ALLOWED);
  if (target.isAdmin) throw new TradeError("Remove their admin role before deleting the account.");
  const label = await userLabel(userId);
  const refund = await prisma.$transaction(async (tx) => {
    const markets = await tx.trade.findMany({ where: { userId }, distinct: ["marketId"], select: { marketId: true }, orderBy: { marketId: "asc" } });
    let total = 0;
    for (const { marketId } of markets) {
      await lockMarket(tx, marketId); // ascending order, so concurrent deletes can't deadlock
      total += await refundUserInMarket(tx, userId, marketId);
    }
    await tx.user.delete({ where: { id: userId } });
    return total;
  }, { timeout: 60000 });
  await logAudit(actor, "user.delete", { targetType: "user", targetId: userId, targetLabel: label, detail: refund ? `Open bets reversed (Ⓜ${refund.toFixed(2)}).` : "" });
  return { username: label, refund };
}
