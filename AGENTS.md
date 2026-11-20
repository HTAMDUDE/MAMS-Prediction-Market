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
| Auth | better-auth: username + password (`username` plugin), with a real email that must be **verified** before login |
| Email | Resend (`src/lib/email.ts`); emails are printed to the console in development when no API key is set |
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
                             auth.ts / auth-client.ts (better-auth), session.ts (current user, server-only), db.ts (Prisma), username.ts,
                             email.ts (Resend sender, swappable transport for tests), email-templates.ts, verify.ts (resend cooldown)
src/server/services/         ALL business logic: markets, trading, resolution, moderation, proposals, portfolio, permissions,
                             accounts (user admin: email/verify/delete/list), comments (moderation), settings (announcement), audit
src/server/actions/          thin "use server" actions: zod-parse → auth → service → toast/redirect
src/server/finalize.ts       ensureFinalized(): pays out markets whose dispute window ended (cached per request)
src/app/                     pages (App Router) + api/auth, api/quote, api/cron/finalize
src/components/              app components; ui/ is shadcn
tests/                       Vitest suites (helpers.ts has the test fixtures)
```

## Conventions

- **Every admin action is audited.** A service that an admin can trigger must call `logAudit(actor, "<action key>", {...})` (`src/server/services/audit.ts`) after its transaction commits, and the key must exist in `src/lib/audit-actions.ts` (that map also drives the labels on Admin → Activity). Failed or forbidden attempts are not logged. Add a test that checks the entry. Audit rows copy names in (no foreign keys) so they survive deleted accounts, and nothing in the app edits or deletes them.
- **Permission rule for acting on people (and their comments):** the owner can act on anyone, admins only on regular users (and themselves for their own comments); nobody but the owner touches the owner. Use `canManage()`; never re-implement it. Deleting an account is further limited: not yourself, not the owner, and admins must be demoted first.
- **Business rules live only in `src/server/services`.** Actions and routes stay thin. Services take an `Actor` (`{id, isAdmin, isOwner}`) and enforce permissions themselves (`assertAdmin`, `canManage`), so tests cover them. Add tests there for any rule you add.
- **Every input is zod-validated** (`src/lib/validation.ts`). User-facing failures throw `TradeError` (message shown as-is in a toast); `run()` in `src/server/actions/util.ts` converts it to a result.
- **Money:** stored as `Float`, always rounded to cents with `cents()` / `adjustBalance()` (atomic SQL `ROUND(...::numeric, 2)`). Never read-modify-write a balance. Lock the market row first (`lockMarket`) in any transaction that changes outcomes, trades or balances; lock markets in ascending id order.
- **Time:** timestamps are `timestamptz`. School time (`MAMS_TZ`, default America/New_York) is used for form inputs, the daily bonus and display (`src/lib/time.ts`, `src/lib/format.ts`). Never use the server's local time.
- **Usernames:** stored lowercase in `user.username`, original casing in `displayUsername` (better-auth username plugin). Show `displayUsername`; compare lowercase.
- **Sign-up/sign-in run from the browser** (`authClient`), because better-auth does not rate-limit server-side `auth.api` calls. 
- **Email verification is required** (`requireEmailVerification`): sign-up emails a link and goes to `/check-email` (Resend button with a 60 s cooldown); logging in before verifying re-sends a link (`sendOnSignIn`) and the form shows a notice. Every link is rewritten in `auth.ts` to land on `/?verified=1`, which shows a toast (`VerifyToast`) and signs the user in. Only wrong-password attempts count toward the login lockout (not `EMAIL_NOT_VERIFIED`). With verification on, better-auth answers a repeated email like a normal sign-up (no account enumeration) and creates nothing.
- **Sending mail:** always go through `sendEmail()` (`src/lib/email.ts`). No `RESEND_API_KEY`: printed to the console in development, an error in production. Tests call `setEmailTransport()` to capture mail. Mail failures are logged, never thrown into sign-up/sign-in.
- **Legacy accounts** imported from Flask have a placeholder `@users.mams.invalid` email and `emailVerified = true`; real sign-ups with that domain are rejected.
- **Finalizing results:** `ensureFinalized()` is awaited at the top of every page, the quote route and every action (not the layout, which doesn't re-render on navigation). A daily Vercel Cron (`vercel.json`) is a backup.
- **Pages don't prerender:** don't re-enable `cacheComponents`. Server components must not pass functions to client components (pass plain data); that includes `ActionForm` render-prop children, which are only allowed inside client components.
- shadcn's Base UI `Button` is patched to default to `type="submit"` like a native button; pass `type="button"` for non-submit buttons.
- Redirecting actions hand a toast to the next page through the `mams_flash` cookie (`setFlash` in `src/server/actions/util.ts`); the server layout passes the raw cookie to `<Flash/>`, so it works even when redirecting to the same URL. Actions that don't redirect return `{ok, message}` to `ActionForm`, which toasts it.
- Forms use `ActionForm` + `ConfirmButton` (`src/components/action-form.tsx`); confirmations are AlertDialogs, not `confirm()`.
- Use Context7 (library docs) before using a library API from memory; versions here are newer than most training data.

## Roles

| Role | Can do |
|---|---|
| **Owner** (user matching `MAMS_OWNER`, or the first account if unset) | Everything admins can, plus add/remove admins and manage other admins. Nobody can demote, ban, block or change the owner's balance. |
| **Admin** | Run markets and manage **regular users** (balances, bans, blocks, mutes, password resets, email fixes, account deletion) and moderate comments; every action is audited. Can't act on the owner/other admins or create admins. |
| **User** | Bet, comment, propose markets, dispute results in markets they traded in. |

## Environment variables

`DATABASE_URL`, `TEST_DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (must be the https site address in production: verification links use it), `RESEND_API_KEY`, `EMAIL_FROM` (on a Resend-verified domain; both required in production), `MAMS_OWNER` (default `Kaushik`; empty = first account), `MAMS_ADMINS` (comma list), `MAMS_TZ`, `CRON_SECRET`. See `.env.example`.

