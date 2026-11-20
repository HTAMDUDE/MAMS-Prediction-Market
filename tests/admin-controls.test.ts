import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { setEmailTransport, type Email } from "@/lib/email";
import { deleteUser, listUsers, markEmailVerified, resendVerification, updateUserEmail, USER_PAGE_SIZE } from "@/server/services/accounts";
import { listAudit, logAudit } from "@/server/services/audit";
import { deleteComment, loadComments, setCommentHidden, toggleCommentMute, HIDDEN_PLACEHOLDER } from "@/server/services/comments";
import { addClarification, addComment, closeMarketEarly, reopenMarket, setFeatured, marketState } from "@/server/services/markets";
import { grantBalance, toggleAdmin, toggleTradingBan } from "@/server/services/moderation";
import { actorFor } from "@/server/services/permissions";
import { addDispute, confirmResult, proposeResult } from "@/server/services/resolution";
import { getAnnouncement, setAnnouncement, ANNOUNCEMENT_MAX } from "@/server/services/settings";
import { executeTrade } from "@/server/services/trading";
import { balanceOf, closeMarket, hours, makeActor, makeMarket, makeUser, resetDb } from "./helpers";

let outbox: Email[] = [];
beforeEach(async () => {
  await resetDb();
  outbox = [];
  setEmailTransport(async (e) => void outbox.push(e));
});
afterEach(() => setEmailTransport(null));

/** owner (first account), an admin helper, and a regular user */
async function cast() {
  const owner = await makeActor("owner");
  const helper = await makeActor("helper", { isAdmin: true });
  const kid = await makeUser("kid");
  return { owner, helper, kid };
}
const actions = async () => (await prisma.auditLog.findMany({ orderBy: { id: "asc" } })).map((a) => a.action);

