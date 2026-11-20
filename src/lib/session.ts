import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";
import { prisma } from "./db";
import { ownerUsername } from "./constants";
import { findOwnerId, type Actor } from "@/server/services/permissions";

export type CurrentUser = {
  id: string;
  username: string; // display casing
  balance: number;
  isAdmin: boolean;
  isOwner: boolean;
  lastBonus: string | null;
};

export const getOwnerId = cache(() => findOwnerId());

let firstAccountId: string | null = null; // with no MAMS_OWNER the owner is the first account, which never changes

/** Whether this user is the owner. Needs no query when MAMS_OWNER is set (usernames are stored lowercase). */
async function isOwnerUser(userId: string, usernameLower: string | null | undefined): Promise<boolean> {
  const owner = ownerUsername();
  if (owner !== "") return usernameLower === owner;
  firstAccountId ??= await findOwnerId();
  return firstAccountId === userId;
}

export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  const u = session.user as typeof session.user & {
    balance: number; isAdmin: boolean; lastBonus?: string | null; username?: string | null; displayUsername?: string | null;
  };
  const isOwner = await isOwnerUser(u.id, u.username);
  let isAdmin = Boolean(u.isAdmin);
  if (isOwner && !isAdmin) {
    await prisma.user.update({ where: { id: u.id }, data: { isAdmin: true } }); // the owner is always an admin
    isAdmin = true;
  }
  return {
    id: u.id,
    username: u.displayUsername ?? u.username ?? u.name,
    balance: u.balance,
    isAdmin,
    isOwner,
    lastBonus: u.lastBonus ?? null,
  };
});

export const toActor = (u: CurrentUser): Actor => ({ id: u.id, isAdmin: u.isAdmin, isOwner: u.isOwner });

export async function requireUser(next?: string): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  return user;
}

/** For pages: returns the admin, or null when the visitor must see the 403 page. */
export async function getAdminOrNull(): Promise<CurrentUser | null> {
  const user = await getCurrentUser();
  return user?.isAdmin ? user : null;
}