## Differences from the Flask app (`main`)

- No CSRF tokens: Server Actions and better-auth check the request origin.
- Rate limits live in Postgres (serverless functions don't share memory). better-auth defaults `/sign-in*`, `/sign-up*` and `/change-password` to 3 requests per 10 s per IP, which would lock out a school sharing one IP, so `auth.ts` overrides them (sign-up 40/hour, sign-in 120/min, change-password 30/min per IP). Brute force is covered by the per-username lockout (10 failures / 5 min, `LoginFailure` table; attempts rejected by the lockout aren't counted).
- New: password reset (CLI + Admin → Users → Reset) and a change-password form on Portfolio, because imported accounts have no usable password.
- New admin tools the Flask app never had: user search/filters, email change/verify/resend, account deletion, comment hide/delete/mute, close-early/reopen/feature markets, a site announcement banner, and the audit log (Admin → Activity).
- Forbidden admin pages render a 403 view with HTTP status 200 (Next's `forbidden()` is still experimental).
- Deleting a market now also removes its disputes and clarifications (the old app left them, which broke deletes in that case).

## Installed skills (`.agents/skills`, tracked in `skills-lock.json`)

`find-skills`, `better-auth-best-practices`, `better-auth-security-best-practices`, `email-and-password-best-practices`, `email-best-practices` (Resend), `resend` (Resend), `prisma-cli`, `prisma-client-api`, `prisma-database-setup`, `prisma-postgres`, `shadcn`, `vitest`.

## Change log

Newest first. One entry per change; see rule 2 above.

### 2026-11-20: Fix Vercel install (broken pnpm 11.12.0)

- Vercel's `pnpm install` failed because `packageManager` pinned pnpm 11.12.0, a broken release (its `@pnpm/exe` shipped without a binary). Bumped the pin to `pnpm@11.28.12`; the lockfile is unchanged and `pnpm install --frozen-lockfile` passes.
- Files: `package.json`.

### 2026-11-20: More admin controls

- **User accounts:** Admin → Users now has search (username/email), filters (admins, banned, muted, unverified) and pagination, and a per-user **Manage** dialog with every control: balance, ban/allow trading, mute/allow commenting, change email (re-verifies and mails the new address), resend verification, mark verified, reset password, role, and **delete account** (reverses their bets in unresolved markets first; not self/owner; admins must be demoted first). Fixes the known mistyped-email gap.
- **Audit log:** new `AuditLog` table, `logAudit()`/`listAudit()` in `src/server/services/audit.ts`, action catalog in `src/lib/audit-actions.ts`, and an Admin → Activity page (search + pagination). Every existing admin service (markets, results, proposals, blocks, bans, balances, roles, password reset) is now instrumented, as are all the new controls.
- **Comment moderation:** hide/unhide and delete comments from the market page (hidden text is never sent to non-admins), and mute a user from commenting (`CommentMute`, enforced in `addComment`). Same `canManage` rules as for people.
- **Market controls:** close betting early, reopen a closed market (no proposed result, new closing time), feature markets (`Market.featured`: sorted first on the home page, ★ badge), and a site-wide announcement banner (`SiteSetting`, 300 chars).
- Schema migration `admin_controls` (additive; `Clarification.adminId` is now nullable with `SetNull` so a deleted admin's rules notes survive). New tests in `tests/admin-controls.test.ts` (85 tests total).
- Fixed: the Users "admins" filter now counts the owner even if their stored flag was never set. Deleting an account is refused while the user has an open dispute (it would silently lift the pause and auto-finalize the market). The result action's confirm branch is now explicit (an unknown `decision` is an error, never a payout). `pnpm reset-password` now also marks the email verified so a locked-out owner can get back in (the admin Reset button deliberately does not).
- Files: `prisma/schema.prisma`, `src/server/services/{accounts,audit,comments,settings,markets,moderation,resolution,proposals}.ts`, `src/server/actions/admin.ts`, `src/lib/audit-actions.ts`, `src/components/{admin-users-table,manage-dialog,market-admin-panel,market-card}.tsx`, `src/app/{admin/page,admin/activity/page,market/[id]/page,layout,page}.tsx`, `tests/{admin-controls,helpers}.ts`, `README.md`.
- Notes: auto-finalized results (system action) are not in the audit log. The announcement banner lives in the root layout, so people already on the site see a new one on their next full page load.

### 2026-11-20: Email verification with Resend, and a setup guide

- New accounts now sign up with a real email and must verify it before logging in (better-auth `requireEmailVerification`, `sendOnSignUp`, `sendOnSignIn`, auto sign-in after verifying, 24 h links). Emails are sent with Resend (`src/lib/email.ts`; console fallback in development, hard error in production without `RESEND_API_KEY`/`EMAIL_FROM`).
- UI: email field on sign-up, `/check-email` page with a 60 s resend cooldown, an "unverified" notice on login, and a toast on the landing page after clicking the link (`VerifyToast`). Verification links always land on `/?verified=1`.
- Imported Flask accounts now get a placeholder email (`legacyEmail`) and `emailVerified = true`; the old synthetic-email requirement at sign-up is replaced by a rejection of that placeholder domain.
- Login lockout now counts only wrong-password attempts; rate-limit override added for `/send-verification-email`.
- Added `SETUP.md` (local + production guide with troubleshooting), updated `README.md` and `.env.example`; installed the Resend skills `email-best-practices` and `resend` via skills.sh.
- Tests: `tests/auth.test.ts` rewritten around the verification flow with a captured outbox (65 tests total now); the `registerSchema` test covers email.
- Files: `src/lib/{auth,email,email-templates,verify,username,validation}.ts`, `src/components/{auth-forms,check-email,verify-toast}.tsx`, `src/app/{check-email/page,layout}.tsx`, `scripts/import-sqlite.ts`, `tests/{auth,validation}.test.ts`, `SETUP.md`, `README.md`, `.env.example`.
- Known gap at the time (fixed in "More admin controls"): a user who mistypes their email at sign-up couldn't verify and kept the username. Possible follow-ups: forgot-password by email, change-email, letting a new sign-up replace a stale unverified account.

### 2026-11-20: Review fixes after browser testing

- Fixed a 500 on closed/proposed/disputed markets for admins (render-prop child inside the server component `market-admin-panel.tsx`).
- `ConfirmButton` now closes its dialog on confirm; the flash toast now also shows after a redirect to the same URL (layout passes the cookie to `<Flash raw=…/>`, messages carry a unique id).
- Overrode better-auth's default 3-requests/10 s limits on sign-in, sign-up and change-password (a school can share one IP); added tests that the lockout isn't extended by rejected attempts and that the overrides exist.
- Daily bonus claim is now a single atomic SQL statement. Also fixed: submit buttons (shadcn Base UI `Button` defaulted to `type="button"`), mobile header wrapping, chart axis ticks for short time ranges, Vercel preview origins in `trustedOrigins`.
- Files: `src/components/{market-admin-panel,action-form,flash,nav-links,header,price-chart}.tsx`, `src/components/ui/button.tsx`, `src/lib/{auth,flash}.ts`, `src/server/actions/{account,util}.ts`, `src/app/layout.tsx`, `tests/auth.test.ts`.

### 2026-11-20: Port from Flask/SQLite to Next.js (branch `port`)

- Replaced the Flask app with Next.js 16 + TypeScript + Tailwind v4 (App Router), better-auth, Prisma 7 + PostgreSQL, shadcn/ui, Recharts and zod. All features kept: Yes/No and multiple-choice markets, LMSR pricing with live quotes, selling, portfolio/leaderboard, comments, price chart, proposals, rules-first pages with clarifications and locking, propose-then-dispute resolution, cancel/delete refunds, per-market blocks and site-wide trade bans, owner/admin roles, daily bonus, how-it-works page.
- Business logic moved into `src/server/services` (ports of the old `app.py` functions); `src/lib/lmsr.ts` is an exact port of `lmsr.py`.
- Added `scripts/import-sqlite.ts` (old DB → Postgres, ids preserved, users must reset passwords) and `scripts/reset-password.ts`.
- Ported the 30 pytest tests to Vitest (57 test cases incl. auth integration) in `tests/`.
- Added this file, `CLAUDE.md`, installed skills via skills.sh (`npx skills`), `docker-compose.yml`, `vercel.json` (daily finalize cron).
- Removed: `app.py`, `lmsr.py`, `seed.py`, `schema.sql`, `templates/`, `static/`, `tests/test_market.py`, `requirements.txt` (still on `main`).