describe("user management", () => {
  it("searches by username or email, filters, and paginates", async () => {
    const { owner } = await cast();
    await prisma.user.update({ where: { id: (await prisma.user.findUniqueOrThrow({ where: { username: "kid" } })).id }, data: { email: "kiddo@school.org", emailVerified: false } });
    const user = await prisma.user.findUniqueOrThrow({ where: { username: "kid" } });
    await prisma.tradeBan.create({ data: { userId: user.id } });

    expect((await listUsers(owner.actor, { q: "KIDDO@" })).rows.map((r) => r.username)).toEqual(["kid"]); // email, any case
    expect((await listUsers(owner.actor, { q: "hel" })).rows.map((r) => r.username)).toEqual(["helper"]);
    expect((await listUsers(owner.actor, { filter: "banned" })).rows.map((r) => r.username)).toEqual(["kid"]);
    expect((await listUsers(owner.actor, { filter: "unverified" })).rows.map((r) => r.username)).toContain("kid");
    expect((await listUsers(owner.actor, { filter: "admins" })).rows.map((r) => r.username).sort()).toEqual(["helper", "owner"]);
    expect((await listUsers(owner.actor, { filter: "nonsense" })).total).toBe(3); // unknown filter = all

    for (let i = 0; i < 30; i++) await makeUser(`u${String(i).padStart(2, "0")}`);
    const p1 = await listUsers(owner.actor, { page: 1 });
    const p2 = await listUsers(owner.actor, { page: 2 });
    expect([p1.rows.length, p1.total, p1.pages]).toEqual([USER_PAGE_SIZE, 33, 2]);
    expect(p2.rows).toHaveLength(8);
    expect(new Set([...p1.rows, ...p2.rows].map((r) => r.id)).size).toBe(33);
  });

  it("only admins can list users", async () => {
    const { kid } = await cast();
    await expect(listUsers(await actorFor(kid.id))).rejects.toThrow();
  });

  it("changing an email un-verifies it, mails the new address and is audited", async () => {
    const { helper, kid } = await cast();
    await updateUserEmail(helper.actor, kid.id, "  New.Kid@Example.com ");
    const u = await prisma.user.findUniqueOrThrow({ where: { id: kid.id } });
    expect([u.email, u.emailVerified]).toEqual(["new.kid@example.com", false]);
    expect(outbox.map((m) => m.to)).toEqual(["new.kid@example.com"]);
    expect(outbox[0].text).toContain("/api/auth/verify-email");
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "user.email_change" } });
    expect([log.actorName, log.targetLabel]).toEqual(["helper", "kid"]);
    expect(log.detail).toContain("→ new.kid@example.com");
  });

  it("rejects bad, duplicate, placeholder and unchanged emails", async () => {
    const { helper, kid } = await cast();
    const eve = await makeUser("eve");
    await expect(updateUserEmail(helper.actor, kid.id, "nope")).rejects.toThrow(/valid email/);
    await expect(updateUserEmail(helper.actor, kid.id, "x@users.mams.invalid")).rejects.toThrow(/real email/);
    await updateUserEmail(helper.actor, kid.id, "shared@example.com");
    await expect(updateUserEmail(helper.actor, eve.id, "SHARED@example.com")).rejects.toThrow(/Another account/); // taken (any case)
    await expect(updateUserEmail(helper.actor, kid.id, "shared@example.com")).rejects.toThrow(/already their email/);
    expect(await prisma.auditLog.count({ where: { action: "user.email_change" } })).toBe(1); // failures are not logged
  });

  it("admins can't edit the owner or other admins; the owner can", async () => {
    const { owner, helper } = await cast();
    await expect(updateUserEmail(helper.actor, owner.id, "evil@example.com")).rejects.toThrow(/site owner/);
    await expect(markEmailVerified(helper.actor, owner.id)).rejects.toThrow(/site owner/);
    await expect(updateUserEmail(owner.actor, helper.id, "helper@example.com")).resolves.toBe("helper@example.com");
  });

  it("marks an email verified, and resends only when it makes sense", async () => {
    const { helper, kid } = await cast();
    await prisma.user.update({ where: { id: kid.id }, data: { emailVerified: false, email: "kid@example.com" } });
    await resendVerification(helper.actor, kid.id);
    expect(outbox.map((m) => m.to)).toEqual(["kid@example.com"]);

    await markEmailVerified(helper.actor, kid.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: kid.id } })).emailVerified).toBe(true);
    await expect(markEmailVerified(helper.actor, kid.id)).rejects.toThrow(/already verified/);
    await expect(resendVerification(helper.actor, kid.id)).rejects.toThrow(/already verified/);

    const legacy = await makeUser("legacy");
    await prisma.user.update({ where: { id: legacy.id }, data: { emailVerified: false } }); // placeholder email
    await expect(resendVerification(helper.actor, legacy.id)).rejects.toThrow(/no real email/);
    expect(outbox).toHaveLength(1);
    expect(await actions()).toEqual(["user.resend_verification", "user.verify"]);
  });

  it("deletes an account: bets are reversed, prices restored, everything of theirs goes", async () => {
    const { helper } = await cast();
    const eve = await makeUser("eve");
    const fay = await makeUser("fay");
    const { id: mid, outs } = await makeMarket({ labels: ["Yes", "No"], b: 100 });
    await executeTrade(fay.id, mid, outs[0], "buy", 100);
    const faySharesOnly = (await prisma.outcome.findUniqueOrThrow({ where: { id: outs[0] } })).shares;
    await executeTrade(eve.id, mid, outs[0], "buy", 200);
    await prisma.comment.create({ data: { marketId: mid, userId: eve.id, body: "hello" } });
    await prisma.session.create({ data: { id: "s1", token: "t1", userId: eve.id, expiresAt: hours(5) } });
    const historyBefore = await prisma.priceHistory.count({ where: { marketId: mid } });

    const r = await deleteUser(helper.actor, eve.id);
    expect(r.username).toBe("eve");
    expect(await prisma.user.count({ where: { id: eve.id } })).toBe(0);
    expect(await prisma.session.count({ where: { userId: eve.id } })).toBe(0);
    expect(await prisma.comment.count({ where: { userId: eve.id } })).toBe(0);
    expect(await prisma.trade.count({ where: { userId: eve.id } })).toBe(0);
    expect((await prisma.outcome.findUniqueOrThrow({ where: { id: outs[0] } })).shares).toBeCloseTo(faySharesOnly); // her shares left the market
    expect(await prisma.priceHistory.count({ where: { marketId: mid } })).toBe(historyBefore + 1); // price chart records the restore
    expect(await balanceOf(fay.id)).toBeCloseTo(900); // other traders untouched
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "user.delete" } });
    expect([log.actorName, log.targetLabel]).toEqual(["helper", "eve"]); // names kept after the account is gone
  });

  it("won't delete yourself, the owner or an admin, and admins can't delete other admins", async () => {
    const { owner, helper, kid } = await cast();
    await expect(deleteUser(helper.actor, helper.id)).rejects.toThrow(/your own account/);
    await expect(deleteUser(helper.actor, owner.id)).rejects.toThrow(/owner's account/);
    await expect(deleteUser(owner.actor, owner.id)).rejects.toThrow(/own account/);
    await expect(deleteUser(owner.actor, helper.id)).rejects.toThrow(/Remove their admin role/);
    const other = await makeActor("other", { isAdmin: true });
    await expect(deleteUser(helper.actor, other.id)).rejects.toThrow(/site owner/);
    await expect(deleteUser(await actorFor(kid.id), other.id)).rejects.toThrow(); // not an admin
    expect(await prisma.user.count()).toBe(4);
    expect(await prisma.auditLog.count()).toBe(0);

    await toggleAdmin(owner.actor, helper.id); // demote, then deletion is allowed for the owner
    await deleteUser(owner.actor, helper.id);
    expect(await prisma.user.count({ where: { id: helper.id } })).toBe(0);
  });

  it("won't delete a user whose open dispute is holding a result (it would auto-finalize and pay out)", async () => {
    const { helper, kid } = await cast();
    const { id: mid, outs } = await makeMarket({ labels: ["Yes", "No"] });
    await executeTrade(kid.id, mid, outs[0], "buy", 50);
    await closeMarket(mid);
    await proposeResult(helper.actor, mid, outs[1]);
    await addDispute(kid.id, mid, "The official page says Yes won");

    await expect(deleteUser(helper.actor, kid.id)).rejects.toThrow(/open dispute/);
    expect(await prisma.user.count({ where: { id: kid.id } })).toBe(1);
    expect(await prisma.dispute.count({ where: { userId: kid.id, handledAt: null } })).toBe(1); // still pausing the result

    await confirmResult(helper.actor, mid); // an admin settles it; the dispute is now handled
    await deleteUser(helper.actor, kid.id);
    expect(await prisma.user.count({ where: { id: kid.id } })).toBe(0);
  });

  it("a deleted admin's clarifications stay on the market", async () => {
    const { owner, helper } = await cast();
    const { id: mid } = await makeMarket();
    await addClarification(helper.actor, mid, "Half days count.");
    await toggleAdmin(owner.actor, helper.id);
    await deleteUser(owner.actor, helper.id);
    const c = await prisma.clarification.findMany({ where: { marketId: mid } });
    expect(c.map((x) => [x.body, x.adminId])).toEqual([["Half days count.", null]]);
  });
});

