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
- Results are **proposed** by an admin and can be **disputed** for 24 hours before winners are paid.
- Admins create, edit, cancel and delete markets, and propose results (see [Admin guide](#admin-guide)).
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

**The first account you register becomes the owner.** To pick the owner by name instead, set
`MAMS_OWNER=yourusername`. To make specific usernames admins when they sign up, set `MAMS_ADMINS=alice,bob`.

### Roles

| Role | Can do |
|---|---|
| **Owner** (one person) | Everything admins can, plus add/remove admins and manage other admins. Nobody can demote, ban, block or change the owner's balance. |
| **Admin** | Run markets (create, edit, approve proposals, resolve, cancel, delete) and manage **regular users** (balances, bans, blocks). Can't act on the owner or other admins, and can't create admins. |
| **User** | Bet, comment and propose markets. |

Use `.venv/bin/python`, not plain `python3`, so the app runs with the Flask installed in the virtual environment.
After changing any code, stop the server (Ctrl+C) and start it again.

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
| **Adjust balance / Make admin** (admins: owner only) | Admin page → Users | Add or remove MAMS Bucks, or promote/demote other users. |

When betting closes, a market moves to **Awaiting result**. An admin proposes the result, there is a 24-hour challenge window (anyone who traded in the market can dispute it), and then winners are paid automatically. Finalizing happens on the next page load after the window ends, so no background job is needed.

Trades by admins and by the market's creator are labelled on the market page so everyone can see them. Block someone from a market if they know the answer ahead of time. The site also has a **How it works** page (`/how-it-works`) that explains prices, the market maker, rules and disputes to users.

**Upgrading an existing site:** just pull the new code and reload. The database gets its new columns automatically on start-up and nothing needs to be run by hand.

Users can have up to 5 proposals waiting at once, and can withdraw a proposal until it's reviewed.

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

**4. Click the green Reload button** and open `https://USERNAME.pythonanywhere.com`. Register your account
right away, because the first account becomes the admin.

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
| `MAMS_OWNER`  | first account        | Username of the site owner                          |
| `MAMS_ADMINS` | (empty)              | Comma-separated usernames that become admins        |
| `SECRET_KEY`  | auto-generated       | Session signing key (saved to `instance/secret_key`)|
| `MAMS_PRODUCTION` | (off)            | Set to `1` when hosted on HTTPS: secure cookies, trust proxy IPs |
| `MAMS_TZ`     | `America/New_York`   | Time zone for closing times and the daily bonus     |

Starting balance, daily bonus and the category list are constants at the top of `app.py`.

## Tests

```bash
.venv/bin/python -m pytest
```

## Project layout

```
app.py          Flask routes, trading, resolution, admin tools, auth
lmsr.py         Market-maker math (prices, cost to buy, value when selling)
schema.sql      Database tables
seed.py         Example markets
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

Buying Δ shares costs `cost(q + Δ) − cost(q)`. Larger `b` (the "Liquidity" setting when creating a market) means
prices move less per bet. The presets are Low/Medium/High = 150/300/600 for a yes/no market and scale with
`log2(number of outcomes)`, so a bet moves an 8-way market about as much as a 2-way one (a Ⓜ100 bet moves a fresh
Medium yes/no market from 50% to about 64%). Open bets are valued at what they would *sell* for right now (not
shares × price, which a trader's own buy would inflate), so net worth can't be gamed by buying. The house can lose at most `b · ln(number of outcomes)` per market, which is fine
because the money isn't real.
