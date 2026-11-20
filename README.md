# MAMS Prediction Market

A website where students can bet virtual **MAMS Bucks** on Mass Academy events: snow days, competition results,
assemblies, and anything else the admins post.

- Everyone starts with **Ⓜ1,000** and can claim **Ⓜ100 free each day**.
- Most markets are **Yes/No**; some are multiple choice with 2–8 outcomes. Every market has written rules (what counts
  as YES, the source, edge cases). You buy shares in an outcome, and each share pays **Ⓜ1** if that outcome happens.
- Prices are set by an automated market maker (LMSR, see `src/lib/lmsr.ts`), so you never need someone to bet against.
  Buying an outcome raises its price, and all prices in a market add up to 100%, so you can read them as the
  school's estimated probability.
- You can sell shares back at the current price any time before the market closes.
- Anyone can **propose a market** from the Propose page. It goes live once an admin approves it.
- Results are **proposed** by an admin and can be **disputed** for 24 hours before winners are paid.
- Admins create, edit, cancel and delete markets, and propose results (see [Admin guide](#admin-guide)).
- The site also has a leaderboard (ranked by net worth), a portfolio page, a price-history chart and comments on
  each market.
- Accounts use a username and password, and new accounts must **verify their email** (a link sent through
  [Resend](https://resend.com)) before they can log in. Emails are never shown to other players.

Built with **Next.js** (TypeScript, Tailwind, App Router), **better-auth**, **Prisma + PostgreSQL**, **shadcn/ui**,
**Recharts**, **zod** and **Resend**. The original Flask + SQLite version is on the `main` branch. AI agents working on this repo
should read [`AGENTS.md`](AGENTS.md) first.

## Setup

**→ [SETUP.md](SETUP.md) is the full step-by-step guide** for running it locally and for deploying it (Vercel +
Railway + Resend), with a troubleshooting table.

Local quick start (Node 22.13+, pnpm, Docker):

```bash
pnpm install
cp .env.example .env                     # then set BETTER_AUTH_SECRET and MAMS_OWNER
docker compose up -d db                  # Postgres on localhost:5433
docker compose exec db createdb -U mams mams_test   # once, for the test suite
pnpm db:migrate                          # create the tables
pnpm db:seed                             # optional: adds 5 example markets
pnpm dev                                 # http://localhost:3000
```

Locally, verification emails are **printed in the terminal** running `pnpm dev` (no Resend account needed).

**The owner is the account whose username matches `MAMS_OWNER`** (default `Kaushik`; set it to your username, or leave it
empty to make the first account the owner). To make more usernames admins when they sign up, set
`MAMS_ADMINS=alice,bob`.

### Roles

| Role | Can do |
|---|---|
| **Owner** (one person) | Everything admins can, plus add/remove admins and manage other admins. Nobody can demote, ban, block or change the owner's balance. |
| **Admin** | Run markets (create, edit, approve proposals, resolve, cancel, delete) and manage **regular users** (balances, bans, blocks, mutes, password resets, email fixes, account deletion) and moderate comments. Can't act on the owner or other admins, and can't create admins. |
| **User** | Bet, comment and propose markets. |

## Admin guide

Admins see an **Admin** link in the top bar.

| Action | Where | What happens |
|---|---|---|
| **Review proposals** | Admin page → "Proposals waiting for approval" (the Admin link shows a count) | Open a proposal, fix anything you want, then **Approve & publish** (it goes live immediately, credited to the proposer) or **Reject**. You can leave a note the proposer will see. One admin's decision is final. |
| **Create** | Admin page | Choose Yes/No (the default) or multiple choice, then write the rules (“Resolves YES if…”, source, edge cases), category, closing time and liquidity. |
| **Edit** | Admin page or the market's page | Question, category and closing time can always change. Before anyone bets, the written rules, outcomes and liquidity can change too. After the first bet the rules are **locked**; use **Clarify the rules** on the market's page to add a dated note instead. After the first bet, outcomes can only be renamed, so earlier bets stay fair. Moving the closing time later reopens a closed market. |
| **Propose result** | Admin page or the market's page, after betting closes | Pick the winning outcome. Nobody is paid yet: traders get 24 hours to dispute it. With no dispute, the result finalizes by itself and each winning share pays Ⓜ1. Until then you can **withdraw** it or **propose a different outcome** (which restarts the 24 hours). |
| **Review a dispute** | The market's page (a “Disputed” badge appears on the Admin page) | A dispute pauses finalizing. **Confirm result & pay out** settles it immediately, or propose a different outcome. Once a market is finalized it can't be undone. |
| **Cancel & refund** | The market's page | Stops the market and refunds everyone's net spend. The market stays visible under "All". |
| **Delete** | Admin page or the market's page | Removes the market completely. Unresolved markets refund bets first; payouts from resolved markets are kept. |
| **Block from one market** | The market's page → Admin → "Blocked from this market" | Stops that person betting on this market (e.g. someone who already knows the answer). Any bets they placed here are refunded and removed, which also undoes their effect on the price. Can be undone with Unblock. |
| **Ban from trading** | Admin page → Users → Trading | Stops someone betting anywhere. Their bets in every unresolved market are refunded and removed. Already-resolved markets are not changed. Click **Allow** to lift the ban. |
| **Reset a password** | Admin page → Users → Password | Gives the user a temporary password (shown once) and signs them out. They can change it on their Portfolio page. |
| **Find a user** | Admin page → Users | Search by username or email, filter (admins, banned, muted, email not verified), 25 per page. Click **Manage** on a row for everything below. Emails are visible to admins only. |
| **Fix or verify an email** | Users → Manage → Email | **Change email** (for a typo, or to give an imported account one) sends a verification link to the new address and they can't log in until they use it. **Resend verification** and **Mark as verified** (when you know the address is theirs) unblock people who are stuck. |
| **Mute from commenting** | Users → Manage → Trading and commenting | Stops someone commenting without touching their trading. Undo with **Allow commenting**. |
| **Delete an account** | Users → Manage → Danger zone | Removes the account, comments and proposals. Their bets in unresolved markets are reversed and prices restored; payouts already made are kept. Admins must be demoted first; the owner and your own account can't be deleted. |
| **Moderate comments** | Market page → Discussion | **Hide** a comment (only admins can read it, others see “hidden by an admin”) or **Delete** it for good. Same permissions as for people: admins moderate regular users and themselves; only the owner moderates admins. |
| **Close betting early / Reopen** | Market page → Admin | **Close betting now** moves the market to *Awaiting result*. **Reopen betting** (on a closed market, with no proposed result) sets a new closing time. |
| **Feature a market** | Market page → Admin | Featured markets are pinned first on the home page and marked ★. |
| **Site announcement** | Admin page → Site announcement | A banner at the top of every page (up to 300 characters) until you clear it. People already on the site see a new one on their next page load. |
| **Activity log** | Admin page → Activity log | Every admin action (who, what, to whom, when), searchable and paginated. Entries can't be edited or removed, and keep names even after an account is deleted. |
| **Adjust balance / Make admin** (admins: owner only) | Admin page → Users | Add or remove MAMS Bucks, or promote/demote other users. |

When betting closes, a market moves to **Awaiting result**. An admin proposes the result, there is a 24-hour challenge
window (anyone who traded in the market can dispute it), and then winners are paid automatically. Finalizing happens on
the next page load after the window ends, with a daily cron as a backup, so no always-on worker is needed.

Trades by admins and by the market's creator are labelled on the market page so everyone can see them. Block someone
from a market if they know the answer ahead of time. The site also has a **How it works** page (`/how-it-works`).

Users can have up to 5 proposals waiting at once, and can withdraw a proposal until it's reviewed.

## Deploying: Vercel (app) + Railway (database) + Resend (email)

The short version (details, DNS records for the email domain, the first-run checklist and troubleshooting are in
**[SETUP.md → Part 2](SETUP.md#part-2-production-vercel--railway--resend)**):

1. **Railway:** provision PostgreSQL and copy its **public** connection URL.
2. **Resend:** create an API key and verify a sending domain (so you can email anyone, not just yourself).
3. **Vercel:** import the repo and set the environment variables below. The build command (`pnpm build`) creates the
   tables with `prisma migrate deploy`.
4. Sign up with the `MAMS_OWNER` username using a real email, click the link in the email, and you're the owner.

Moving data from the old Flask site is covered in [SETUP.md](SETUP.md#5-optional-move-your-old-flask-data): imported
users keep balances and history, but need a password reset (`pnpm reset-password <username>` or Admin → Users → Reset).
They have no real email, so they're marked verified and can log in without verifying.

**Backups:** use Railway's database backups, or `pg_dump "$DATABASE_URL" > backup.sql`.

## Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | (required) | Postgres connection string |
| `TEST_DATABASE_URL` | local `mams_test` | Database the Vitest suite uses (applies migrations, truncates tables per test; never use real data) |
| `BETTER_AUTH_SECRET` | (required) | Signs sessions and verification links |
| `BETTER_AUTH_URL` | `http://localhost:3000` | The site's public URL (https in production; also the trusted origin for sign-in, and the base of verification links) |
| `RESEND_API_KEY` | (empty) | Resend API key. Empty in development prints emails to the console; in production it's an error |
| `EMAIL_FROM` | `onboarding@resend.dev` in dev | Sender, on a domain verified in Resend, e.g. `MAMS Prediction Market <noreply@mail.example.com>`. Required in production |
| `MAMS_OWNER` | `Kaushik` | Username of the site owner; empty = first account |
| `MAMS_ADMINS` | (empty) | Comma-separated usernames that become admins when they sign up |
| `MAMS_TZ` | `America/New_York` | Time zone for closing times and the daily bonus |
| `CRON_SECRET` | (empty) | Authorizes `/api/cron/finalize` |

Starting balance, daily bonus and the category list are constants in `src/lib/constants.ts`.

## Tests

```bash
docker compose up -d db
pnpm test
```

The suite runs against the Postgres in `TEST_DATABASE_URL` and covers the market-maker math, trading, resolution and
disputes, rule locking, proposals, blocks and bans, owner permissions, form validation, school time and the sign-up /
sign-in / lockout flow through better-auth.

## Project layout

```
prisma/               schema, migrations, example-market seed
scripts/              SQLite import, password reset
src/lib/              LMSR math, constants, validation (zod), auth, time and formatting helpers
src/server/services/  all business logic (trading, resolution, moderation, proposals, portfolio)
src/server/actions/   server actions behind the forms
src/app/              pages and API routes
src/components/       UI (shadcn/ui in components/ui)
tests/                Vitest suites
```

## How the pricing works

With `q_i` the shares sold of outcome *i* and liquidity `b`:

```
cost(q)  = b · ln Σ exp(q_i / b)
price_i  = exp(q_i / b) / Σ exp(q_j / b)
```

Buying Δ shares costs `cost(q + Δ) − cost(q)`. Larger `b` (the "Liquidity" setting when creating a market) means
prices move less per bet. The presets are Low/Medium/High = 150/300/600 for a yes/no market and scale with
`log2(number of outcomes)`, so a bet moves an 8-way market about as much as a 2-way one (a Ⓜ100 bet moves a fresh
Medium yes/no market from 50% to about 64%). Open bets are valued at what they would *sell* for right now (not
shares × price, which a trader's own buy would inflate), so net worth can't be gamed by buying. The house can lose at
most `b · ln(number of outcomes)` per market, which is fine because the money isn't real.
