import { beforeEach, describe, expect, it } from "vitest";
import { auth, syntheticEmail, LOGIN_FAIL_LIMIT } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { resetDb } from "./helpers";

beforeEach(resetDb);

const signUp = (username: string, password = "secret1", email = syntheticEmail(username)) =>
  auth.api.signUpEmail({ body: { name: username, email, password, username } as never });
const signIn = (username: string, password: string) => auth.api.signInUsername({ body: { username, password } });

describe("better-auth integration", () => {
  it("signs up with a username, normalizes case, and makes the first account an admin", async () => {
    await signUp("Teacher");
    await signUp("bob");
    const teacher = await prisma.user.findUniqueOrThrow({ where: { username: "teacher" } });
    expect(teacher.displayUsername).toBe("Teacher");
    expect(teacher.isAdmin).toBe(true); // first account, no MAMS_OWNER configured
    expect(teacher.balance).toBe(1000);
    expect((await prisma.user.findUniqueOrThrow({ where: { username: "bob" } })).isAdmin).toBe(false);
    await expect(signUp("BOB")).rejects.toThrow(); // usernames are unique ignoring case
  });

  it("rejects bad usernames and non-placeholder emails", async () => {
    await expect(signUp("no")).rejects.toThrow();
    await expect(signUp("bad name")).rejects.toThrow();
    await expect(signUp("sneaky", "secret1", "real@example.com")).rejects.toThrow();
  });

  it("can't set privileged fields from a sign-up request", async () => {
    await signUp("first");
    await auth.api.signUpEmail({ body: { name: "evil", email: syntheticEmail("evil"), password: "secret1", username: "evil", isAdmin: true, balance: 999999 } as never });
    const evil = await prisma.user.findUniqueOrThrow({ where: { username: "evil" } });
    expect([evil.isAdmin, evil.balance]).toEqual([false, 1000]);
  });

  it("signs in by username (any casing) and locks out after repeated failures", async () => {
    await signUp("lockme");
    expect((await signIn("LockMe", "secret1")).user.id).toBeTruthy();
    for (let i = 0; i < LOGIN_FAIL_LIMIT; i++) await expect(signIn("lockme", "wrong")).rejects.toThrow();
    await expect(signIn("lockme", "secret1")).rejects.toThrow(/Too many wrong passwords/);
    // attempts rejected by the lockout itself must not keep extending it
    await expect(signIn("lockme", "wrong")).rejects.toThrow(/Too many wrong passwords/);
    expect(await prisma.loginFailure.count({ where: { username: "lockme" } })).toBe(LOGIN_FAIL_LIMIT);
    await prisma.loginFailure.deleteMany();
    expect((await signIn("lockme", "secret1")).user.id).toBeTruthy();
  });

  it("overrides better-auth's 3-requests-per-10-seconds sign-in limit (a school can share one IP)", () => {
    const rules = (auth.options.rateLimit?.customRules ?? {}) as Record<string, { window: number; max: number } | undefined>;
    for (const path of ["/sign-in/username", "/sign-up/email", "/change-password"]) {
      expect(rules[path]?.max ?? 0).toBeGreaterThanOrEqual(30); // better-auth's default is 3
    }
  });
});
