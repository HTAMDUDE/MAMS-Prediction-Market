# MAMS Prediction Market

A website where students can bet virtual **MAMS Bucks** on Mass Academy events: snow days, competition results,
assemblies, and anything else the admins post.

- Everyone starts with **Ⓜ1,000** and can claim **Ⓜ100 free each day**.
- Most markets are **Yes/No**; some are multiple choice with 2–8 outcomes. Every market has written rules (what counts
  as YES, the source, edge cases). You buy shares in an outcome, and each share pays **Ⓜ1**
  if that outcome happens.
- Prices are set by an automated market maker (LMSR, see `lmsr.py`), so you never need someone to bet against.
  Buying an outcome raises its price, and all prices in a market add up to 100%, so you can read them as the
  school's estimated probability.
- You can sell shares back at the current price any time before the market closes.
- Anyone can **propose a market** from the Propose page. It goes live once an admin approves it.
- **Fees reward good markets:** making a market costs Ⓜ10 (refunded if a proposal is withdrawn, kept if rejected),
  and every trader pays the market's creator Ⓜ10 on their first bet in it. Cancelled or deleted markets return
  entry fees. Market makers must also place an **opening bet of at least Ⓜ10** on an outcome of their own market
  (held with a proposal and placed on approval; refunded if rejected or withdrawn). Amounts are `CREATION_FEE`,
  `ENTRY_FEE` and `CREATOR_MIN_BET` in `app.py`; the dispute window is `DISPUTE_WINDOW`.
- **Leftover pot goes to winners:** when a market resolves, each winning share pays Ⓜ1 out of the pot (everything
  traders put in, minus what they got back by selling). Anything left over is split among the winners in proportion
  to their *unhedged* winning shares: shares held on every outcome at once are risk-free (a full set always costs
  and pays exactly Ⓜ1), so they don't earn a bonus. If the pot is short, the house covers it.
- A **late trading fee** discourages trading right before betting closes: `0.07 × shares × P × (1 − P) × T`, where P
  is the trade's average price per share and T is 0 with more than 2 hours left, 2 at 1–2 hours, 4 at 30–60 minutes
  and 6 in the last 30 minutes. Buys pay at least `0.017 × shares × P² × T`, so near-certain outcomes can't be
  sniped cheaply at the last minute. Charged on buys (added) and sells (deducted) and paid to the market's creator (on markets with no
  creator, or when creators trade their own market late, it isn't paid to anyone). Set by
  `LATE_FEE_RATE`, `LATE_SNIPE_RATE` and `LATE_FEE_TIERS` in `app.py`.
- **Loans**: on the Loans page players can lend each other money at a flat interest rate they choose (0–100%),
  to one player or to anyone, for 1–30 days. The lender's money is held until the offer is taken. Borrowers can repay
  early or in parts; after the due date whatever is still owed is taken from the borrower's cash automatically
  (including money they get later). Loans count towards net worth. Limits are `LOAN_MIN`, `LOAN_MAX_RATE` and
  `LOAN_MAX_DAYS` in `app.py`.
- The **Activity** page lists every trade made on the site (who, what, which market, how much), with filters by
  buys/sells, trader and market. **Your balance history** (linked from it) logs every change to your own balance
  (buys, sells, payouts, losses, refunds, bonuses, admin adjustments) with your balance after each one. Admins can
  open anyone's balance history from the Users table.
- The bet form shows exactly what you pay (or receive), what you'd win or lose, and your balance afterwards.
- Three market types: **Yes/No**, **Over/Under** (bet whether a number lands above or below a line, like a class
  average over/under 85%) and **multiple choice**.
