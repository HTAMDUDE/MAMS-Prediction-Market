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

Built with **Next.js** (TypeScript, Tailwind, App Router), **better-auth**, **Prisma + PostgreSQL**, **shadcn/ui**,
**Recharts** and **zod**. The original Flask + SQLite version is on the `main` branch. AI agents working on this repo
should read [`AGENTS.md`](AGENTS.md) first.

## Running it locally

Requires Node 22.13+, pnpm and Docker.

```bash
pnpm install
cp .env.example .env                     # then set BETTER_AUTH_SECRET to a long random string
docker compose up -d db                  # Postgres on localhost:5433
docker compose exec db createdb -U mams mams_test   # once, for the test suite
pnpm db:migrate                          # create the tables
pnpm db:seed                             # optional: adds 5 example markets
pnpm dev                                 # http://localhost:3000
```

**The owner is the account whose username matches `MAMS_OWNER`** (default `Kaushik`; set it to your username, or leave it
empty to make the first account the owner). To make more usernames admins when they sign up, set
`MAMS_ADMINS=alice,bob`.

### Roles

| Role | Can do |
|---|---|
| **Owner** (one person) | Everything admins can, plus add/remove admins and manage other admins. Nobody can demote, ban, block or change the owner's balance. |
| **Admin** | Run markets (create, edit, approve proposals, resolve, cancel, delete) and manage **regular users** (balances, bans, blocks, password resets). Can't act on the owner or other admins, and can't create admins. |
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
| **Adjust balance / Make admin** (admins: owner only) | Admin page → Users | Add or remove MAMS Bucks, or promote/demote other users. |

When betting closes, a market moves to **Awaiting result**. An admin proposes the result, there is a 24-hour challenge
window (anyone who traded in the market can dispute it), and then winners are paid automatically. Finalizing happens on
the next page load after the window ends, with a daily cron as a backup, so no always-on worker is needed.

Trades by admins and by the market's creator are labelled on the market page so everyone can see them. Block someone
from a market if they know the answer ahead of time. The site also has a **How it works** page (`/how-it-works`).

Users can have up to 5 proposals waiting at once, and can withdraw a proposal until it's reviewed.

## Deploying: Vercel (app) + Railway (database)

**1. Database (Railway).** Create a project → **New → Database → PostgreSQL**. From the database's **Connect** tab copy
the **public** connection URL (`postgresql://…`). You'll paste it into Vercel as `DATABASE_URL`.

**2. App (Vercel).** Import the repo (branch `port`, or merge it into `main` first) as a Next.js project. The build
command is already `pnpm build`, which runs `prisma generate`, `prisma migrate deploy` (creates/updates the tables) and
`next build`. Add these environment variables (Project → Settings → Environment Variables):

| Variable | Value |
|---|---|
| `DATABASE_URL` | Railway's public connection URL |
| `BETTER_AUTH_SECRET` | a long random string (`openssl rand -base64 32`) |
| `BETTER_AUTH_URL` | your production URL, e.g. `https://mams-market.vercel.app` (or your custom domain) |
| `MAMS_OWNER` | the owner's username |
| `MAMS_ADMINS` | optional, comma-separated usernames |
| `CRON_SECRET` | a long random string (Vercel then authenticates the daily cron call with it) |
| `MAMS_TZ` | optional, defaults to `America/New_York` |

Preview deployments on `*.vercel.app` are accepted automatically (via Vercel's `VERCEL_URL` variables). If you use a
custom domain, set `BETTER_AUTH_URL` to it. Register the owner's account right away.

**3. Moving data from the old Flask site (optional).** Copy `instance/mams.db` from the old server, then, with
`DATABASE_URL` pointing at the new (empty) database:

```bash
pnpm import:sqlite path/to/mams.db       # markets, bets, history, comments, proposals, disputes, blocks, bans
pnpm reset-password <owner username>     # prints a temporary password; sign in and change it
```

Old password hashes can't be reused, so after importing every user needs a new password: reset them from
Admin → Users → Reset (or `pnpm reset-password <username>`), then send them the temporary password. Imported markets keep
their ids and prices, and users keep their balances, positions and history.

**Backups:** use Railway's database backups, or `pg_dump "$DATABASE_URL" > backup.sql`.

## Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | (required) | Postgres connection string |
| `TEST_DATABASE_URL` | local `mams_test` | Database the Vitest suite uses (applies migrations, truncates tables per test; never use real data) |
| `BETTER_AUTH_SECRET` | (required) | Signs sessions |
| `BETTER_AUTH_URL` | `http://localhost:3000` | The site's public URL (also the trusted origin for sign-in) |
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