describe("comment moderation", () => {
  async function commentBy(userId: string, marketId: number, body = "a comment") {
    return prisma.comment.create({ data: { marketId, userId, body } });
  }

  it("hidden comments show their text only to admins; unhide restores them", async () => {
    const { helper, kid } = await cast();
    const { id: mid } = await makeMarket();
    const c = await commentBy(kid.id, mid, "spoiler: the answer is Yes");
    await setCommentHidden(helper.actor, c.id, true);

    const asUser = await loadComments(mid, false);
    expect(asUser[0]).toMatchObject({ hidden: true, body: null });
    expect(JSON.stringify(asUser)).not.toContain("spoiler"); // the text never leaves the server
    expect((await loadComments(mid, true))[0]).toMatchObject({ hidden: true, body: "spoiler: the answer is Yes" });
    expect(HIDDEN_PLACEHOLDER).toMatch(/hidden/);

    await setCommentHidden(helper.actor, c.id, false);
    expect((await loadComments(mid, false))[0].body).toBe("spoiler: the answer is Yes");
    expect(await actions()).toEqual(["comment.hide", "comment.unhide"]);
  });

  it("deletes comments, with the same permission rules as people", async () => {
    const { owner, helper, kid } = await cast();
    const { id: mid } = await makeMarket();
    const byKid = await commentBy(kid.id, mid);
    const byOwner = await commentBy(owner.id, mid);
    const byHelper = await commentBy(helper.id, mid);

    await expect(deleteComment(helper.actor, byOwner.id)).rejects.toThrow(/site owner/);
    await expect(setCommentHidden(helper.actor, byOwner.id, true)).rejects.toThrow(/site owner/);
    await expect(deleteComment(await actorFor(kid.id), byKid.id)).rejects.toThrow(); // not an admin
    await deleteComment(helper.actor, byKid.id);
    await deleteComment(helper.actor, byHelper.id); // an admin may remove their own
    await deleteComment(owner.actor, byOwner.id);
    expect(await prisma.comment.count()).toBe(0);
    await expect(deleteComment(owner.actor, byKid.id)).rejects.toThrow(/no longer exists/);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: "comment.delete", targetLabel: "kid" } })).detail).toContain("a comment");
  });

  it("muting stops commenting but not trading, and can be undone", async () => {
    const { owner, helper, kid } = await cast();
    const { id: mid, outs } = await makeMarket();
    await addComment(kid.id, mid, "fine");
    expect(await toggleCommentMute(helper.actor, kid.id)).toEqual({ muted: true, username: "kid" });
    await expect(addComment(kid.id, mid, "again")).rejects.toThrow(/turned off commenting/);
    await executeTrade(kid.id, mid, outs[0], "buy", 10); // trading is separate
    expect(await toggleCommentMute(helper.actor, kid.id)).toEqual({ muted: false, username: "kid" });
    await addComment(kid.id, mid, "back");
    expect(await prisma.comment.count({ where: { userId: kid.id } })).toBe(2);

    await expect(toggleCommentMute(helper.actor, owner.id)).rejects.toThrow(/site owner/);
    await expect(toggleCommentMute(owner.actor, owner.id)).rejects.toThrow(/owner can't be muted/);
    await expect(toggleCommentMute(await actorFor(kid.id), helper.id)).rejects.toThrow();
  });
});

