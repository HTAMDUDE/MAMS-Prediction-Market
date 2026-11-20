/** Client-side helpers for the "check your email" step (resend cooldown, so people can't spam the Resend button). */
export const RESEND_COOLDOWN_SECONDS = 60;
const KEY = "mams.verifySentAt";

/** Remember that a verification email was just sent (so the resend button starts on cooldown). */
export function markVerificationSent() {
  try {
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* storage can be blocked; the cooldown just won't persist */
  }
}

export function secondsUntilResend(): number {
  try {
    const sent = Number(sessionStorage.getItem(KEY) ?? 0);
    return Math.max(0, Math.ceil(RESEND_COOLDOWN_SECONDS - (Date.now() - sent) / 1000));
  } catch {
    return 0;
  }
}
