/**
 * One-off import of the old Flask/SQLite database into Postgres:  pnpm import:sqlite path/to/mams.db
 *
 * Markets, outcomes, bets, history, comments, proposals, disputes, blocks and bans keep their ids. Users get new ids and
 * must set a password again (run `pnpm reset-password <username>` for the owner first, then use Admin → Users → Reset).
 * Refuses to run if the target database already has users or markets.
 */
import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { TZDate } from "@date-fns/tz";
import type { Prisma } from "../src/generated/prisma/client";
import { auth } from "../src/lib/auth";
import { prisma } from "../src/lib/db";
import { SCHOOL_TZ } from "../src/lib/time";
import { syntheticEmail } from "../src/lib/username";

type Row = Record<string, string | number | null>;

/** Old databases stored naive school-time strings like "2026-11-20 15:00:00". */
function at(s: string | number | null): Date | null {
  if (typeof s !== "string" || !s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = m.slice(1).map(Number);
  return new Date(new TZDate(y, mo - 1, d, h, mi, sec, SCHOOL_TZ).getTime());
}
const need = (s: string | number | null) => at(s) ?? new Date();

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: pnpm import:sqlite path/to/mams.db");
  if ((await prisma.user.count()) > 0 || (await prisma.market.count()) > 0) {
    throw new Error("The target database already has users or markets. Import into an empty database.");
  }
  const old = new DatabaseSync(path, { readOnly: true });
  const all = (table: string) => old.prepare(`SELECT * FROM ${table}`).all() as Row[];
  const ctx = await auth.$context;

  const userIds = new Map<number, string>();
  const uid = (n: number | null) => (n === null ? null : (userIds.get(n) ?? null));

  const users = all("users");
  const accounts: Prisma.AccountCreateManyInput[] = [];
  const newUsers: Prisma.UserCreateManyInput[] = [];
  for (const u of users) {
    const id = randomUUID();
    userIds.set(u.id as number, id);
    const name = String(u.username);
    newUsers.push({
      id, name, email: syntheticEmail(name), username: name.toLowerCase(), displayUsername: name,
      balance: u.balance as number, isAdmin: u.is_admin === 1, lastBonus: (u.last_bonus as string | null) ?? null, createdAt: need(u.created_at),
    });
    // A hash of a random string nobody knows: the account can't be logged into until a password is reset.
    accounts.push({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: await ctx.password.hash(randomBytes(32).toString("hex")) });
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.createMany({ data: newUsers });
    await tx.account.createMany({ data: accounts });
    await tx.market.createMany({
      data: all("markets").map((m) => ({
        id: m.id as number, question: String(m.question), description: String(m.description ?? ""), category: String(m.category), b: m.b as number,
        status: String(m.status), closesAt: need(m.closes_at), resolvedOutcomeId: m.resolved_outcome_id as number | null, resolvedAt: at(m.resolved_at),
        createdById: uid(m.created_by as number | null), createdAt: need(m.created_at), rulesSource: String(m.rules_source ?? ""), rulesOtherwise: String(m.rules_otherwise ?? ""),
        proposedOutcomeId: m.proposed_outcome_id as number | null, proposedById: uid(m.proposed_by as number | null), proposedAt: at(m.proposed_at),
        finalizesAt: at(m.finalizes_at), resolvedById: uid(m.resolved_by as number | null),
      })),
    });
    await tx.outcome.createMany({ data: all("outcomes").map((o) => ({ id: o.id as number, marketId: o.market_id as number, label: String(o.label), shares: o.shares as number, position: o.position as number })) });
    await tx.position.createMany({ data: all("positions").map((p) => ({ userId: uid(p.user_id as number)!, outcomeId: p.outcome_id as number, shares: p.shares as number, cost: p.cost as number })) });
    await tx.trade.createMany({ data: all("trades").map((t) => ({ id: t.id as number, userId: uid(t.user_id as number)!, marketId: t.market_id as number, outcomeId: t.outcome_id as number, shares: t.shares as number, amount: t.amount as number, createdAt: need(t.created_at) })) });
    await tx.priceHistory.createMany({ data: all("price_history").map((h) => ({ id: h.id as number, marketId: h.market_id as number, prices: JSON.parse(String(h.prices)) as number[], createdAt: need(h.created_at) })) });
    await tx.comment.createMany({ data: all("comments").map((c) => ({ id: c.id as number, marketId: c.market_id as number, userId: uid(c.user_id as number)!, body: String(c.body), createdAt: need(c.created_at) })) });
    const marketIds = new Set(all("markets").map((m) => m.id as number));
    await tx.proposal.createMany({
      data: all("proposals").map((p) => ({
        id: p.id as number, userId: uid(p.user_id as number)!, question: String(p.question), description: String(p.description ?? ""), category: String(p.category),
        outcomes: JSON.parse(String(p.outcomes)) as string[], closesAt: need(p.closes_at), status: String(p.status), reviewNote: String(p.review_note ?? ""),
        reviewedById: uid(p.reviewed_by as number | null), reviewedAt: at(p.reviewed_at), marketId: marketIds.has(p.market_id as number) ? (p.market_id as number) : null,
        createdAt: need(p.created_at), rulesSource: String(p.rules_source ?? ""), rulesOtherwise: String(p.rules_otherwise ?? ""),
      })),
    });
    await tx.dispute.createMany({ data: all("disputes").map((d) => ({ id: d.id as number, marketId: d.market_id as number, userId: uid(d.user_id as number)!, reason: String(d.reason), createdAt: need(d.created_at), handledAt: at(d.handled_at) })) });
    await tx.clarification.createMany({ data: all("clarifications").map((c) => ({ id: c.id as number, marketId: c.market_id as number, adminId: uid(c.admin_id as number)!, body: String(c.body), createdAt: need(c.created_at) })) });
    await tx.marketBlock.createMany({ data: all("market_blocks").map((b) => ({ marketId: b.market_id as number, userId: uid(b.user_id as number)!, createdAt: need(b.created_at) })) });
    await tx.tradeBan.createMany({ data: all("trade_bans").map((b) => ({ userId: uid(b.user_id as number)!, createdAt: need(b.created_at) })) });
    // Imported rows carry their own ids, so move every sequence past the highest one.
    for (const table of ["Market", "Outcome", "Trade", "PriceHistory", "Comment", "Proposal", "Dispute", "Clarification"]) {
      await tx.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 0) + 1, false)`);
    }
  }, { timeout: 300000, maxWait: 30000 });

  console.log(`Imported ${users.length} users, ${all("markets").length} markets, ${all("trades").length} trades.`);
  console.log("Nobody can log in yet. Set the owner's password with:  pnpm reset-password <owner username>");
  old.close();
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
