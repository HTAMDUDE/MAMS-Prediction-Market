"use server";

import { commentSchema, disputeSchema, idSchema, tradeSchema } from "@/lib/validation";
import { requireUser } from "@/lib/session";
import { addComment } from "@/server/services/markets";
import { TradeError } from "@/server/services/permissions";
import { addDispute } from "@/server/services/resolution";
import { executeTrade } from "@/server/services/trading";
import { parseForm, run, type ActionState } from "./util";

const marketId = (fd: FormData) => idSchema.parse(fd.get("market_id"));

export async function placeTrade(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const user = await requireUser();
    let t;
    try {
      t = parseForm(tradeSchema, fd);
    } catch {
      throw new TradeError("Pick an outcome and enter a valid number.");
    }
    return executeTrade(user.id, marketId(fd), t.outcome_id, t.action, t.value, t.min_out);
  });
}

export async function postComment(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const user = await requireUser();
    await addComment(user.id, marketId(fd), parseForm(commentSchema, fd).body);
    return "Comment posted.";
  });
}

export async function disputeResult(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const user = await requireUser();
    await addDispute(user.id, marketId(fd), parseForm(disputeSchema, fd).reason);
    return "Dispute sent. The result won't finalize until an admin reviews it.";
  });
}
