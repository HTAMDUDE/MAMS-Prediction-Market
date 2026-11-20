# Setup guide

How to run MAMS Prediction Market on your computer, and how to put it on the internet. New accounts must verify their
email, and emails are sent with [Resend](https://resend.com), so both parts cover that.

- [Part 1: Local development](#part-1-local-development)
- [Part 2: Production (Vercel + Railway + Resend)](#part-2-production-vercel--railway--resend)
- [Troubleshooting](#troubleshooting)
- [Environment variables](#environment-variables)

How the pieces fit together:

```
Browser ──► Vercel (Next.js app) ──► Railway (PostgreSQL)
                     │
                     └──► Resend (verification emails)
```

---

## Part 1: Local development

### What you need

- **Node.js 22.13 or newer** (`node -v`) and **pnpm** (`npm i -g pnpm`)
- **Docker Desktop** (for a throwaway local Postgres)
- Git

You do **not** need a Resend account to develop: without an API key the verification email is printed in the terminal
where `pnpm dev` is running.

### 1. Get the code and install

```bash
git clone <this repo's URL>
cd MAMS-Prediction-Market
git checkout port          # until the port is merged into main
pnpm install
```

### 2. Create your `.env`

```bash
cp .env.example .env
```

Open `.env` and set at least:

| Variable | Local value |
|---|---|
| `DATABASE_URL` | leave the default (`postgresql://mams:mams@localhost:5433/mams`) |
| `BETTER_AUTH_SECRET` | any long random string, e.g. the output of `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | `http://localhost:3000` |
| `MAMS_OWNER` | **your** username. Whoever signs up with this name becomes the owner/admin |

Leave `RESEND_API_KEY` empty for now.

### 3. Start the database and create the tables

```bash
docker compose up -d db                              # Postgres on localhost:5433
docker compose exec db createdb -U mams mams_test    # once: the database the tests use
pnpm db:migrate                                      # creates the tables
pnpm db:seed                                         # optional: 5 example markets
```

### 4. Run the app

```bash
pnpm dev
```

Open <http://localhost:3000>.

### 5. Create your owner account (and verify it)

1. Go to **Sign up**, use the username you put in `MAMS_OWNER`, any email address, and a password.
2. You land on **Check your email**. Look at the terminal running `pnpm dev`: you'll see a block like

   ```
   [email] To: you@example.com
   [email] Subject: Verify your email for MAMS Prediction Market
   ...
   http://localhost:3000/api/auth/verify-email?token=...&callbackURL=%2F%3Fverified%3D1
   ```

3. Open that link. You're verified, signed in, and the **Admin** link appears in the top bar.

Until an account is verified it can't log in; trying to log in re-sends a fresh link.

### 6. (Optional) Send real emails from your computer

1. Create a free account at <https://resend.com> and make an API key (**API Keys → Create API Key**).
2. In `.env`, set `RESEND_API_KEY="re_..."`. Leave `EMAIL_FROM` empty: local development then sends from Resend's test
   address `onboarding@resend.dev`.
3. Restart `pnpm dev`.

Resend's test address can **only deliver to the email you signed up to Resend with**. To email other people you need a
verified domain (see [Part 2, step 2](#2-resend-email)).

### 7. Run the tests

```bash
docker compose up -d db
pnpm test
```

The tests use the `mams_test` database from step 3, capture emails instead of sending them, and empty their tables as
they go, so never point `TEST_DATABASE_URL` at real data.

### Handy commands

| Command | What it does |
|---|---|
| `pnpm dev` | Dev server with hot reload |
| `pnpm lint && pnpm typecheck && pnpm test` | What must pass before committing |
| `pnpm db:migrate` | Create/apply a migration after editing `prisma/schema.prisma` |
| `pnpm db:seed` | Add the example markets (skips ones that exist) |
| `pnpm reset-password <username>` | Print a temporary password for a user (also marks their email verified: the owner's way back in) |
| `docker compose down` | Stop the database (add `-v` to also delete its data) |

---

## Part 2: Production (Vercel + Railway + Resend)

You'll create three things, in this order: a database (Railway), a way to send email (Resend), and the app (Vercel).
Budget about 30 minutes, plus DNS propagation for the email domain (usually minutes, sometimes hours).

### 1. Database (Railway)

1. Sign in at <https://railway.com> → **New Project → Provision PostgreSQL**.
2. Open the Postgres service → **Variables** (or **Connect**) and copy the **public** connection URL. It's the one with
   a `*.proxy.rlwy.net` (or similar) host, not the `railway.internal` one: Vercel is outside Railway's private network.
   It looks like `postgresql://postgres:…@…:PORT/railway`.
3. Keep it for step 3 as `DATABASE_URL`. The tables are created automatically by the first Vercel build
   (`prisma migrate deploy`), so there's nothing to run by hand.

### 2. Resend (email)

1. Sign in at <https://resend.com> → **API Keys → Create API Key** (permission: *Sending access* is enough). Copy the
   key (`re_…`); you can't view it again.
2. **Add your domain**: **Domains → Add Domain**. Use a domain you control (a subdomain such as `mail.example.com` works
   well and keeps your main domain's email separate). Resend shows DNS records (SPF, DKIM, and optionally DMARC/MX).
3. **Add those records** at your DNS provider (Cloudflare, Namecheap, Google Domains, …) exactly as shown, then click
   **Verify** in Resend. Wait until the domain shows **Verified**.
4. Pick the sender address, e.g. `MAMS Prediction Market <noreply@mail.example.com>`. This becomes `EMAIL_FROM`.

Why a domain: without one, Resend only allows its test sender `onboarding@resend.dev`, which can deliver **only to your
own Resend account email**. Real players would never receive their verification link. Check Resend's current plan
limits (daily/monthly sends) against how many people will sign up.

### 3. App (Vercel)

1. Push the repo to GitHub, then at <https://vercel.com> → **Add New → Project** → import it. Framework: *Next.js*
   (detected). Leave the build settings alone: the build command is already `pnpm build`
   (`prisma generate && prisma migrate deploy && next build`).
2. Before the first deploy, open **Environment Variables** and add (for *Production*; add to *Preview* too if you want
   preview deployments to work):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Railway's **public** URL from step 1 |
   | `BETTER_AUTH_SECRET` | a long random string: `openssl rand -base64 32` (keep it secret; changing it logs everyone out) |
   | `BETTER_AUTH_URL` | the final **https** address, e.g. `https://mams.example.com` (or the `*.vercel.app` URL if you aren't using a domain yet). Verification links are built from this, so it must be right |
   | `MAMS_OWNER` | the owner's username |
   | `MAMS_ADMINS` | optional: comma-separated usernames that become admins when they sign up |
   | `RESEND_API_KEY` | the key from Resend |
   | `EMAIL_FROM` | e.g. `MAMS Prediction Market <noreply@mail.example.com>` |
   | `CRON_SECRET` | a long random string (Vercel uses it to authenticate the daily finalize job) |
   | `MAMS_TZ` | optional, defaults to `America/New_York` |

3. Click **Deploy**. In the build log you should see `prisma migrate deploy` apply the migrations.
4. **Custom domain (optional):** Project → **Settings → Domains → Add**. Then set `BETTER_AUTH_URL` to it and
   **redeploy** (env var changes only apply to new deployments).

### 4. First run checklist

1. Open your site → **Sign up** with the username you set in `MAMS_OWNER` and a **real email you can read**.
2. The **Check your email** page appears. The email should arrive within a minute (check spam the first time).
3. Click the link → you're signed in as the owner and see **Admin** in the top bar.
4. Open **Admin**, create a market, then try signing up a second test account with another real address to confirm
   verification works for regular users.
5. In the Vercel project → **Settings → Cron Jobs**, confirm the `/api/cron/finalize` job exists (it's defined in
   `vercel.json`).

### 5. (Optional) Move your old Flask data

Copy `instance/mams.db` from the old server, then, with `DATABASE_URL` set to the new (empty) database:

```bash
DATABASE_URL="<railway public url>" pnpm import:sqlite path/to/mams.db
DATABASE_URL="<railway public url>" pnpm reset-password <owner username>   # prints a temporary password
```

Old passwords can't be reused, so every imported user needs a new one: use **Admin → Users → Reset** (or the command
above) and send them the temporary password. Imported accounts have no real email; they're marked verified with a
placeholder address so they can log in. Only accounts created from now on go through email verification.

### Updating the site

Merge to the branch Vercel deploys. Each deploy runs `prisma migrate deploy`, so new migrations apply automatically
before the new code goes live. Your data is never touched by a deploy.

### Backups

Use Railway's database backups, or `pg_dump "$DATABASE_URL" > backup.sql`.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| **Sign-up or login says "Invalid origin"** (403) | The address in the browser isn't `BETTER_AUTH_URL` (wrong port locally, `www.` vs bare domain, or the env var wasn't redeployed). Set it to exactly what's in the address bar. |
| **No verification email in production** | Look at Vercel → **Logs** for `Could not send verification email`. `RESEND_API_KEY is not set` / `EMAIL_FROM is not set` = missing env var (redeploy after adding). `Resend rejected the email` = see Resend's message: usually the domain isn't verified yet or `EMAIL_FROM` isn't on it. Also check Resend → **Emails** for the delivery status and spam placement. |
| **Email only arrives for you** | You're still on the test sender `onboarding@resend.dev`. Verify a domain and set `EMAIL_FROM` (Part 2, step 2). |
| **No email locally** | With no `RESEND_API_KEY` it's printed in the terminal running `pnpm dev`, not sent. (A production build, `next start`, treats a missing key as an error instead.) |
| **"That verification link is invalid or has expired"** | Links last 24 hours and each is tied to the account. Just try logging in: a fresh link is emailed automatically. |
| **User can't log in: "Verify your email"** | They haven't clicked the link. They can log in again to get a new one, or use the Resend button on the Check your email page. An admin can also use **Admin → Users → Manage → Email**: *Resend verification*, or *Mark as verified* if you know the address is theirs. |
| **Wrong email typed at sign-up** | An admin fixes it: **Admin → Users → Manage → Email → Change email**. A verification link goes to the corrected address. (Or delete the stuck account under *Danger zone* and let them sign up again.) |
| **The owner is locked out** (forgotten password, or an unverified/mistyped email) | No admin can manage the owner, so run `pnpm reset-password <owner username>` with `DATABASE_URL` pointing at the database. It prints a temporary password **and marks the email verified**. |
| **Any other user forgot their password** | **Admin → Users → Manage → Password → Reset password** gives them a temporary password. |
| **Build fails at `prisma migrate deploy`** | `DATABASE_URL` is missing or is Railway's *internal* URL. Use the public one. |
| **Too many connections** | Each serverless instance keeps a pool of up to 5. On Railway's smaller plans, keep traffic reasonable or add a connection pooler (PgBouncer). |
| **Tests fail to connect** | `docker compose up -d db`, and create `mams_test` once (Part 1, step 3). |

---

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `TEST_DATABASE_URL` | for tests | Local `mams_test`; it is wiped by the test suite |
| `BETTER_AUTH_SECRET` | yes | Signs sessions and verification links |
| `BETTER_AUTH_URL` | yes | The site's public URL (https in production). Also the trusted origin for sign-in |
| `RESEND_API_KEY` | production | Without it: dev prints emails to the console, production errors |
| `EMAIL_FROM` | production | Sender on a Resend-verified domain, e.g. `Name <noreply@mail.example.com>` |
| `MAMS_OWNER` | recommended | Username of the owner. Default `Kaushik`; empty = first account |
| `MAMS_ADMINS` | no | Comma-separated usernames that become admins on sign-up |
| `MAMS_TZ` | no | Default `America/New_York` |
| `CRON_SECRET` | production | Authorizes the daily `/api/cron/finalize` backup job |
