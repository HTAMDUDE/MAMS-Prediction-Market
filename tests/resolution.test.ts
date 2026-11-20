import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { marketState } from "@/server/services/markets";
import { cancelMarket } from "@/server/services/markets";
import { deleteUser } from "@/server/services/accounts";
import { addDispute, confirmResult, finalizeDue, finalizeDueWithNext, proposeResult, retractResult } from "@/server/services/resolution";
import { executeTrade } from "@/server/services/trading";
import { balanceOf, closeMarket, hours, makeActor, makeMarket, makeUser, resetDb, RULES, sharesHeld } from "./helpers";

beforeEach(resetDb);

/** A Yes/No market past its close date where bob holds Yes. */
async function closedMarketWithBet() {
  const admin = await makeActor("chief");
  const bob = await makeUser("bob");
  const eve = await makeUser("eve"); // never trades
  const { id, outs } = await makeMarket({ labels: ["Yes", "No"], b: 100, description: RULES });
  const [yes, no] = outs;
  await executeTrade(bob.id, id, yes, "buy", 100);
  await closeMarket(id);
  return { admin, bob, eve, id, yes, no };
}

const pastWindow = (id: number) => prisma.market.update({ where: { id }, data: { finalizesAt: hours(-1) } });
const status = async (id: number) => (await prisma.market.findUniqueOrThrow({ where: { id } })).status;

describe("optimistic resolution", () => {
  it("an undisputed result finalizes once and pays winners", async () => {
    const { admin, bob, id, yes } = await closedMarketWithBet();
    const shares = await sharesHeld(bob.id, yes);
    await proposeResult(admin.actor, id, yes);
    let m = await prisma.market.findUniqueOrThrow({ where: { id } });
    expect(m.status).toBe("open");
    expect(m.proposedOutcomeId).toBe(yes);
    expect(m.finalizesAt!.getTime()).toBeGreaterThan(Date.now());
    expect(marketState(m)).toBe("proposed");

    await finalizeDue(); // window still running: nothing happens
    expect(await status(id)).toBe("open");

    await pastWindow(id);
    await finalizeDue();
    await finalizeDue(); // a second pass must not pay again
    m = await prisma.market.findUniqueOrThrow({ where: { id } });
    expect([m.status, m.resolvedOutcomeId]).toEqual(["resolved", yes]);
    expect(m.resolvedById).toBe(admin.id);
    expect(Math.abs((await balanceOf(bob.id)) - (900 + shares))).toBeLessThan(0.01);
  });

  it("finalizeDueWithNext reports when the next window ends, so callers can skip checking until then", async () => {
    const { admin, id, yes } = await closedMarketWithBet();
    expect(await finalizeDueWithNext()).toEqual({ done: 0, next: null });
    await proposeResult(admin.actor, id, yes);
    const m = await prisma.market.findUniqueOrThrow({ where: { id } });
    expect(await finalizeDueWithNext()).toEqual({ done: 0, next: m.finalizesAt });
    await pastWindow(id);
    expect(await finalizeDueWithNext()).toEqual({ done: 1, next: null });
  });

  it("a dispute pauses finalizing; admin can change the outcome or confirm", async () => {
    const { admin, bob, eve, id, yes, no } = await closedMarketWithBet();
    await proposeResult(admin.actor, id, no);

    await expect(addDispute(eve.id, id, "I think it is wrong")).rejects.toThrow(/Only people who traded/);
    await expect(addDispute(bob.id, id, "no")).rejects.toThrow(/Explain the problem/);
    await addDispute(bob.id, id, "Official page says Yes won");
    await expect(addDispute(bob.id, id, "Official page says Yes won")).rejects.toThrow(/already disputed/);
    expect(await prisma.dispute.count()).toBe(1);

    await pastWindow(id);
    await finalizeDue(); // window ended but the dispute keeps it from finalizing
    expect(await status(id)).toBe("open");

    // an ordinary user can't use admin actions
    await expect(confirmResult({ id: bob.id, isAdmin: false, isOwner: false }, id)).rejects.toThrow();

    // admin changes the outcome: window restarts, dispute handled, still unpaid
    await proposeResult(admin.actor, id, yes);
    const m = await prisma.market.findUniqueOrThrow({ where: { id } });
    expect(m.proposedOutcomeId).toBe(yes);
    expect(m.finalizesAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await prisma.dispute.count({ where: { handledAt: null } })).toBe(0);
    expect(await balanceOf(bob.id)).toBeCloseTo(900);

    // a new dispute can be confirmed straight away
    await addDispute(bob.id, id, "Still looks wrong to me");
    await confirmResult(admin.actor, id);
    expect(await status(id)).toBe("resolved");
    expect(await balanceOf(bob.id)).toBeGreaterThan(900);
  });

  it("confirm needs a dispute, and retract removes the proposal", async () => {
    const { admin, id, yes } = await closedMarketWithBet();
    await proposeResult(admin.actor, id, yes);
    await expect(confirmResult(admin.actor, id)).rejects.toThrow(/Only a disputed result/);
    expect(await status(id)).toBe("open");

    await retractResult(admin.actor, id);
    const m = await prisma.market.findUniqueOrThrow({ where: { id } });
    expect(m.proposedOutcomeId).toBeNull();
    expect(m.finalizesAt).toBeNull();
    expect(marketState(m)).toBe("closed");
    await finalizeDue();
    expect(await status(id)).toBe("open");
  });
  it("cancelling a disputed market settles the dispute and clears the proposal", async () => {
    const { admin, bob, id, no } = await closedMarketWithBet();
    await proposeResult(admin.actor, id, no);
    await addDispute(bob.id, id, "Official page says Yes won");
    await cancelMarket(admin.actor, id);
    const m = await prisma.market.findUniqueOrThrow({ where: { id } });
    expect([m.status, m.proposedOutcomeId, m.finalizesAt]).toEqual(["cancelled", null, null]);
    expect(await prisma.dispute.count({ where: { handledAt: null } })).toBe(0);
    await deleteUser(admin.actor, bob.id); // no longer blocked by an open dispute
    expect(await prisma.user.findUnique({ where: { id: bob.id } })).toBeNull();
  });
});