- Results are **proposed** by an admin and can be **disputed** for 2 hours before winners are paid.
- Admins create, edit, cancel and delete markets, and propose results (see [Admin guide](#admin-guide)).
- It's an **installable app** (PWA): "Install app" in the account menu (Chrome, Edge, Android) or Share → Add to
  Home Screen (iPhone). It opens full screen with its own icon and shows an offline page without a connection. Pages
  are never cached (prices, balances and form tokens must be live); only static files are, under versioned URLs, so a
  deploy is picked up on the next load. Browsers only allow this over **HTTPS** or on `localhost`, so it won't show
  up at `http://<your-computer's-IP>:8000`. See `templates/sw.js` and the PWA routes in `app.py`.
- The site also has a leaderboard (ranked by net worth), a portfolio page, a price-history chart and comments on
  each market.

Built with Python, Flask and SQLite, with no front-end framework or build step.

## Running it

Requires Python 3.10 or newer.

```bash
git clone <this repo's URL>
cd <repo folder>
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python seed.py        # optional: adds 5 example markets
.venv/bin/python app.py         # http://localhost:8000
```

Other people on the same network can open `http://<your-computer's-IP>:8000`.
(Port 5000 isn't used because macOS's AirPlay Receiver already takes it.)

**The owner is the account named `Kaushik`** (`OWNER_USERNAME` in `app.py`; override with `MAMS_OWNER`, or set it
empty to make the first account the owner). To make specific usernames admins when they sign up, set
`MAMS_ADMINS=alice,bob`.

### Accounts and email

Anyone can sign up with a username, email and password. Every account needs a **confirmed email**: after signing up
(or, for accounts made before emails existed, after logging in) people are sent to **Confirm your email**, where they
type a 6-digit code we email them. Until then they can't use the rest of the site. When emails were introduced,
everyone was logged out once so they'd be asked for one. Each email can belong to one account, and people can change
theirs from Portfolio.

Every confirmed email is saved in the database and written to **`instance/people.csv`** (`name,email` for every
account, blank until confirmed). `instance/` is ignored by Git, so names and emails never reach GitHub.

Configure `MAMS_SMTP_HOST`, `MAMS_SMTP_PORT` (defaults to `587`), `MAMS_SMTP_USERNAME`, `MAMS_SMTP_PASSWORD`, and
`MAMS_SMTP_FROM` for the code emails (for Gmail: `smtp.gmail.com`, and an app password from
`https://myaccount.google.com/apppasswords`, which needs 2-Step Verification). Automated tests never send email.
To try it locally without sending anything, start the app with `MAMS_EMAIL_BACKEND=console`; codes are printed in the
server terminal instead. On Windows, `.\scripts\setup-gmail-smtp.ps1` sets up real Gmail delivery for a local server.

### Roles

| Role | Can do |
|---|---|
| **Owner** (one person) | Everything admins can, plus add/remove admins and manage other admins. Nobody can demote, ban, block or change the owner's balance. |
| **Admin** | Run markets (create, edit, approve proposals, resolve, cancel, delete) and manage **regular users** (balances, bans, mutes, password resets, account deletion) and moderate comments. Can't act on the owner or other admins, and can't create admins. Every action is recorded in the Admin log. |
| **User** | Bet, comment and propose markets. |

Use `.venv/bin/python`, not plain `python3`, so the app runs with the Flask installed in the virtual environment.
After changing any code, stop the server (Ctrl+C) and start it again.

## Admin guide

Admins see an **Admin** link in the top bar.

| Action | Where | What happens |
|---|---|---|
| **Review proposals** | Admin page → "Proposals waiting for approval" (the Admin link shows a count) | Open a proposal, fix anything you want, then **Approve & publish** (it goes live immediately, credited to the proposer) or **Reject**. You can leave a note the proposer will see. One admin's decision is final. |
| **Create** | Admin page | Choose Yes/No (the default), Over/Under (enter the line and an optional unit) or multiple choice, then write the rules (“Resolves YES if…”, source, edge cases), category and closing time. |
| **Edit** | Admin page or the market's page | Question, category and closing time can always change. Before anyone bets, the written rules and outcomes can change too. After the first bet the rules are **locked**; use **Clarify the rules** on the market's page to add a dated note instead. After the first bet, outcomes can only be renamed, so earlier bets stay fair. Moving the closing time later reopens a closed market. |
| **Convert to Over/Under** | The market's page → Admin | Turns an open Yes/No market about a number into Over/Under. Enter the line and unit and say whether YES meant Over or Under; everyone's bets and the current price carry over, and a dated clarification records the change. |
| **Resolve an Over/Under** | The market's page → Admin | Type the actual number. Above the line → Over wins, below → Under. Exactly on the line is a tie ("push"): use Cancel & refund. Use a line ending in .5 to avoid ties. |
| **Propose result** | Admin page or the market's page, after betting closes | Pick the winning outcome. Nobody is paid yet: traders get 2 hours to dispute it. With no dispute, the result finalizes by itself and each winning share pays Ⓜ1. Until then you can **withdraw** it or **propose a different outcome** (which restarts the 2 hours). |
| **Review a dispute** | The market's page (a “Disputed” badge appears on the Admin page) | A dispute pauses finalizing. **Confirm result & pay out** settles it immediately, or propose a different outcome. Once a market is finalized it can't be undone. |
| **Cancel & refund** | The market's page | Stops the market and refunds everyone's net spend. The market stays visible under "All". |
| **Delete** | Admin page or the market's page | Removes the market completely. Unresolved markets refund bets first; payouts from resolved markets are kept. |
| **Block from one market** | The market's page → Admin → "Blocked from this market" | Stops that person betting on this market (e.g. someone who already knows the answer). Any bets they placed here are refunded and removed, which also undoes their effect on the price. Can be undone with Unblock. |
| **Ban from trading** | Admin page → Users → Trading | Stops someone betting anywhere. Their bets in every unresolved market are refunded and removed. Already-resolved markets are not changed. Click **Allow** to lift the ban. |
| **Find and manage users** | Admin page → Users | Search by username, filter (everyone / admins / banned / muted), 25 per page. **Manage** opens a page for one user: adjust balance (adds or removes; never below Ⓜ0), ban or allow trading, mute or allow commenting, **reset password**, make or remove admin (owner only) and **delete account**. Admins can manage regular users; only the owner can manage admins or the owner. |
| **Reset a password** | Manage user → Reset password, or `python reset_password.py <username>` on the server | Shows a temporary 12-character password once and signs that user out everywhere. The CLI works even if the owner is locked out. Users can change their own password on the Portfolio page (that also signs out their other devices). |
| **Delete an account** | Manage user → Delete account | Their bets in unresolved markets are reversed and refunded first (prices go back as if they never bet); payouts from settled markets stay. Refused for yourself, the owner, admins (demote them first), people with an open dispute, and people who created a market that is still running (resolve or cancel it first). |
| **Moderate comments** | Under each comment on a market page | **Hide** (others see "This comment was hidden by an admin"; admins still see it), **Unhide**, or **Delete**. Admins can moderate regular users' comments and their own; the owner can moderate anyone's. Muted users can't post. |
| **Close early / Reopen / Feature** | Market page → Admin → Market controls | **Close betting now** stops betting so you can propose a result. **Reopen** a closed market with a new closing time (not while a result is proposed). **Feature** pins a market first on the Open tab with a ★ badge. |
| **Announcement** | Admin page → Site announcement | Up to 300 characters, shown under the top bar on every page until cleared. |
| **Admin log** | Admin page → Admin log (`/admin/log`) | Every admin action, who did it, and what changed. Searchable, 50 per page, and it can't be edited. The separate **Activity** page is the trade feed. |

When betting closes, a market moves to **Awaiting result**. An admin proposes the result, there is a 2-hour challenge window (anyone who traded in the market can dispute it), and then winners are paid automatically. Finalizing happens on the next page load after the window ends, so no background job is needed.

Trades by admins and by the market's creator are labelled on the market page so everyone can see them. Block someone from a market if they know the answer ahead of time. The site also has a **How it works** page (`/how-it-works`) that explains prices, the market maker, rules and disputes to users.

**Upgrading an existing site:** just pull the new code and reload. The database gets its new columns automatically on start-up and nothing needs to be run by hand.

Users can have up to 5 proposals waiting at once, and can withdraw a proposal until it's reviewed.

**Price protection:** the bet form sends the quoted amount with a 2% tolerance; if the price moves further than that before you press Buy or Sell, the trade is refused and you can re-check the quote. Sells worth under Ⓜ0.01 are refused.

## Deploying on PythonAnywhere (free)

Replace `USERNAME` below with your PythonAnywhere username.

**1. Get the code.** On pythonanywhere.com, open **Consoles → Bash** and run:

```bash
git clone https://github.com/TheSuperiorCoder/MAMS-Prediction-Market.git
cd MAMS-Prediction-Market
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python seed.py      # optional example markets
```

The repo is private, so `git clone` asks for a username and password. Enter your GitHub username, and for the
password paste a **personal access token** (GitHub → Settings → Developer settings → Personal access tokens →
Fine-grained → read-only access to this repo's contents). Your normal GitHub password won't work.

**2. Create the web app.** Go to the **Web** tab → **Add a new web app** → **Manual configuration** (not "Flask")
→ **Python 3.12**.

**3. Configure it** on the same Web tab:

- **Virtualenv:** `/home/USERNAME/MAMS-Prediction-Market/.venv`
- **Static files:** URL `/static/` → directory `/home/USERNAME/MAMS-Prediction-Market/static`
- **Force HTTPS:** turn it on.
- **WSGI configuration file:** click the link, delete everything in it, and paste:

  ```python
  import os
  import sys

  path = "/home/USERNAME/MAMS-Prediction-Market"
  if path not in sys.path:
      sys.path.insert(0, path)

  os.environ["MAMS_PRODUCTION"] = "1"   # secure cookies + correct visitor IPs behind PythonAnywhere's proxy
  os.environ["MAMS_OWNER"] = "yourusername"  # the site owner (can't be removed by other admins)

  from app import app as application
  ```

**4. Click the green Reload button** and open `https://USERNAME.pythonanywhere.com`. Sign up as `Kaushik`
(the owner and admin) if that account doesn't exist yet. Add the `MAMS_SMTP_*` settings below to the WSGI file
first, so the email confirmation codes can be sent.

**Updating after you push changes to GitHub:**

```bash
cd ~/MAMS-Prediction-Market && git pull && .venv/bin/pip install -r requirements.txt
```

Then click **Reload** on the Web tab. The database (`instance/mams.db`) isn't in git, so pulling never touches
accounts or bets.

**Keeping it running:** free web apps switch off after 3 months unless you log in and click
**"Run until 3 months from today"** on the Web tab. PythonAnywhere emails you a reminder before that.

**Backups:** download `instance/mams.db` from the **Files** tab now and then.

## Settings (environment variables)

| Variable      | Default              | Purpose                                             |
|---------------|----------------------|-----------------------------------------------------|
| `PORT`        | `8000`               | Port to listen on                                   |
| `MAMS_DB`     | `instance/mams.db`   | SQLite database file                                |
| `MAMS_OWNER`  | `Kaushik`            | Username of the site owner (set it empty to make the first account the owner) |
| `MAMS_ADMINS` | (empty)              | Comma-separated usernames that become admins        |
| `SECRET_KEY`  | auto-generated       | Session signing key (saved to `instance/secret_key`)|
| `MAMS_PRODUCTION` | (off)            | Set to `1` when hosted on HTTPS: secure cookies, trust proxy IPs |
| `MAMS_TZ`     | `America/New_York`   | Time zone for closing times and the daily bonus     |

Starting balance, daily bonus and the category list are constants at the top of `app.py`.

## Security

- **Claim the owner and admin accounts right after deploying.** Owner and admin rights go to whoever signs up
  first with the `MAMS_OWNER` username or a name in `MAMS_ADMINS`, so create those accounts before sharing the link.
- Every page is sent with a Content-Security-Policy (scripts only from this site, plus inline `<script>` tags that
  carry `nonce="{{ csp_nonce() }}"`; fonts only from Google Fonts), can't be shown inside another site's frame, and
  personal pages aren't kept in the browser cache. If you add a new outside script, font or stylesheet, add its
  origin to `CSP` in `app.py`; new inline scripts need the nonce.
- Log-in, sign-up, email codes, comments and disputes are rate limited. `next=` links only go to pages on this site.
- Form posts over 256 KB are refused. Passwords are 6–128 characters.
- `instance/` (database, `secret_key`, `people.csv`) and `.env` are never committed; `secret_key` and `people.csv`
  are readable only by the server's account.

## Tests

```bash
.venv/bin/python -m pytest        # tests/test_market.py (core rules) and tests/test_improvements.py (admin controls, safeguards)
```

## Project layout

```
app.py          Flask routes, trading, resolution, admin tools, auth
lmsr.py         Market-maker math (prices, cost to buy, value when selling)
schema.sql      Database tables
seed.py         Example markets
reset_password.py  Give a user a temporary password (python reset_password.py <username>)
templates/      HTML pages (Jinja)
static/         CSS and the chart / trade-preview JavaScript
tests/          pytest suite
```

## How the pricing works

With `q_i` the shares sold of outcome *i* and liquidity `b`:

```
cost(q)  = b · ln Σ exp(q_i / b)
price_i  = exp(q_i / b) / Σ exp(q_j / b)
```

Buying Δ shares costs `cost(q + Δ) − cost(q)`. Larger `b` means prices move less per bet. Every market uses
`b = 1000 × log₂(number of outcomes)` (set by `BASE_LIQUIDITY` in `app.py`), so on a 50/50 yes/no market a Ⓜ100 bet
moves the price to about 55% and an all-in Ⓜ1,000 bet to about 82%. The house can lose at most `b · ln(outcomes)` per
market, which is fine because the money isn't real.

When the app starts, any unsettled market created with a lower `b` is upgraded: the market maker's share counts are
scaled up by the same factor, so current prices don't change, but future bets move them less.