describe("market controls", () => {
  it("closes betting early", async () => {
    const { helper, kid } = await cast();
    const { id, outs } = await makeMarket({ labels: ["Yes", "No"] });
    await executeTrade(kid.id, id, outs[0], "buy", 10);
    await closeMarketEarly(helper.actor, id);
    expect(marketState(await prisma.market.findUniqueOrThrow({ where: { id } }))).toBe("closed");
    await expect(executeTrade(kid.id, id, outs[0], "buy", 10)).rejects.toThrow(/no longer accepting/);
    await expect(closeMarketEarly(helper.actor, id)).rejects.toThrow(/already closed/);
    await expect(proposeResult(helper.actor, id, outs[0])).resolves.toBeUndefined(); // a result can now be proposed
    await expect(closeMarketEarly(await actorFor(kid.id), id)).rejects.toThrow();
  });

  it("reopens a closed market only when that is safe", async () => {
    const { helper, kid } = await cast();
    const { id, outs } = await makeMarket({ labels: ["Yes", "No"] });
    await expect(reopenMarket(helper.actor, id, hours(48))).rejects.toThrow(/still open/);

    await closeMarket(id);
    await expect(reopenMarket(helper.actor, id, hours(-1))).rejects.toThrow(/future/);
    await reopenMarket(helper.actor, id, hours(48));
    expect(marketState(await prisma.market.findUniqueOrThrow({ where: { id } }))).toBe("open");
    await executeTrade(kid.id, id, outs[0], "buy", 10); // betting works again

    await closeMarket(id);
    await proposeResult(helper.actor, id, outs[0]);
    await expect(reopenMarket(helper.actor, id, hours(48))).rejects.toThrow(/Withdraw it/);
    expect(await actions()).toEqual(["market.reopen", "result.propose"]);
  });

  it("features and unfeatures markets", async () => {
    const { helper, kid } = await cast();
    const { id } = await makeMarket({ question: "Star?" });
    await setFeatured(helper.actor, id, true);
    expect((await prisma.market.findUniqueOrThrow({ where: { id } })).featured).toBe(true);
    await setFeatured(helper.actor, id, false);
    expect((await prisma.market.findUniqueOrThrow({ where: { id } })).featured).toBe(false);
    await expect(setFeatured(await actorFor(kid.id), id, true)).rejects.toThrow();
    await expect(setFeatured(helper.actor, 99999, true)).rejects.toThrow(/not found/);
    expect(await actions()).toEqual(["market.feature", "market.unfeature"]);
  });

  it("sets, reads, clears and limits the announcement", async () => {
    const { helper, kid } = await cast();
    expect(await getAnnouncement()).toBeNull();
    expect(await setAnnouncement(helper.actor, "  No school Monday!  ")).toBe("No school Monday!");
    expect(await getAnnouncement()).toBe("No school Monday!");
    await setAnnouncement(helper.actor, "Updated");
    expect(await getAnnouncement()).toBe("Updated");
    await expect(setAnnouncement(helper.actor, "x".repeat(ANNOUNCEMENT_MAX + 1))).rejects.toThrow(/under 300/);
    await expect(setAnnouncement(await actorFor(kid.id), "hi")).rejects.toThrow();
    expect(await setAnnouncement(helper.actor, "   ")).toBeNull();
    expect(await getAnnouncement()).toBeNull();
    expect((await prisma.auditLog.findMany({ orderBy: { id: "asc" } })).map((a) => a.detail)).toEqual(["No school Monday!", "Updated", "(cleared)"]);
  });
});

