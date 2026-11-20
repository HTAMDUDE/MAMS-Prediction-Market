import { Resend } from "resend";

export type Email = { to: string; subject: string; html: string; text: string };
export type EmailTransport = (email: Email) => Promise<void>;

/** Tests swap this to capture mail instead of sending it. */
let transport: EmailTransport | null = null;
export function setEmailTransport(t: EmailTransport | null) {
  transport = t;
}

const DEV_FROM = "MAMS Prediction Market <onboarding@resend.dev>";

/**
 * Send a transactional email through Resend.
 * - With `RESEND_API_KEY` set, it is sent from `EMAIL_FROM` (a verified Resend domain in production).
 * - Without a key (local development) the message is printed to the server console, so sign-up still works offline.
 * - In production a missing key or sender is an error, so a broken setup is visible instead of silently dropping mail.
 */
export async function sendEmail(email: Email): Promise<void> {
  if (transport) return transport(email);
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    if (process.env.NODE_ENV === "production") throw new Error("RESEND_API_KEY is not set, so email can't be sent.");
    console.log(`\n[email] To: ${email.to}\n[email] Subject: ${email.subject}\n${email.text}\n`);
    return;
  }
  const from = process.env.EMAIL_FROM || (process.env.NODE_ENV === "production" ? "" : DEV_FROM);
  if (!from) throw new Error("EMAIL_FROM is not set (use an address on a domain verified in Resend).");
  const { error } = await new Resend(apiKey).emails.send({ from, to: email.to, subject: email.subject, html: email.html, text: email.text });
  if (error) throw new Error(`Resend rejected the email: ${error.name}: ${error.message}`);
}
