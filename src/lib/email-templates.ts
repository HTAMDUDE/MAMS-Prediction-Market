import type { Email } from "./email";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const VERIFICATION_HOURS = 24;

/** The "confirm your email" message: one clear button, a plain-text twin, an expiry note and an ignore-me line. */
export function verificationEmail({ to, username, url }: { to: string; username: string; url: string }): Email {
  const subject = "Verify your email for MAMS Prediction Market";
  const name = escapeHtml(username);
  const link = escapeHtml(url);
  const text = [
    `Hi ${username},`,
    "",
    "Confirm your email address to finish creating your MAMS Prediction Market account:",
    url,
    "",
    `This link works for ${VERIFICATION_HOURS} hours. If it expires, log in and we'll send a new one.`,
    "If you didn't sign up, you can ignore this email.",
  ].join("\n");
  const html = `<!doctype html>
<html lang="en"><body style="margin:0;background:#f6f5f2;font-family:Inter,Arial,sans-serif;color:#1d1b18">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="480" cellspacing="0" cellpadding="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:28px">
      <tr><td>
        <div style="font-size:20px;font-weight:700;color:#7a1f2b">MAMS Prediction Market</div>
        <h1 style="font-size:20px;margin:20px 0 8px">Verify your email</h1>
        <p style="margin:0 0 20px;line-height:1.5">Hi ${name}, confirm your email address to finish creating your account.</p>
        <p style="margin:0 0 24px"><a href="${link}" style="display:inline-block;background:#7a1f2b;color:#ffffff;text-decoration:none;font-weight:600;padding:14px 24px;border-radius:8px">Verify email</a></p>
        <p style="margin:0 0 8px;font-size:13px;color:#6d685f;line-height:1.5">Button not working? Paste this link into your browser:<br><span style="word-break:break-all">${link}</span></p>
        <p style="margin:16px 0 0;font-size:13px;color:#6d685f;line-height:1.5">This link works for ${VERIFICATION_HOURS} hours. If it expires, log in and we'll send a new one. If you didn't sign up, you can ignore this email.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  return { to, subject, html, text };
}