describe("audit log", () => {
  it("records who did what for existing admin actions, and nothing for failed attempts", async () => {
    const { owner, helper, kid } = await cast();
    await grantBalance(helper.actor, kid.id, 50);
    await toggleTradingBan(helper.actor, kid.id);
    await toggleTradingBan(helper.actor, kid.id);
    await expect(grantBalance(helper.actor, owner.id, 10)).rejects.toThrow(); // not allowed: not logged
    const rows = await prisma.auditLog.findMany({ orderBy: { id: "asc" } });
    expect(rows.map((r) => [r.actorName, r.action, r.targetLabel, r.detail])).toEqual([
      ["helper", "user.grant", "kid", "+Ⓜ50.00"],
      ["helper", "user.ban", "kid", ""],
      ["helper", "user.unban", "kid", ""],
    ]);
    expect(rows[0]).toMatchObject({ actorId: helper.id, targetType: "user", targetId: kid.id });
  });

  it("lists newest first, searches, paginates and is admin-only", async () => {
    const { helper, kid } = await cast();
    for (let i = 0; i < 55; i++) await logAudit(helper.actor, "user.grant", { targetType: "user", targetLabel: i === 3 ? "needle" : "kid", detail: `n${i}` });
    const p1 = await listAudit(helper.actor);
    expect([p1.rows.length, p1.total, p1.pages, p1.page]).toEqual([50, 55, 2, 1]);
    expect(p1.rows[0].detail).toBe("n54"); // newest first
    expect((await listAudit(helper.actor, { page: 2 })).rows.map((r) => r.detail)).toEqual(["n4", "n3", "n2", "n1", "n0"]);
    expect((await listAudit(helper.actor, { q: "NEEDLE" })).rows.map((r) => r.detail)).toEqual(["n3"]);
    expect((await listAudit(helper.actor, { q: "helper" })).total).toBe(55); // actor name
    expect((await listAudit(helper.actor, { q: "grant" })).total).toBe(55); // action key
    expect((await listAudit(helper.actor, { q: "zzz" })).total).toBe(0);
    await expect(listAudit(await actorFor(kid.id))).rejects.toThrow();
  });
});
