"use server";

import { redirect } from "next/navigation";
import { CURRENCY } from "@/lib/constants";
import { requireUser, toActor } from "@/lib/session";
import { amountSchema, clarifySchema, idSchema, readEditForm, readMarketForm } from "@/lib/validation";
import {
  addClarification, cancelMarket, createMarketAsAdmin, deleteMarket, editMarket,
} from "@/server/services/markets";
import {
  blockUserInMarket, grantBalance, toggleAdmin, toggleTradingBan, unblockUserInMarket,
} from "@/server/services/moderation";
import { assertAdmin, canManage, NOT_ALLOWED, TradeError } from "@/server/services/permissions";
import { approveProposal, rejectProposal } from "@/server/services/proposals";
import { confirmResult, proposeResult, retractResult } from "@/server/services/resolution";
import { setTemporaryPassword } from "@/server/password";
import { parseForm, run, setFlash, type ActionState } from "./util";
import { prisma } from "@/lib/db";

const id = (fd: FormData, key: string) => idSchema.parse(fd.get(key));
const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
async function admin() {
  return toActor(await requireUser());
}

// ------------------------------------------------------------------ markets

export async function createMarketAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  let marketId = 0;
  const result = await run(async () => {
    const parsed = readMarketForm(fd);
    if (!parsed.ok) throw new TradeError(parsed.error);
    const { labels, closesAt, ...rest } = parsed.value;
    marketId = await createMarketAsAdmin(await admin(), { ...rest, closesAt, labels });
    return "Market created.";
  });
  if (!result?.ok) return result;
  await setFlash("success", result.message);
  redirect(`/market/${marketId}`);
}

export async function editMarketAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const marketId = id(fd, "market_id");
  const result = await run(async () => {
    const parsed = readEditForm(fd);
    if (!parsed.ok) throw new TradeError(parsed.error);
    await editMarket(await admin(), marketId, parsed.value);
    return "Market updated.";
  });
  if (!result?.ok) return result;
  await setFlash("success", result.message);
  redirect(`/market/${marketId}`);
}

export async function proposeResultAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const outcome = Number(fd.get("outcome_id"));
    if (!Number.isInteger(outcome) || outcome <= 0) throw new TradeError("Pick a winning outcome.");
    await proposeResult(await admin(), id(fd, "market_id"), outcome);
    return "Result proposed. It finalizes in 24 hours unless someone disputes it.";
  });
}

/** Confirm a disputed result right away, or take a proposed result back. */
export async function resultAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const actor = await admin();
    const marketId = id(fd, "market_id");
    if (fd.get("decision") === "retract") {
      await retractResult(actor, marketId);
      return "Proposed result withdrawn. You can propose a different one.";
    }
    const n = await confirmResult(actor, marketId);
    return `Result confirmed. Paid out ${n} winning position(s).`;
  });
}

export async function clarifyAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    await addClarification(await admin(), id(fd, "market_id"), parseForm(clarifySchema, fd).body);
    return "Clarification added to the rules.";
  });
}

export async function cancelAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    await cancelMarket(await admin(), id(fd, "market_id"));
    return "Market cancelled and bets refunded.";
  });
}

export async function deleteAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const result = await run(async () => {
    await deleteMarket(await admin(), id(fd, "market_id"));
    return "Market deleted.";
  });
  if (!result?.ok) return result;
  await setFlash("success", result.message);
  redirect("/admin");
}

export async function blockAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const r = await blockUserInMarket(await admin(), id(fd, "market_id"), String(fd.get("username") ?? ""));
    return `${r.username} can no longer bet on this market.` + (r.refund ? ` Refunded Ⓜ${money(r.refund)} and removed their bets.` : "");
  });
}

export async function unblockAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    await unblockUserInMarket(await admin(), id(fd, "market_id"), String(fd.get("user_id")));
    return "They can bet on this market again.";
  });
}

// ------------------------------------------------------------------ proposals

export async function reviewProposalAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const proposalId = id(fd, "proposal_id");
  const note = String(fd.get("review_note") ?? "").trim().slice(0, 500);
  let target = "/admin";
  const result = await run(async () => {
    const actor = await admin();
    if (fd.get("decision") === "reject") {
      await rejectProposal(actor, proposalId, note);
      target = "/admin#proposals";
      return "Proposal rejected.";
    }
    const parsed = readMarketForm(fd);
    if (!parsed.ok) throw new TradeError(parsed.error);
    const { marketId, proposer } = await approveProposal(actor, proposalId, parsed.value, note);
    target = `/market/${marketId}`;
    return `Approved! The market is now live. (Proposed by ${proposer}.)`;
  });
  if (!result?.ok) return result;
  await setFlash("success", result.message);
  redirect(target);
}

// ------------------------------------------------------------------ users

export async function tradingAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const r = await toggleTradingBan(await admin(), String(fd.get("user_id")));
    if (!r.banned) return `${r.username} can trade again.`;
    return `Trading turned off for ${r.username}.` + (r.refund ? ` Refunded Ⓜ${money(r.refund)} from their open bets.` : "");
  });
}

export async function grantAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { amount } = parseForm(amountSchema, fd);
    const applied = await grantBalance(await admin(), String(fd.get("user_id")), amount);
    return `Adjusted balance by ${money(applied)} ${CURRENCY}.`;
  });
}

export async function toggleAdminAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    await toggleAdmin(await admin(), String(fd.get("user_id")));
    return "Role updated.";
  });
}

export async function resetPasswordAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const actor = await admin();
    assertAdmin(actor);
    const userId = String(fd.get("user_id"));
    if (!(await canManage(actor, userId))) throw new TradeError(NOT_ALLOWED);
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { displayUsername: true, username: true } });
    if (!u) throw new TradeError("User not found.");
    const password = await setTemporaryPassword(userId);
    return {
      message: `Temporary password for ${u.displayUsername ?? u.username}: ${password}. Share it privately; they can change it on their Portfolio page.`,
      persist: true,
    };
  });
}
