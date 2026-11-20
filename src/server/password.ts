import { randomBytes } from "node:crypto";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { TradeError } from "./services/permissions";

/** Give a user a new random password (hashed like better-auth does) and return it, to be shared privately. */
export async function setTemporaryPassword(userId: string): Promise<string> {
  const ctx = await auth.$context;
  const password = randomBytes(9).toString("base64url");
  const hash = await ctx.password.hash(password);
  const existing = await prisma.account.findFirst({ where: { userId, providerId: "credential" } });
  if (existing) {
    await prisma.account.update({ where: { id: existing.id }, data: { password: hash } });
  } else {
    await prisma.account.create({ data: { id: randomBytes(16).toString("hex"), accountId: userId, providerId: "credential", userId, password: hash } });
  }
  await prisma.session.deleteMany({ where: { userId } }); // sign them out everywhere
  await prisma.loginFailure.deleteMany({ where: { username: (await prisma.user.findUnique({ where: { id: userId }, select: { username: true } }))?.username ?? "" } });
  return password;
}

export async function findUserIdByUsername(username: string): Promise<string> {
  const u = await prisma.user.findUnique({ where: { username: username.trim().toLowerCase() }, select: { id: true } });
  if (!u) throw new TradeError(`No user named “${username}”.`);
  return u.id;
}
