/** Every kind of admin action that is written to the audit log, with the sentence shown on Admin → Activity. */
export const AUDIT_ACTIONS = {
  "market.create": "Created a market",
  "market.edit": "Edited a market",
  "market.cancel": "Cancelled a market (bets refunded)",
  "market.delete": "Deleted a market",
  "market.close_early": "Closed betting early",
  "market.reopen": "Reopened betting",
  "market.feature": "Featured a market",
  "market.unfeature": "Removed a market from featured",
  "market.clarify": "Added a rules clarification",
  "market.block": "Blocked a user from a market",
  "market.unblock": "Unblocked a user from a market",
  "result.propose": "Proposed a result",
  "result.retract": "Withdrew a proposed result",
  "result.confirm": "Confirmed a disputed result",
  "proposal.approve": "Approved a market proposal",
  "proposal.reject": "Rejected a market proposal",
  "comment.hide": "Hid a comment",
  "comment.unhide": "Unhid a comment",
  "comment.delete": "Deleted a comment",
  "user.ban": "Banned a user from trading",
  "user.unban": "Allowed a user to trade again",
  "user.comment_mute": "Muted a user from commenting",
  "user.comment_unmute": "Allowed a user to comment again",
  "user.grant": "Adjusted a balance",
  "user.admin_on": "Made a user an admin",
  "user.admin_off": "Removed a user's admin role",
  "user.password_reset": "Reset a password",
  "user.email_change": "Changed a user's email",
  "user.verify": "Marked an email as verified",
  "user.resend_verification": "Re-sent a verification email",
  "user.delete": "Deleted an account",
  "site.announcement": "Changed the site announcement",
} as const;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

export const auditLabel = (action: string) => (AUDIT_ACTIONS as Record<string, string>)[action] ?? action;
