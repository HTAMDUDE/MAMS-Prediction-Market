import { adminUsernames, ownerUsername } from "@/lib/constants";
import { prisma, type Db } from "@/lib/db";

/** A user-facing error: the message is shown to the user as-is. */
export class TradeError extends Error {}

/** Who is acting. Services enforce permissions themselves so tests exercise them. */
export type Actor = { id: string; isAdmin: boolean; isOwner: boolean };

export const NOT_ALLOWED = "Only the site owner can do that to an admin.";

/** The owner's user id: the MAMS_OWNER username, or the first account if none is configured. */
export async function findOwnerId(db: Db = prisma): Promise<string | null> {
  const name = ownerUsername();
  const row = name
    ? await db.user.findUnique({ where: { username: name }, select: { id: true } })
    : await db.user.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  return row?.id ?? null;
}

/** Whether a brand-new account starts as an admin: the owner, anyone in MAMS_ADMINS, or (with no owner configured) the very first account. */
export async function startsAsAdmin(usernameLower: string, db: Db = prisma): Promise<boolean> {
  const owner = ownerUsername();
  if (owner !== "" && usernameLower === owner) return true;
  if (adminUsernames().has(usernameLower)) return true;
  return owner === "" && (await db.user.count()) === 0;
}

export async function actorFor(userId: string, db: Db = prisma): Promise<Actor> {
  const [u, ownerId] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, isAdmin: true } }),
    findOwnerId(db),
  ]);
  const isOwner = ownerId === u.id;
  return { id: u.id, isAdmin: u.isAdmin || isOwner, isOwner };
}

export function assertAdmin(actor: Actor) {
  if (!actor.isAdmin) throw new TradeError("Only admins can do that.");
}

/** The owner can manage anyone. Other admins can only manage regular (non-admin) users. */
export async function canManage(actor: Actor, targetId: string, db: Db = prisma): Promise<boolean> {
  if (actor.isOwner) return true;
  if (targetId === (await findOwnerId(db))) return false;
  const target = await db.user.findUnique({ where: { id: targetId }, select: { isAdmin: true } });
  return target !== null && !target.isAdmin;
}

/** Add (or subtract) coins atomically, keeping balances rounded to cents. Must be used instead of read-modify-write. */
export async function adjustBalance(db: Db, userId: string, delta: number, opts: { floorAtZero?: boolean } = {}) {
  if (opts.floorAtZero) {
    await db.$executeRaw`UPDATE "user" SET balance = GREATEST(0, ROUND((balance + ${delta}::float8)::numeric, 2))::float8 WHERE id = ${userId}`;
  } else {
    await db.$executeRaw`UPDATE "user" SET balance = ROUND((balance + ${delta}::float8)::numeric, 2)::float8 WHERE id = ${userId}`;
  }
}

export async function lockMarket(db: Db, marketId: number) {
  await db.$queryRaw`SELECT id FROM "Market" WHERE id = ${marketId} FOR UPDATE`;
}

export async function lockUser(db: Db, userId: string) {
  await db.$queryRaw`SELECT id FROM "user" WHERE id = ${userId} FOR UPDATE`;
}

/** Mark every unhandled dispute on a market as handled (resolved, cancelled, or re-proposed). */
export async function handleOpenDisputes(db: Db, marketId: number) {
  await db.dispute.updateMany({ where: { marketId, handledAt: null }, data: { handledAt: new Date() } });
}
