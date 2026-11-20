import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { username } from "better-auth/plugins";
import { STARTING_BALANCE, USERNAME_RE } from "./constants";
import { prisma } from "./db";
import { syntheticEmail } from "./username";
import { startsAsAdmin } from "@/server/services/permissions";

export { syntheticEmail };

export const LOGIN_FAIL_LIMIT = 10;
export const LOGIN_FAIL_WINDOW_MS = 5 * 60 * 1000;

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: { enabled: true, minPasswordLength: 6, autoSignIn: true },
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
      "/sign-up/email": { window: 60 * 60, max: 40 }, // a whole school can share one IP, so this is generous
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
        if (body.email !== syntheticEmail(name)) {
          throw new APIError("BAD_REQUEST", { message: "Invalid sign-up request." });
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
      } else if (name) {
        await prisma.loginFailure.create({ data: { username: name } });
      }
    }),
  },
  plugins: [
    username({ minUsernameLength: 3, maxUsernameLength: 20, usernameValidator: (u) => USERNAME_RE.test(u) }),
    nextCookies(), // must be last
  ],
});
