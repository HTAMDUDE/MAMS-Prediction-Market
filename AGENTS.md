<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# MAMS Prediction Market: guide for AI agents

A play-money prediction market for Mass Academy students (virtual **MAMS Bucks**). Binary and multiple-choice markets priced by an LMSR automated market maker, user-proposed markets, optimistic resolution with a 24-hour dispute window, admin/owner roles. This branch (`port`) is the Next.js port of the original Flask + SQLite app, which still lives on `main`.

## Two rules every agent must follow

### 1. Always look for skills first (skills.sh)

Before starting work in any area (a library, a framework, testing, UI, deployment, security…), **run find-skills and install anything useful**:

```bash
npx skills find <topic>                                    # search skills.sh
npx skills add <owner/repo> --skill <name> -y              # install into this repo (.agents/skills, symlinked for Claude Code)
```

The `find-skills` skill itself is installed (`.agents/skills/find-skills`); `npx skills add https://github.com/vercel-labs/skills --skill find-skills` re-installs it. Prefer skills from the library's own authors or high-install-count sources, and read a skill before trusting it (skills run with full agent permissions). Record anything you install in the **Installed skills** list below.

### 2. Keep this file up to date

Every agent that changes the project **must, in the same commit as the change**:

1. Add a dated entry at the **top** of the [Change log](#change-log): what changed, why, and the main files touched.
2. Fix any other section here that the change made wrong (commands, folder map, conventions, env vars, deviations, installed skills).

If you find this file out of date, fix it. Don't leave it for the next agent. Never delete past change-log entries.

## Stack

| Concern | Choice |
|---|---|
| Framework | Next.js 16 (App Router, TypeScript, React 19), `cacheComponents` **off** (everything is per-user and live) |
| Styling / UI | Tailwind CSS v4, shadcn/ui (Base UI flavour, `src/components/ui`), `next-themes` (system light/dark), maroon brand `#7a1f2b` |
| Auth | better-auth: email+password with the `username` plugin; usernames only, no real emails |
| Database | PostgreSQL via Prisma 7 (`prisma-client` generator → `src/generated/prisma`, `@prisma/adapter-pg`) |
| Charts | Recharts through shadcn's `chart` component |
| Validation | zod 4 (`src/lib/validation.ts`) |
| Tests | Vitest against a real Postgres test database |
| Hosting | App on **Vercel**, database on **Railway** |

## Commands

```bash
docker compose up -d db          # local Postgres on :5433 (databases `mams` and `mams_test`; create mams_test once, see README)
pnpm db:migrate                  # prisma migrate dev (create/apply migrations)
pnpm db:seed                     # 5 example markets
pnpm dev                         # http://localhost:3000
pnpm test                        # vitest (applies migrations to TEST_DATABASE_URL, truncates tables per test)
pnpm lint && pnpm typecheck      # must pass before committing
pnpm build:local                 # prisma generate + next build (pnpm build also runs migrate deploy, used on Vercel)
pnpm import:sqlite <mams.db>     # one-off import of the old Flask database into an EMPTY Postgres
pnpm reset-password <username>   # print a temporary password for a user
```

**Never run `prisma migrate reset`** (or other destructive Prisma commands) without the user's explicit say-so: Prisma blocks it for AI agents on purpose. Tests use `migrate deploy` plus truncation instead.

## Folder map

```
prisma/schema.prisma         auth tables (better-auth) + domain tables; migrations in prisma/migrations; seed.ts
scripts/                     import-sqlite.ts, reset-password.ts (run with tsx)
src/lib/                     lmsr.ts (market-maker math), constants.ts, time.ts (school timezone), format.ts, validation.ts (zod),
                             auth.ts / auth-client.ts (better-auth), session.ts (current user, server-only), db.ts (Prisma), username.ts
src/server/services/         ALL business logic: markets, trading, resolution, moderation, proposals, portfolio, permissions
src/server/actions/          thin "use server" actions: zod-parse → auth → service → toast/redirect
src/server/finalize.ts       ensureFinalized(): pays out markets whose dispute window ended (cached per request)
src/app/                     pages (App Router) + api/auth, api/quote, api/cron/finalize
src/components/              app components; ui/ is shadcn
tests/                       Vitest suites (helpers.ts has the test fixtures)
```

## Conventions

- **Business rules live only in `src/server/services`.** Actions and routes stay thin. Services take an `Actor` (`{id, isAdmin, isOwner}`) and enforce permissions themselves (`assertAdmin`, `canManage`), so tests cover them. Add tests there for any rule you add.
- **Every input is zod-validated** (`src/lib/validation.ts`). User-facing failures throw `TradeError` (message shown as-is in a toast); `run()` in `src/server/actions/util.ts` converts it to a result.
- **Money:** stored as `Float`, always rounded to cents with `cents()` / `adjustBalance()` (atomic SQL `ROUND(...::numeric, 2)`). Never read-modify-write a balance. Lock the market row first (`lockMarket`) in any transaction that changes outcomes, trades or balances; lock markets in ascending id order.
- **Time:** timestamps are `timestamptz`. School time (`MAMS_TZ`, default America/New_York) is used for form inputs, the daily bonus and display (`src/lib/time.ts`, `src/lib/format.ts`). Never use the server's local time.
- **Usernames:** stored lowercase in `user.username`, original casing in `displayUsername` (better-auth username plugin). Show `displayUsername`; compare lowercase.
- **Sign-up/sign-in run from the browser** (`authClient`), because better-auth does not rate-limit server-side `auth.api` calls. Sign-up sends a synthetic `<username>@users.mams.invalid` email, enforced by a hook in `auth.ts`.
- **Finalizing results:** `ensureFinalized()` is awaited at the top of every page, the quote route and every action (not the layout, which doesn't re-render on navigation). A daily Vercel Cron (`vercel.json`) is a backup.
- **Pages don't prerender:** don't re-enable `cacheComponents`. Server components must not pass functions to client components (pass plain data).
- shadcn's Base UI `Button` is patched to default to `type="submit"` like a native button; pass `type="button"` for non-submit buttons.
- Forms use `ActionForm` + `ConfirmButton` (`src/components/action-form.tsx`); confirmations are AlertDialogs, not `confirm()`.
- Use Context7 (library docs) before using a library API from memory; versions here are newer than most training data.

## Roles

| Role | Can do |
|---|---|
| **Owner** (user matching `MAMS_OWNER`, or the first account if unset) | Everything admins can, plus add/remove admins and manage other admins. Nobody can demote, ban, block or change the owner's balance. |
| **Admin** | Run markets and manage **regular users** (balances, bans, blocks, password resets). Can't act on the owner/other admins or create admins. |
| **User** | Bet, comment, propose markets, dispute results in markets they traded in. |

## Environment variables

`DATABASE_URL`, `TEST_DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `MAMS_OWNER` (default `Kaushik`; empty = first account), `MAMS_ADMINS` (comma list), `MAMS_TZ`, `CRON_SECRET`. See `.env.example`.

## Differences from the Flask app (`main`)

- No CSRF tokens: Server Actions and better-auth check the request origin.
- Rate limits live in Postgres (serverless functions don't share memory): sign-up 40/hour per IP (better-auth `rateLimit`), plus the per-username login lockout (10 failures / 5 min, `LoginFailure` table).
- New: password reset (CLI + Admin → Users → Reset) and a change-password form on Portfolio, because imported accounts have no usable password.
- Forbidden admin pages render a 403 view with HTTP status 200 (Next's `forbidden()` is still experimental).
- Deleting a market now also removes its disputes and clarifications (the old app left them, which broke deletes in that case).

## Installed skills (`.agents/skills`, tracked in `skills-lock.json`)

`find-skills`, `better-auth-best-practices`, `better-auth-security-best-practices`, `email-and-password-best-practices`, `prisma-cli`, `prisma-client-api`, `prisma-database-setup`, `prisma-postgres`, `shadcn`, `vitest`.

## Change log

Newest first. One entry per change; see rule 2 above.

### 2026-11-20: Port from Flask/SQLite to Next.js (branch `port`)

- Replaced the Flask app with Next.js 16 + TypeScript + Tailwind v4 (App Router), better-auth, Prisma 7 + PostgreSQL, shadcn/ui, Recharts and zod. All features kept: Yes/No and multiple-choice markets, LMSR pricing with live quotes, selling, portfolio/leaderboard, comments, price chart, proposals, rules-first pages with clarifications and locking, propose-then-dispute resolution, cancel/delete refunds, per-market blocks and site-wide trade bans, owner/admin roles, daily bonus, how-it-works page.
- Business logic moved into `src/server/services` (ports of the old `app.py` functions); `src/lib/lmsr.ts` is an exact port of `lmsr.py`.
- Added `scripts/import-sqlite.ts` (old DB → Postgres, ids preserved, users must reset passwords) and `scripts/reset-password.ts`.
- Ported the 30 pytest tests to Vitest (57 test cases incl. auth integration) in `tests/`.
- Added this file, `CLAUDE.md`, installed skills via skills.sh (`npx skills`), `docker-compose.yml`, `vercel.json` (daily finalize cron).
- Removed: `app.py`, `lmsr.py`, `seed.py`, `schema.sql`, `templates/`, `static/`, `tests/test_market.py`, `requirements.txt` (still on `main`).
