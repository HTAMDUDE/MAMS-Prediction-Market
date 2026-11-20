import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { username } from "better-auth/plugins";
import { STARTING_BALANCE, USERNAME_RE } from "./constants";
import { prisma } from "./db";
import { sendEmail } from "./email";
import { verificationEmail, VERIFICATION_HOURS } from "./email-templates";
import { LEGACY_EMAIL_DOMAIN } from "./username";
import { startsAsAdmin } from "@/server/services/permissions";

export const LOGIN_FAIL_LIMIT = 10;
export const LOGIN_FAIL_WINDOW_MS = 5 * 60 * 1000;

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  // New accounts must verify their email before they can log in.
  emailAndPassword: { enabled: true, minPasswordLength: 6, requireEmailVerification: true },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true, // someone who logs in with the right password before verifying gets a fresh link
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60 * VERIFICATION_HOURS,
    sendVerificationEmail: async ({ user, url }) => {
      const username = (user as { displayUsername?: string | null }).displayUsername ?? user.name;
      // Every link (sign-up, resend, login-triggered) lands on the home page, which shows the "verified" toast.
      const link = new URL(url);
      link.searchParams.set("callbackURL", "/?verified=1");
      try {
        await sendEmail(verificationEmail({ to: user.email, username, url: link.toString() }));
      } catch (e) {
        // Mail trouble must not break sign-up or sign-in; the user can ask for another link.
        console.error("Could not send verification email", e);
      }
    },
  },
  session: { expiresIn: 60 * 60 * 24 * 30 },
  // BETTER_AUTH_URL is trusted automatically; also accept Vercel preview/production hostnames.
  trustedOrigins: [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL]
    .filter((h): h is string => Boolean(h))
    .map((h) => `https://${h}`),
  user: {
    additionalFields: {
      balance: { type: "number", required: false, defaultValue: STARTING_BALANCE, input: false },
      isAdmin: { type: "boolean", required: false, defaultValue: false, input: false },
      lastBonus: { type: "string", required: false, input: false },
    },
  },
  rateLimit: {
    enabled: true, // also in dev; serverless functions don't share memory, so keep counters in Postgres
    storage: "database",
    customRules: {
      // better-auth defaults every /sign-in*, /sign-up* and /change-password to 3 requests per 10 s per IP, which would
      // lock out a whole school behind one public IP. Brute force is covered by the per-username lockout below.
      "/sign-up/email": { window: 60 * 60, max: 40 },
      "/sign-in/username": { window: 60, max: 120 },
      "/change-password": { window: 60, max: 30 },
      "/send-verification-email": { window: 60, max: 20 }, // default is 3/min per IP
    },
  },
  databaseHooks: {
    user: {
      create: {
        // Owner, MAMS_ADMINS and (when no owner is configured) the very first account start as admins.
        before: async (user) => {
          const name = String((user as { username?: string }).username ?? "").toLowerCase();
          const isAdmin = await startsAsAdmin(name);
          return { data: { ...user, isAdmin } };
        },
      },
    },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      const body = (ctx.body ?? {}) as { username?: string; email?: string };
      if (ctx.path === "/sign-up/email") {
        const name = String(body.username ?? "").trim();
        if (!USERNAME_RE.test(name)) {
          throw new APIError("BAD_REQUEST", { message: "Username must be 3–20 characters: letters, numbers, _ . -" });
        }
        if (String(body.email ?? "").toLowerCase().endsWith(`@${LEGACY_EMAIL_DOMAIN}`)) {
          throw new APIError("BAD_REQUEST", { message: "Use your real email address." });
        }
      }
      if (ctx.path === "/sign-in/username") {
        const name = String(body.username ?? "").trim().toLowerCase();
        const recent = await prisma.loginFailure.count({
          where: { username: name, createdAt: { gt: new Date(Date.now() - LOGIN_FAIL_WINDOW_MS) } },
        });
        if (recent >= LOGIN_FAIL_LIMIT) {
          throw new APIError("TOO_MANY_REQUESTS", {
            message: "Too many wrong passwords for this account. Wait 5 minutes and try again.",
          });
        }
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-in/username") return;
      const name = String((ctx.body as { username?: string } | undefined)?.username ?? "").trim().toLowerCase();
      if (ctx.context.newSession) {
        await prisma.loginFailure.deleteMany({ where: { username: name } });
        return;
      }
      // Only wrong credentials count toward the lockout. An unverified user with the right password is not a failure
      // (and neither are attempts the lockout itself rejected, which never reach here).
      const returned = ctx.context.returned;
      const code = returned instanceof APIError ? (returned.body as { code?: string } | undefined)?.code : undefined;
      if (name && code === "INVALID_USERNAME_OR_PASSWORD") await prisma.loginFailure.create({ data: { username: name } });
    }),
  },
  plugins: [
    username({ minUsernameLength: 3, maxUsernameLength: 20, usernameValidator: (u) => USERNAME_RE.test(u) }),
    nextCookies(), // must be last
  ],
});
