"use server";

import { readMarketForm, idSchema } from "@/lib/validation";
import { requireUser } from "@/lib/session";
import { createProposal, withdrawProposal } from "@/server/services/proposals";
import { TradeError } from "@/server/services/permissions";
import { run, type ActionState } from "./util";

export async function submitProposal(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const user = await requireUser("/propose");
    const parsed = readMarketForm(fd);
    if (!parsed.ok) throw new TradeError(parsed.error);
    await createProposal(user.id, parsed.value);
    return "Thanks! Your market was sent to the admins for approval.";
  });
}

export async function withdrawProposalAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const user = await requireUser();
    await withdrawProposal(user.id, idSchema.parse(fd.get("proposal_id")));
    return "Proposal withdrawn.";
  });
}
