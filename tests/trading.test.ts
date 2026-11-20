import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { marketB, presetFor } from "@/lib/constants";
import { cancelMarket, createMarketAsAdmin, deleteMarket } from "@/server/services/markets";
import { blockUserInMarket } from "@/server/services/moderation";
import { netWorths } from "@/server/services/portfolio";
import { executeTrade, quoteTrade } from "@/server/services/trading";
import { TradeError } from "@/server/services/permissions";
import { balanceOf, closeMarket, hours, makeActor, makeMarket, makeUser, resetDb, sharesHeld } from "./helpers";
import { proposeResult } from "@/server/services/resolution";

beforeEach(resetDb);

describe("trading flow", () => {
  it("admin creates a market, a user bets, cannot overspend, and gets quotes", async () => {
    const admin = await makeActor("teacher"); // first user is the owner/admin
    const bob = await makeActor("bob");
    expect(admin.actor.isAdmin).toBe(true);
    expect(bob.actor.isAdmin).toBe(false);

    const mid = await createMarketAsAdmin(admin.actor, {
      question: "Snow day?", description: "Resolves YES if the school announces a snow day.", category: "Weather",
      closesAt: hours(72), labels: ["Yes", "No"], b: 300, rulesSource: "Principal's email", rulesOtherwise: "",
    });
    const [yes, no] = (await prisma.outcome.findMany({ where: { marketId: mid }, orderBy: { position: "asc" } })).map((o) => o.id);

    const msg = await executeTrade(bob.id, mid, yes, "buy", 100);
    expect(msg).toContain("Bought");
    expect(await balanceOf(bob.id)).toBeCloseTo(900);
    const shares = await sharesHeld(bob.id, yes);
    expect(shares).toBeGreaterThan(100); // bought below 1 coin/share

    await expect(executeTrade(bob.id, mid, no, "buy", 5000)).rejects.toThrow(/enough/);
    const q = await quoteTrade(bob.id, mid, no, "buy", 10);
    expect(q.shares).toBeGreaterThan(10);

    await expect(proposeResult(admin.actor, mid, yes)).rejects.toThrow(/closed yet/);
  });

  it("cancel refunds net spend (including after a partial sell)", async () => {
    const cara = await makeUser("cara");
    const { id: mid, outs } = await makeMarket({ labels: ["A", "B", "C"], b: 50 });
    await executeTrade(cara.id, mid, outs[1], "buy", 200);
    const held = await sharesHeld(cara.id, outs[1]);
    await executeTrade(cara.id, mid, outs[1], "sell", held / 2);
    const admin = await makeActor("boss", { isAdmin: true });
    await cancelMarket(admin.actor, mid);
    expect(Math.abs((await balanceOf(cara.id)) - 1000)).toBeLessThan(0.02);
  });

  it("delete refunds, removes everything, and copes with blocks/disputes", async () => {
    const dan = await makeUser("dan");
    const fay = await makeUser("fay");
    const admin = await makeActor("boss", { isAdmin: true });
    const { id: mid, outs } = await makeMarket({ labels: ["Yes", "No"], b: 100 });
    await executeTrade(dan.id, mid, outs[0], "buy", 300);
    await blockUserInMarket(admin.actor, mid, "fay");
    await prisma.clarification.create({ data: { marketId: mid, adminId: admin.id, body: "note here" } });
    await deleteMarket(admin.actor, mid);
    expect(await balanceOf(dan.id)).toBeCloseTo(1000);
    expect(await prisma.market.count({ where: { id: mid } })).toBe(0);
    expect(await prisma.position.count({ where: { userId: dan.id } })).toBe(0);
    expect(await prisma.marketBlock.count()).toBe(0);
    expect(fay.id).toBeTruthy();
  });

  it("non-admins cannot create, cancel or delete markets", async () => {
    await makeActor("owner");
    const kid = await makeActor("kid");
    const { id: mid } = await makeMarket();
    await expect(cancelMarket(kid.actor, mid)).rejects.toThrow(TradeError);
    await expect(deleteMarket(kid.actor, mid)).rejects.toThrow(TradeError);
  });

  it("no trading after the market closes or resolves", async () => {
    const u = await makeUser("late");
    const { id: mid, outs } = await makeMarket();
    await closeMarket(mid);
    await expect(executeTrade(u.id, mid, outs[0], "buy", 10)).rejects.toThrow(/no longer accepting/);
  });
});

describe("pricing audit regressions", () => {
  it("buying does not inflate net worth", async () => {
    const u = await makeUser("buyer");
    const { id: mid, outs } = await makeMarket({ n: 2, b: 100 });
    await executeTrade(u.id, mid, outs[0], "buy", 100);
    expect(Math.abs((await netWorths()).get(u.id)! - 1000)).toBeLessThan(0.02);
  });

  it("holding both sides is worth its cost", async () => {
    const u = await makeUser("hedger");
    const { id: mid, outs } = await makeMarket({ n: 2, b: 50 });
    await executeTrade(u.id, mid, outs[0], "buy", 400);
    await executeTrade(u.id, mid, outs[1], "buy", 400);
    expect(Math.abs((await netWorths()).get(u.id)! - 1000)).toBeLessThan(0.05);
  });

  it("market b scales with the number of outcomes", () => {
    expect(marketB("medium", 2)).toBe(300);
    expect(marketB("medium", 8)).toBe(900);
    expect(marketB("bogus", 2)).toBe(300);
    expect(presetFor(900, 8)).toBe("medium");
    expect(presetFor(50, 2)).toBe("low"); // old-style markets map to the nearest preset
  });
});

describe("quote matches trade", () => {
  it("quotes equal what trades then do, and report errors", async () => {
    const u = await makeUser("quoter");
    const { id: mid, outs } = await makeMarket({ n: 2, b: 100 });
    const [yes] = outs;
    await expect(quoteTrade(u.id, mid, yes, "buy", 0.5)).rejects.toThrow(/Minimum bet/);
    await expect(quoteTrade(u.id, mid, yes, "buy", 5000)).rejects.toThrow(/enough/);
    await expect(quoteTrade(u.id, mid, yes, "sell", 5)).rejects.toThrow(/only own/);

    const q = await quoteTrade(u.id, mid, yes, "buy", 100);
    const bal0 = await balanceOf(u.id);
    await executeTrade(u.id, mid, yes, "buy", 100);
    const held = await sharesHeld(u.id, yes);
    expect(Math.abs(held - q.shares)).toBeLessThan(1e-3);
    expect(await balanceOf(u.id)).toBeCloseTo(bal0 - q.coins);

    const sq = await quoteTrade(u.id, mid, yes, "sell", held);
    const before = await balanceOf(u.id);
    await executeTrade(u.id, mid, yes, "sell", held);
    expect(Math.abs((await balanceOf(u.id)) - before - sq.coins)).toBeLessThan(0.01);

    // blocked users see the reason; logged-out visitors still get a price preview
    await prisma.marketBlock.create({ data: { marketId: mid, userId: u.id } });
    await expect(quoteTrade(u.id, mid, yes, "buy", 10)).rejects.toThrow(/blocked/);
    expect((await quoteTrade(null, mid, yes, "buy", 10)).shares).toBeGreaterThan(0);
  });
});
