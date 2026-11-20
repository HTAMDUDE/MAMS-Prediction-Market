import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { adminUsernames } from "@/lib/constants";
import { readMarketForm } from "@/lib/validation";
import { addClarification, editMarket, type EditMarketInput } from "@/server/services/markets";
import { blockUserInMarket, grantBalance, toggleAdmin, toggleTradingBan, unblockUserInMarket } from "@/server/services/moderation";
import { approveProposal, createProposal, myProposals, rejectProposal, withdrawProposal } from "@/server/services/proposals";
import { actorFor, startsAsAdmin } from "@/server/services/permissions";
import { executeTrade } from "@/server/services/trading";
import { balanceOf, hours, makeActor, makeMarket, makeUser, resetDb, RULES, sharesHeld } from "./helpers";

beforeEach(resetDb);

const editInput = (over: Partial<EditMarketInput> = {}): EditMarketInput => ({
  question: "New?", category: "Sports", closesAt: hours(200), description: "d", rulesSource: "", rulesOtherwise: "",
  liquidity: "high", labels: ["A", "B", "C"], renames: {}, ...over,
});

describe("admin edit", () => {
  it("replaces outcomes and liquidity before bets; renames only afterwards", async () => {
    const admin = await makeActor("editor");
    const bettor = await makeUser("bettor");
    const { id } = await makeMarket({ labels: ["Yes", "No"], b: 100, question: "Old?" });
    await editMarket(admin.actor, id, editInput());
    let m = await prisma.market.findUniqueOrThrow({ where: { id }, include: { outcomes: { orderBy: { position: "asc" } } } });
    expect([m.question, m.category]).toEqual(["New?", "Sports"]);
    expect(m.b).toBeCloseTo(600 * 1.5849625007); // "high", 3 outcomes
    expect(m.outcomes.map((o) => o.label)).toEqual(["A", "B", "C"]);

    await executeTrade(bettor.id, id, m.outcomes[0].id, "buy", 50);
    await editMarket(admin.actor, id, editInput({
      liquidity: "low", labels: ["X", "Y"], renames: { [m.outcomes[0].id]: "Alpha", [m.outcomes[1].id]: "B", [m.outcomes[2].id]: "C" },
    }));
    m = await prisma.market.findUniqueOrThrow({ where: { id }, include: { outcomes: { orderBy: { position: "asc" } } } });
    expect(m.outcomes.map((o) => o.label)).toEqual(["Alpha", "B", "C"]);
    expect(m.b).toBeCloseTo(600 * 1.5849625007); // liquidity locked
    expect(await prisma.position.count({ where: { userId: bettor.id } })).toBe(1);
  });

  it("only admins can edit", async () => {
    await makeActor("first");
    const kid = await makeActor("kid");
    const { id } = await makeMarket();
    await expect(editMarket(kid.actor, id, editInput())).rejects.toThrow();
  });

  it("locks the written rules after the first bet; clarifications add notes", async () => {
    const admin = await makeActor("ruler");
    const better = await makeUser("better");
    const { id, outs } = await makeMarket({ labels: ["Yes", "No"], b: 100, description: RULES });
    await editMarket(admin.actor, id, editInput({
      labels: ["Yes", "No"], description: "Resolves YES if it rains on Tuesday.", rulesSource: "Weather app", rulesOtherwise: "", liquidity: "medium",
    }));
    let m = await prisma.market.findUniqueOrThrow({ where: { id } });
    expect([m.description, m.rulesSource, m.rulesOtherwise]).toEqual(["Resolves YES if it rains on Tuesday.", "Weather app", ""]);

    await executeTrade(better.id, id, outs[0], "buy", 10);
    await editMarket(admin.actor, id, editInput({
      labels: ["Yes", "No"], description: "Totally different rules now!!", rulesSource: "Other", rulesOtherwise: "Changed",
      renames: { [outs[0]]: "Yes", [outs[1]]: "No" },
    }));
    m = await prisma.market.findUniqueOrThrow({ where: { id } });
    expect([m.description, m.rulesSource]).toEqual(["Resolves YES if it rains on Tuesday.", "Weather app"]);

    await addClarification(admin.actor, id, "Drizzle counts as rain.");
    await expect(addClarification(admin.actor, id, "x")).rejects.toThrow(/5–500/);
    expect((await prisma.clarification.findMany({ where: { marketId: id } })).map((c) => c.body)).toEqual(["Drizzle counts as rain."]);
  });

  it("can't move the close later while a result is proposed", async () => {
    const admin = await makeActor("a");
    const { id } = await makeMarket({ labels: ["Yes", "No"] });
    await prisma.market.update({ where: { id }, data: { closesAt: hours(-1), proposedOutcomeId: 1 } });
    await expect(editMarket(admin.actor, id, editInput({ labels: ["Yes", "No"] }))).rejects.toThrow(/Withdraw it/);
  });
});

