import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { actorFor, type Actor } from "@/server/services/permissions";
import { createMarket } from "@/server/services/markets";

export const RULES = "Resolves YES if the official results list MAMS first.";
export const hours = (h: number) => new Date(Date.now() + h * 3600 * 1000);

/** Empty every table between tests. */
export async function resetDb() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "Dispute","Clarification","MarketBlock","TradeBan","Comment","PriceHistory","Trade","Position","Proposal","Outcome","Market","LoginFailure","rateLimit","session","account","verification","user" RESTART IDENTITY CASCADE`,
  );
}

let tick = 0;

/** Insert a user directly (bypassing sign-up). Usernames are stored lowercase like the better-auth username plugin does. */
export async function makeUser(name: string, opts: { balance?: number; isAdmin?: boolean } = {}) {
  return prisma.user.create({
    data: {
      id: randomUUID(), name, email: `${name.toLowerCase()}@users.mams.invalid`, username: name.toLowerCase(),
      displayUsername: name, createdAt: new Date(Date.now() - 1_000_000 + tick++), balance: opts.balance ?? 1000, isAdmin: opts.isAdmin ?? false,
    },
  });
}

/** A user plus the actor describing their permissions (first account is owner when MAMS_OWNER is empty). */
export async function makeActor(name: string, opts: { balance?: number; isAdmin?: boolean } = {}): Promise<{ id: string; actor: Actor }> {
  const u = await makeUser(name, opts);
  return { id: u.id, actor: await actorFor(u.id) };
}

export async function makeMarket(opts: { n?: number; b?: number; labels?: string[]; closesInHours?: number; createdBy?: string | null; question?: string; description?: string } = {}) {
  const labels = opts.labels ?? Array.from({ length: opts.n ?? 2 }, (_, i) => `o${i}`);
  const id = await createMarket(prisma, {
    question: opts.question ?? `Q${labels.length}-${opts.b ?? 300}?`, description: opts.description ?? "", category: "Other",
    closesAt: hours(opts.closesInHours ?? 72), labels, b: opts.b ?? 300, rulesSource: "", rulesOtherwise: "",
  }, opts.createdBy ?? null);
  const outs = await prisma.outcome.findMany({ where: { marketId: id }, orderBy: { position: "asc" } });
  return { id, outs: outs.map((o) => o.id) };
}

export const balanceOf = async (userId: string) => (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).balance;
export const sharesHeld = async (userId: string, outcomeId: number) =>
  (await prisma.position.findUnique({ where: { userId_outcomeId: { userId, outcomeId } } }))?.shares ?? 0;
/** Make a market look like its betting window closed an hour ago. */
export const closeMarket = (id: number) => prisma.market.update({ where: { id }, data: { closesAt: hours(-1) } });
