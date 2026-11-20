import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auth, LOGIN_FAIL_LIMIT } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { setEmailTransport, type Email } from "@/lib/email";
import { legacyEmail } from "@/lib/username";
import { resetDb } from "./helpers";

let outbox: Email[] = [];
beforeEach(async () => {
  await resetDb();
  outbox = [];
  setEmailTransport(async (e) => void outbox.push(e));
});
afterEach(() => setEmailTransport(null));

const emailFor = (username: string) => `${username.toLowerCase()}@example.com`;
const signUp = (username: string, password = "secret1", email = emailFor(username), extra: object = {}) =>
  auth.api.signUpEmail({ body: { name: username, email, password, username, ...extra } as never });
const signIn = (username: string, password: string) => auth.api.signInUsername({ body: { username, password } });
/** Sign up and verify through the real link, as a user would. */
async function signUpVerified(username: string, password = "secret1") {
  await signUp(username, password);
  await verifyLatestLink();
}
const tokenIn = (mail: Email) => new URL(mail.text.match(/https?:\/\/\S+/)![0]).searchParams.get("token")!;
const verifyLatestLink = () => auth.api.verifyEmail({ query: { token: tokenIn(outbox[outbox.length - 1]) } });

describe("sign-up and email verification", () => {
  it("creates an unverified account, normalizes the username, and emails a verification link", async () => {
    await signUp("Teacher");
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "teacher" } });
    expect([u.displayUsername, u.email, u.emailVerified, u.balance]).toEqual(["Teacher", "teacher@example.com", false, 1000]);
    expect(u.isAdmin).toBe(true); // first account, no MAMS_OWNER configured

    expect(outbox).toHaveLength(1);
    const mail = outbox[0];
    expect(mail.to).toBe("teacher@example.com");
    expect(mail.subject).toMatch(/verify/i);
    expect(mail.html).toContain("Hi Teacher");
    expect(mail.text).toContain("24 hours");
    const link = new URL(mail.text.match(/https?:\/\/\S+/)![0]);
    expect(link.pathname).toBe("/api/auth/verify-email");
    expect(link.searchParams.get("callbackURL")).toBe("/?verified=1"); // lands where the "verified" toast shows
  });

  it("escapes the username in the HTML email", async () => {
    await signUp("a.b-c_d");
    expect(outbox[0].html).toContain("Hi a.b-c_d");
  });

  it("blocks login until verified (and re-sends the link without counting a failed login), then allows it", async () => {
    await signUp("bob");
    expect(outbox).toHaveLength(1);
    await expect(signIn("bob", "secret1")).rejects.toMatchObject({ body: { code: "EMAIL_NOT_VERIFIED" } });
    expect(outbox).toHaveLength(2); // sendOnSignIn
    expect(outbox[1].to).toBe("bob@example.com");
    expect(await prisma.loginFailure.count()).toBe(0); // right password, so not a lockout strike

    await verifyLatestLink();
    expect((await prisma.user.findUniqueOrThrow({ where: { username: "bob" } })).emailVerified).toBe(true);
    expect((await signIn("bob", "secret1")).user.id).toBeTruthy();
  });

  it("wrong passwords on an unverified account don't trigger emails", async () => {
    await signUp("carol");
    await expect(signIn("carol", "nope!!")).rejects.toMatchObject({ body: { code: "INVALID_USERNAME_OR_PASSWORD" } });
    expect(outbox).toHaveLength(1); // only the sign-up email
  });

  it("resends on request, and an old link still verifies the same account", async () => {
    await signUp("dan");
    await auth.api.sendVerificationEmail({ body: { email: "dan@example.com" } });
    expect(outbox).toHaveLength(2);
    expect(outbox[1].to).toBe("dan@example.com");
    await auth.api.verifyEmail({ query: { token: tokenIn(outbox[0]) } });
    expect((await prisma.user.findUniqueOrThrow({ where: { username: "dan" } })).emailVerified).toBe(true);
  });

  it("rejects a tampered token", async () => {
    await signUp("erin");
    await expect(auth.api.verifyEmail({ query: { token: tokenIn(outbox[0]) + "x" } })).rejects.toThrow();
    expect((await prisma.user.findUniqueOrThrow({ where: { username: "erin" } })).emailVerified).toBe(false);
  });

  it("rejects duplicate usernames (any casing); a duplicate email creates nothing and doesn't reveal the account", async () => {
    await signUp("frank");
    await expect(signUp("FRANK", "secret1", "other@example.com")).rejects.toThrow();
    // With verification required, better-auth answers a repeated email like a normal sign-up (no enumeration)...
    await expect(signUp("frank2", "secret1", "frank@example.com")).resolves.toMatchObject({ token: null });
    // ...but no second account exists
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.user.count({ where: { username: "frank2" } })).toBe(0);
  });

  it("rejects bad usernames and the legacy placeholder email domain", async () => {
    await expect(signUp("no")).rejects.toThrow();
    await expect(signUp("bad name")).rejects.toThrow();
    await expect(signUp("sneaky", "secret1", legacyEmail("sneaky"))).rejects.toThrow(/real email/);
    expect(outbox).toHaveLength(0);
  });

  it("can't set privileged fields from a sign-up request", async () => {
    await signUp("first");
    await signUp("evil", "secret1", emailFor("evil"), { isAdmin: true, balance: 999999, emailVerified: true });
    const evil = await prisma.user.findUniqueOrThrow({ where: { username: "evil" } });
    expect([evil.isAdmin, evil.balance, evil.emailVerified]).toEqual([false, 1000, false]);
  });

  it("imported legacy accounts (placeholder email, verified) can log in once they have a password", async () => {
    await signUpVerified("seed");
    await prisma.user.update({ where: { username: "seed" }, data: { email: legacyEmail("old"), emailVerified: true } });
    expect((await signIn("seed", "secret1")).user.id).toBeTruthy();
  });
});

describe("login lockout and rate limits", () => {
  it("signs in by username (any casing) and locks out after repeated wrong passwords", async () => {
    await signUpVerified("lockme");
    expect((await signIn("LockMe", "secret1")).user.id).toBeTruthy();
    for (let i = 0; i < LOGIN_FAIL_LIMIT; i++) await expect(signIn("lockme", "wrong")).rejects.toThrow();
    await expect(signIn("lockme", "secret1")).rejects.toThrow(/Too many wrong passwords/);
    // attempts rejected by the lockout itself must not keep extending it
    await expect(signIn("lockme", "wrong")).rejects.toThrow(/Too many wrong passwords/);
    expect(await prisma.loginFailure.count({ where: { username: "lockme" } })).toBe(LOGIN_FAIL_LIMIT);
    await prisma.loginFailure.deleteMany();
    expect((await signIn("lockme", "secret1")).user.id).toBeTruthy();
  });

  it("overrides better-auth's 3-requests-per-10-seconds limits (a school can share one IP)", () => {
    const rules = (auth.options.rateLimit?.customRules ?? {}) as Record<string, { window: number; max: number } | undefined>;
    for (const path of ["/sign-in/username", "/sign-up/email", "/change-password", "/send-verification-email"]) {
      expect(rules[path]?.max ?? 0).toBeGreaterThanOrEqual(20); // better-auth's default is 3
    }
  });
});