const proposalFields = (over = {}) => {
  const r = readMarketForm({ kind: "yesno", question: "Will the pep rally have a band?", description: "Resolves YES if a live band plays.", category: "Events", closes_at: "2999-01-01T12:00", ...over });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe("proposals", () => {
  it("proposal → approve (edited) → credited to proposer; approving twice does nothing", async () => {
    const admin = await makeActor("headadmin");
    const sam = await makeUser("sam");
    await createProposal(sam.id, proposalFields());
    const p = (await myProposals(sam.id))[0];
    const { marketId } = await approveProposal(admin.actor, p.id, proposalFields({ question: "Will the pep rally have a live band?", liquidity: "high" }), "Clarified wording");
    const after = await prisma.proposal.findUniqueOrThrow({ where: { id: p.id } });
    expect([after.status, after.marketId, after.reviewNote]).toEqual(["approved", marketId, "Clarified wording"]);
    const m = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
    expect([m.question, m.b, m.createdById]).toEqual(["Will the pep rally have a live band?", 600, sam.id]);
    await expect(approveProposal(admin.actor, p.id, proposalFields(), "")).rejects.toThrow(/already reviewed/);
    expect(await prisma.market.count()).toBe(1);
  });

  it("reject with a note, withdraw, and the five-pending cap", async () => {
    const admin = await makeActor("boss");
    const sam = await makeUser("sam");
    await createProposal(sam.id, proposalFields({ question: "Bad question?" }));
    const bad = (await myProposals(sam.id))[0];
    await rejectProposal(admin.actor, bad.id, "Too vague");
    expect((await prisma.proposal.findUniqueOrThrow({ where: { id: bad.id } })).status).toBe("rejected");

    for (let i = 0; i < 5; i++) await createProposal(sam.id, proposalFields({ question: `Q${i}?` }));
    await expect(createProposal(sam.id, proposalFields({ question: "One too many?" }))).rejects.toThrow(/already have 5/);
    const q0 = (await prisma.proposal.findFirstOrThrow({ where: { question: "Q0?" } })).id;
    await withdrawProposal(sam.id, q0);
    expect(await prisma.proposal.count({ where: { id: q0 } })).toBe(0);
    await expect(withdrawProposal(sam.id, bad.id)).rejects.toThrow(/can't be withdrawn/); // already reviewed
  });

  it("only admins review proposals", async () => {
    await makeActor("first");
    const kid = await makeActor("kid");
    await expect(rejectProposal(kid.actor, 1, "")).rejects.toThrow();
  });

  it("deleting the approved market leaves the proposal intact", async () => {
    const admin = await makeActor("boss");
    const sam = await makeUser("sam");
    await createProposal(sam.id, proposalFields());
    const p = (await myProposals(sam.id))[0];
    const { marketId } = await approveProposal(admin.actor, p.id, proposalFields(), "");
    const { deleteMarket } = await import("@/server/services/markets");
    await deleteMarket(admin.actor, marketId);
    expect((await prisma.proposal.findUniqueOrThrow({ where: { id: p.id } })).marketId).toBeNull();
  });
});

describe("blocking and bans", () => {
  it("per-market block refunds, ban refunds everywhere, and both can be lifted", async () => {
    const admin = await makeActor("boss");
    const eve = await makeUser("eve");
    const fay = await makeUser("fay");
    const m1 = await makeMarket({ labels: ["Yes", "No"], b: 100, question: "M1?" });
    const m2 = await makeMarket({ labels: ["Yes", "No"], b: 100, question: "M2?" });
    await executeTrade(eve.id, m1.id, m1.outs[0], "buy", 200);
    await executeTrade(fay.id, m1.id, m1.outs[0], "buy", 100);
    const faySharesBefore = await sharesHeld(fay.id, m1.outs[0]);

    // per-market block: eve refunded, her shares leave the market, fay untouched
    const r = await blockUserInMarket(admin.actor, m1.id, "eve");
    expect(r.refund).toBeCloseTo(200);
    expect(await balanceOf(eve.id)).toBeCloseTo(1000);
    expect(await prisma.trade.count({ where: { userId: eve.id } })).toBe(0);
    expect((await prisma.outcome.findUniqueOrThrow({ where: { id: m1.outs[0] } })).shares).toBeCloseTo(faySharesBefore);
    expect(await balanceOf(fay.id)).toBeCloseTo(900);
    await expect(executeTrade(eve.id, m1.id, m1.outs[0], "buy", 10)).rejects.toThrow(/blocked you/);
    await executeTrade(eve.id, m2.id, m2.outs[0], "buy", 10); // other markets still fine

    await unblockUserInMarket(admin.actor, m1.id, eve.id);
    await executeTrade(eve.id, m1.id, m1.outs[0], "buy", 10);

    // site-wide ban refunds every open market
    const ban = await toggleTradingBan(admin.actor, eve.id);
    expect(ban.banned).toBe(true);
    expect(await balanceOf(eve.id)).toBeCloseTo(1000);
    await expect(executeTrade(eve.id, m2.id, m2.outs[0], "buy", 10)).rejects.toThrow(/turned off trading/);

    // lift the ban
    expect((await toggleTradingBan(admin.actor, eve.id)).banned).toBe(false);
    await executeTrade(eve.id, m2.id, m2.outs[0], "buy", 10);
  });
});

describe("owner role", () => {
  it("other admins can't override the owner or promote admins", async () => {
    const owner = await makeActor("founder");
    const helper = await makeActor("helper");
    const kid = await makeUser("kid");
    expect(owner.actor.isOwner).toBe(true);

    await toggleAdmin(owner.actor, helper.id);
    const helperActor = await actorFor(helper.id);
    expect(helperActor.isAdmin).toBe(true);

    // helper can't touch the owner in any way
    await expect(toggleAdmin(helperActor, owner.id)).rejects.toThrow(/Only the site owner/);
    await expect(toggleTradingBan(helperActor, owner.id)).rejects.toThrow(/Only the site owner/);
    await expect(grantBalance(helperActor, owner.id, -1000)).rejects.toThrow(/Only the site owner/);
    expect(await balanceOf(owner.id)).toBeCloseTo(1000);
    const { id: mid } = await makeMarket();
    await expect(blockUserInMarket(helperActor, mid, "founder")).rejects.toThrow(/Only the site owner/);
    expect(await prisma.marketBlock.count()).toBe(0);
    // ...nor make new admins
    await expect(toggleAdmin(helperActor, kid.id)).rejects.toThrow(/Only the site owner/);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: kid.id } })).isAdmin).toBe(false);

    // helper CAN manage regular users
    await toggleTradingBan(helperActor, kid.id);
    expect(await prisma.tradeBan.count({ where: { userId: kid.id } })).toBe(1);
    await grantBalance(helperActor, kid.id, 50);
    expect(await balanceOf(kid.id)).toBeCloseTo(1050);
    await grantBalance(helperActor, kid.id, -5000); // never below zero
    expect(await balanceOf(kid.id)).toBe(0);

    // owner can demote the helper; the owner can't be banned, even by themself
    await toggleAdmin(owner.actor, helper.id);
    expect((await actorFor(helper.id)).isAdmin).toBe(false);
    await expect(toggleTradingBan(owner.actor, owner.id)).rejects.toThrow(/owner can't be banned/);
    await expect(toggleAdmin(owner.actor, owner.id)).rejects.toThrow(/own admin/);
  });

  it("the owner can come from MAMS_OWNER, case-insensitively", async () => {
    process.env.MAMS_OWNER = "realowner";
    try {
      await makeUser("earlybird"); // first account, but not the configured owner
      await makeUser("RealOwner");
      expect(await startsAsAdmin("earlybird")).toBe(false);
      expect(await startsAsAdmin("realowner")).toBe(true);
      const real = await prisma.user.findUniqueOrThrow({ where: { username: "realowner" } });
      expect((await actorFor(real.id)).isOwner).toBe(true);
    } finally {
      process.env.MAMS_OWNER = "";
    }
  });

  it("MAMS_ADMINS and the first account start as admins", async () => {
    process.env.MAMS_ADMINS = "Alice, bob";
    try {
      expect([...adminUsernames()]).toEqual(["alice", "bob"]);
      expect(await startsAsAdmin("first")).toBe(true); // no owner configured and no users yet
      await makeUser("first");
      expect(await startsAsAdmin("alice")).toBe(true);
      expect(await startsAsAdmin("carol")).toBe(false);
    } finally {
      process.env.MAMS_ADMINS = "";
    }
  });
});
