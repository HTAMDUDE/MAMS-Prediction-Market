"""MAMS Prediction Market — bet virtual MAMS Bucks on Mass Academy events."""

import json
import math
import os
import re
import secrets
import sqlite3
import time
from datetime import date, datetime, timedelta
from functools import wraps

from flask import (Flask, abort, flash, g, jsonify, redirect, render_template,
                   request, session, url_for)
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash

import lmsr

# All times (closing times, daily bonus reset) use school time, even on servers that run in UTC.
os.environ["TZ"] = os.environ.get("MAMS_TZ", "America/New_York")
if hasattr(time, "tzset"):
    time.tzset()

# Set MAMS_PRODUCTION=1 when hosted on HTTPS behind a proxy (e.g. PythonAnywhere).
PRODUCTION = os.environ.get("MAMS_PRODUCTION") == "1"

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INSTANCE_DIR = os.path.join(BASE_DIR, "instance")
os.makedirs(INSTANCE_DIR, exist_ok=True)
DB_PATH = os.environ.get("MAMS_DB", os.path.join(INSTANCE_DIR, "mams.db"))

STARTING_BALANCE = 1000.0
DAILY_BONUS = 100.0
MIN_BET = 1.0
CURRENCY = "MAMS Bucks"
ADMIN_USERNAMES = {u.strip().lower() for u in os.environ.get("MAMS_ADMINS", "").split(",") if u.strip()}
# Liquidity presets are for a yes/no market; markets with more outcomes scale up (see market_b)
# so a bet moves an 8-way market about as much as it moves a 2-way one.
LIQUIDITY = {"low": 150.0, "medium": 300.0, "high": 600.0}


def market_b(preset, n_outcomes):
    return LIQUIDITY.get(preset, LIQUIDITY["medium"]) * math.log2(max(n_outcomes, 2))


def preset_for(b, n_outcomes):
    """The preset whose scaled liquidity is closest to a market's stored b (old markets may not match exactly)."""
    return min(LIQUIDITY, key=lambda k: abs(market_b(k, n_outcomes) - b))
CATEGORIES = ["Academics", "Competitions", "Sports", "Events", "Campus Life", "Weather", "Other"]
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,20}$")
EPS = 1e-9


def _secret_key():
    if os.environ.get("SECRET_KEY"):
        return os.environ["SECRET_KEY"]
    path = os.path.join(INSTANCE_DIR, "secret_key")
    if not os.path.exists(path):
        with open(path, "w") as f:
            f.write(secrets.token_hex(32))
    with open(path) as f:
        return f.read().strip()


app = Flask(__name__)
app.config.update(SECRET_KEY=_secret_key(), PERMANENT_SESSION_LIFETIME=timedelta(days=30),
                  SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax",
                  SESSION_COOKIE_SECURE=PRODUCTION)
if PRODUCTION:
    # Trust the hosting proxy's X-Forwarded-For / -Proto so we see real visitor IPs and HTTPS.
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)

# Simple in-memory rate limiting (one server process is plenty for a school site).
# Limits are generous because a whole school can share one public IP address.
_hits = {}


def rate_limited(key, limit, window_seconds):
    now = time.time()
    recent = [t for t in _hits.get(key, []) if now - t < window_seconds]
    limited = len(recent) >= limit
    if not limited:
        recent.append(now)
    _hits[key] = recent
    if len(_hits) > 10000:
        _hits.clear()
    return limited


# ---------------------------------------------------------------- database

def connect():
    db = sqlite3.connect(DB_PATH, isolation_level=None, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


def get_db():
    if "db" not in g:
        g.db = connect()
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = connect()
    with open(os.path.join(BASE_DIR, "schema.sql")) as f:
        db.executescript(f.read())
    db.close()


init_db()


# ---------------------------------------------------------------- helpers

def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def parse_dt(s):
    return datetime.fromisoformat(s)


def cents(x):
    return round(x + 0.0, 2)


def market_state(m):
    """open | closed (past close date, awaiting resolution) | resolved | cancelled"""
    if m["status"] in ("resolved", "cancelled"):
        return m["status"]
    return "closed" if datetime.now() >= parse_dt(m["closes_at"]) else "open"


def get_outcomes(db, market_id):
    return db.execute("SELECT * FROM outcomes WHERE market_id = ? ORDER BY position", (market_id,)).fetchall()


def bundle(db, m):
    """A market plus its outcomes and current prices, ready for templates."""
    outs = get_outcomes(db, m["id"])
    if m["status"] == "resolved":
        ps = [1.0 if o["id"] == m["resolved_outcome_id"] else 0.0 for o in outs]
    else:
        ps = lmsr.prices([o["shares"] for o in outs], m["b"])
    stats = db.execute(
        "SELECT COALESCE(SUM(ABS(amount)), 0) AS volume, COUNT(DISTINCT user_id) AS traders "
        "FROM trades WHERE market_id = ?", (m["id"],)).fetchone()
    return {
        "m": m,
        "state": market_state(m),
        "outcomes": [{"id": o["id"], "label": o["label"], "shares": o["shares"], "price": p}
                     for o, p in zip(outs, ps)],
        "volume": stats["volume"],
        "traders": stats["traders"],
    }


def snapshot_prices(db, market_id, b):
    outs = get_outcomes(db, market_id)
    ps = lmsr.prices([o["shares"] for o in outs], b)
    db.execute("INSERT INTO price_history (market_id, prices, created_at) VALUES (?, ?, ?)",
               (market_id, json.dumps([round(p, 5) for p in ps]), now_str()))


def open_book_values(db):
    """{user_id: {market_id: cash-out value}} for every unresolved market. Each value is what the user's
    whole holding in that market would sell for right now, so buying can't inflate it."""
    markets = {}
    for m in db.execute("SELECT * FROM markets WHERE status = 'open'").fetchall():
        outs = get_outcomes(db, m["id"])
        markets[m["id"]] = (m["b"], [o["shares"] for o in outs], {o["id"]: i for i, o in enumerate(outs)})
    holdings = {}  # (user_id, market_id) -> share vector
    for p in db.execute("SELECT p.user_id, p.outcome_id, p.shares, o.market_id FROM positions p "
                        "JOIN outcomes o ON o.id = p.outcome_id WHERE p.shares > 0"):
        if p["market_id"] in markets:
            b, q, index = markets[p["market_id"]]
            holdings.setdefault((p["user_id"], p["market_id"]), [0.0] * len(q))[index[p["outcome_id"]]] = p["shares"]
    result = {}
    for (uid, mid), h in holdings.items():
        b, q, _ = markets[mid]
        result.setdefault(uid, {})[mid] = lmsr.liquidation_value(q, b, h)
    return result


def net_worths(db):
    worth = {u["id"]: u["balance"] for u in db.execute("SELECT id, balance FROM users")}
    for uid, per_market in open_book_values(db).items():
        worth[uid] += sum(per_market.values())
    return worth


class TradeError(Exception):
    pass


def trade_block_reason(db, user_id, market_id):
    """Why this user can't trade in this market, or None if they can."""
    if db.execute("SELECT 1 FROM trade_bans WHERE user_id = ?", (user_id,)).fetchone():
        return "An admin has turned off trading for your account."
    if db.execute("SELECT 1 FROM market_blocks WHERE user_id = ? AND market_id = ?",
                  (user_id, market_id)).fetchone():
        return "An admin has blocked you from betting on this market."
    return None


def refund_user_in_market(db, user_id, market_id):
    """Undo a user's bets in an unresolved market: give back what they net-spent, remove their shares
    from the market (reversing their effect on prices) and erase their trades. Must run inside a
    transaction. Returns the amount refunded."""
    m = db.execute("SELECT * FROM markets WHERE id = ?", (market_id,)).fetchone()
    if m is None or m["status"] != "open":
        return 0.0  # resolved/cancelled markets are already settled
    had_trades = db.execute("SELECT 1 FROM trades WHERE user_id = ? AND market_id = ? LIMIT 1",
                            (user_id, market_id)).fetchone()
    if not had_trades:
        return 0.0
    net = db.execute("SELECT COALESCE(SUM(amount), 0) FROM trades WHERE user_id = ? AND market_id = ?",
                     (user_id, market_id)).fetchone()[0]
    for p in db.execute("SELECT p.outcome_id, p.shares FROM positions p JOIN outcomes o ON o.id = p.outcome_id "
                        "WHERE p.user_id = ? AND o.market_id = ?", (user_id, market_id)).fetchall():
        db.execute("UPDATE outcomes SET shares = shares - ? WHERE id = ?", (p["shares"], p["outcome_id"]))
    db.execute("DELETE FROM positions WHERE user_id = ? AND outcome_id IN "
               "(SELECT id FROM outcomes WHERE market_id = ?)", (user_id, market_id))
    db.execute("DELETE FROM trades WHERE user_id = ? AND market_id = ?", (user_id, market_id))
    refund = cents(max(net, 0.0))  # if they already sold at a profit, there's nothing to give back
    if refund > 0:
        db.execute("UPDATE users SET balance = ROUND(balance + ?, 2) WHERE id = ?", (refund, user_id))
    snapshot_prices(db, market_id, m["b"])
    return refund


def block_user_in_market(db, user_id, market_id):
    db.execute("BEGIN IMMEDIATE")
    try:
        db.execute("INSERT OR IGNORE INTO market_blocks (market_id, user_id, created_at) VALUES (?, ?, ?)",
                   (market_id, user_id, now_str()))
        refund = refund_user_in_market(db, user_id, market_id)
        db.execute("COMMIT")
        return refund
    except Exception:
        db.execute("ROLLBACK")
        raise


def ban_user_from_trading(db, user_id):
    """Site-wide trading ban; refunds the user's bets in every unresolved market."""
    db.execute("BEGIN IMMEDIATE")
    try:
        db.execute("INSERT OR IGNORE INTO trade_bans (user_id, created_at) VALUES (?, ?)", (user_id, now_str()))
        refund = 0.0
        for r in db.execute("SELECT DISTINCT market_id FROM trades WHERE user_id = ?", (user_id,)).fetchall():
            refund += refund_user_in_market(db, user_id, r["market_id"])
        db.execute("COMMIT")
        return refund
    except Exception:
        db.execute("ROLLBACK")
        raise


def check_trade(m, outs, idx, action, value, balance=None, held=None):
    """Validate a trade and price it. Returns (shares, coins): shares bought/sold and coins spent/received.
    Raises TradeError with a user-facing message. balance/held may be None to skip those checks
    (used for logged-out quotes). Shared by execute_trade and the /api/quote preview so they always agree."""
    q = [o["shares"] for o in outs]
    label = outs[idx]["label"]
    if action == "buy":
        amount = cents(value)
        if amount < MIN_BET:
            raise TradeError(f"Minimum bet is {MIN_BET:.0f} {CURRENCY}.")
        if balance is not None and amount > balance + EPS:
            raise TradeError("You don't have enough MAMS Bucks for that bet.")
        return lmsr.shares_for_amount(q, m["b"], idx, amount), amount
    if action == "sell":
        shares = value
        if held is not None and abs(shares - held) < 1e-6:
            shares = held
        if shares <= EPS:
            raise TradeError("Enter a number of shares to sell.")
        if held is not None and shares > held + EPS:
            raise TradeError(f"You only own {held:.2f} shares of “{label}”.")
        return shares, math.floor(lmsr.sell_value(q, m["b"], idx, shares) * 100) / 100
    raise TradeError("Unknown action.")


def execute_trade(db, user_id, market_id, outcome_id, action, value):
    """Buy (value = coins to spend) or sell (value = shares to sell). Returns a status message."""
    db.execute("BEGIN IMMEDIATE")
    try:
        m = db.execute("SELECT * FROM markets WHERE id = ?", (market_id,)).fetchone()
        if m is None:
            raise TradeError("Market not found.")
        if market_state(m) != "open":
            raise TradeError("This market is no longer accepting bets.")
        block = trade_block_reason(db, user_id, market_id)
        if block:
            raise TradeError(block)
        outs = get_outcomes(db, market_id)
        ids = [o["id"] for o in outs]
        if outcome_id not in ids:
            raise TradeError("Unknown outcome.")
        idx = ids.index(outcome_id)
        label = outs[idx]["label"]
        q = [o["shares"] for o in outs]
        user = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        pos = db.execute("SELECT * FROM positions WHERE user_id = ? AND outcome_id = ?",
                         (user_id, outcome_id)).fetchone()
        held = pos["shares"] if pos else 0.0
        held_cost = pos["cost"] if pos else 0.0

        shares, coins = check_trade(m, outs, idx, action, value, user["balance"], held)
        q[idx] += shares if action == "buy" else -shares
        now_pct = lmsr.prices(q, m["b"])[idx] * 100
        if action == "buy":
            d_shares, d_cash = shares, -coins
            new_shares, new_cost = held + shares, held_cost + coins
            msg = f"Bought {shares:.2f} shares of “{label}” for {coins:.2f} {CURRENCY} — now {now_pct:.0f}%."
        else:
            d_shares, d_cash = -shares, coins
            new_shares = held - shares
            new_cost = held_cost * (new_shares / held) if held > 0 else 0.0
            msg = f"Sold {shares:.2f} shares of “{label}” for {coins:.2f} {CURRENCY} — now {now_pct:.0f}%."

        db.execute("UPDATE outcomes SET shares = shares + ? WHERE id = ?", (d_shares, outcome_id))
        db.execute("UPDATE users SET balance = ROUND(balance + ?, 2) WHERE id = ?", (d_cash, user_id))
        if new_shares <= 1e-9:
            db.execute("DELETE FROM positions WHERE user_id = ? AND outcome_id = ?", (user_id, outcome_id))
        else:
            db.execute(
                "INSERT INTO positions (user_id, outcome_id, shares, cost) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(user_id, outcome_id) DO UPDATE SET shares = excluded.shares, cost = excluded.cost",
                (user_id, outcome_id, new_shares, new_cost))
        db.execute("INSERT INTO trades (user_id, market_id, outcome_id, shares, amount, created_at) "
                   "VALUES (?, ?, ?, ?, ?, ?)", (user_id, market_id, outcome_id, d_shares, -d_cash, now_str()))
        snapshot_prices(db, market_id, m["b"])
        db.execute("COMMIT")
        return msg
    except Exception:
        db.execute("ROLLBACK")
        raise


def resolve_market(db, market_id, outcome_id):
    db.execute("BEGIN IMMEDIATE")
    try:
        m = db.execute("SELECT * FROM markets WHERE id = ?", (market_id,)).fetchone()
        if m is None or m["status"] != "open":
            raise TradeError("Only unresolved markets can be resolved.")
        if outcome_id not in [o["id"] for o in get_outcomes(db, market_id)]:
            raise TradeError("Unknown outcome.")
        winners = db.execute("SELECT user_id, shares FROM positions WHERE outcome_id = ?", (outcome_id,)).fetchall()
        for w in winners:
            db.execute("UPDATE users SET balance = ROUND(balance + ?, 2) WHERE id = ?", (w["shares"], w["user_id"]))
        db.execute("UPDATE markets SET status = 'resolved', resolved_outcome_id = ?, resolved_at = ? WHERE id = ?",
                   (outcome_id, now_str(), market_id))
        db.execute("COMMIT")
        return len(winners)
    except Exception:
        db.execute("ROLLBACK")
        raise


def cancel_market(db, market_id):
    """Void a market: everyone gets back what they net-spent on it."""
    db.execute("BEGIN IMMEDIATE")
    try:
        m = db.execute("SELECT * FROM markets WHERE id = ?", (market_id,)).fetchone()
        if m is None or m["status"] != "open":
            raise TradeError("Only unresolved markets can be cancelled.")
        rows = db.execute("SELECT user_id, SUM(amount) AS net FROM trades WHERE market_id = ? GROUP BY user_id",
                          (market_id,)).fetchall()
        for r in rows:
            if r["net"] > 0:
                db.execute("UPDATE users SET balance = ROUND(balance + ?, 2) WHERE id = ?", (r["net"], r["user_id"]))
        db.execute("UPDATE markets SET status = 'cancelled', resolved_at = ? WHERE id = ?", (now_str(), market_id))
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise


def delete_market(db, market_id):
    """Remove a market entirely. If it was never settled, everyone's net spend is refunded first.
    Payouts from an already-resolved market are kept."""
    db.execute("BEGIN IMMEDIATE")
    try:
        m = db.execute("SELECT * FROM markets WHERE id = ?", (market_id,)).fetchone()
        if m is None:
            raise TradeError("Market not found.")
        if m["status"] == "open":
            for r in db.execute("SELECT user_id, SUM(amount) AS net FROM trades WHERE market_id = ? GROUP BY user_id",
                                (market_id,)).fetchall():
                if r["net"] > 0:
                    db.execute("UPDATE users SET balance = ROUND(balance + ?, 2) WHERE id = ?",
                               (r["net"], r["user_id"]))
        db.execute("DELETE FROM positions WHERE outcome_id IN (SELECT id FROM outcomes WHERE market_id = ?)",
                   (market_id,))
        db.execute("UPDATE proposals SET market_id = NULL WHERE market_id = ?", (market_id,))
        for table in ("trades", "price_history", "comments", "market_blocks", "outcomes"):
            db.execute(f"DELETE FROM {table} WHERE market_id = ?", (market_id,))
        db.execute("DELETE FROM markets WHERE id = ?", (market_id,))
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise


def create_market(db, question, description, category, closes_at, labels, b, created_by=None):
    db.execute("BEGIN IMMEDIATE")
    try:
        cur = db.execute(
            "INSERT INTO markets (question, description, category, b, closes_at, created_by, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (question, description, category, b, closes_at, created_by, now_str()))
        mid = cur.lastrowid
        for i, label in enumerate(labels):
            db.execute("INSERT INTO outcomes (market_id, label, position) VALUES (?, ?, ?)", (mid, label, i))
        snapshot_prices(db, mid, b)
        db.execute("COMMIT")
        return mid
    except Exception:
        db.execute("ROLLBACK")
        raise


# ---------------------------------------------------------------- auth & csrf

def csrf_token():
    if "_csrf" not in session:
        session["_csrf"] = secrets.token_hex(16)
    return session["_csrf"]


@app.before_request
def load_user_and_check_csrf():
    g.user = None
    if session.get("uid"):
        g.user = get_db().execute("SELECT * FROM users WHERE id = ?", (session["uid"],)).fetchone()
        if g.user is None:
            session.pop("uid")
    if request.method == "POST":
        token = request.form.get("csrf_token", "")
        if not token or not secrets.compare_digest(token, session.get("_csrf", "")):
            abort(400, "Your form expired. Go back, reload the page and try again.")


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if g.user is None:
            flash("Log in to do that.", "error")
            return redirect(url_for("login", next=request.path))
        return view(*args, **kwargs)
    return wrapped


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if g.user is None or not g.user["is_admin"]:
            abort(403)
        return view(*args, **kwargs)
    return wrapped


@app.context_processor
def inject_globals():
    can_bonus = bool(g.user) and g.user["last_bonus"] != date.today().isoformat()
    pending = 0
    if g.user and g.user["is_admin"]:
        pending = get_db().execute("SELECT COUNT(*) FROM proposals WHERE status = 'pending'").fetchone()[0]
    return {"csrf_token": csrf_token, "user": g.user, "can_bonus": can_bonus, "pending_proposals": pending,
            "CURRENCY": CURRENCY, "DAILY_BONUS": DAILY_BONUS, "CATEGORIES": CATEGORIES}


@app.template_filter("money")
def money_filter(x):
    return f"{x:,.2f}"


@app.template_filter("pct")
def pct_filter(p):
    v = p * 100
    if 0 < v < 1:
        return "<1%"
    if 99 < v < 100:
        return ">99%"
    return f"{v:.0f}%"


@app.template_filter("when")
def when_filter(s):
    return parse_dt(s).strftime("%b %-d, %Y %-I:%M %p")


@app.template_filter("ago")
def ago_filter(s):
    secs = (datetime.now() - parse_dt(s)).total_seconds()
    if secs < 60:
        return "just now"
    for unit, size in (("d", 86400), ("h", 3600), ("m", 60)):
        if secs >= size:
            return f"{int(secs // size)}{unit} ago"


@app.template_filter("until")
def until_filter(s):
    secs = (parse_dt(s) - datetime.now()).total_seconds()
    if secs <= 0:
        return "closed"
    for unit, size in (("d", 86400), ("h", 3600), ("m", 60)):
        if secs >= size:
            return f"{int(secs // size)}{unit} left"
    return "<1m left"


# ---------------------------------------------------------------- routes: accounts

@app.route("/register", methods=["GET", "POST"])
def register():
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        if not USERNAME_RE.match(username):
            flash("Username must be 3–20 characters: letters, numbers, _ . -", "error")
        elif len(password) < 6:
            flash("Password must be at least 6 characters.", "error")
        elif password != request.form.get("confirm", ""):
            flash("Passwords don't match.", "error")
        elif rate_limited(("register", request.remote_addr), 40, 3600):
            flash("Too many new accounts from this network. Try again in a while.", "error")
        else:
            db = get_db()
            first_user = db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
            is_admin = int(first_user or username.lower() in ADMIN_USERNAMES)
            try:
                cur = db.execute(
                    "INSERT INTO users (username, password_hash, balance, is_admin, created_at) VALUES (?, ?, ?, ?, ?)",
                    (username, generate_password_hash(password), STARTING_BALANCE, is_admin, now_str()))
            except sqlite3.IntegrityError:
                flash("That username is taken.", "error")
            else:
                session.clear()
                session.permanent = True
                session["uid"] = cur.lastrowid
                flash(f"Welcome! You start with {STARTING_BALANCE:,.0f} {CURRENCY}."
                      + (" You're an admin, so you can create and resolve markets." if is_admin else ""), "success")
                return redirect(url_for("index"))
    return render_template("register.html")


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        name = request.form.get("username", "").strip()
        fail_key = ("login-fail", name.lower())
        recent_fails = [t for t in _hits.get(fail_key, []) if time.time() - t < 300]
        if len(recent_fails) >= 10:
            flash("Too many wrong passwords for this account. Wait 5 minutes and try again.", "error")
            return render_template("login.html")
        u = get_db().execute("SELECT * FROM users WHERE username = ?", (name,)).fetchone()
        if u and check_password_hash(u["password_hash"], request.form.get("password", "")):
            _hits.pop(fail_key, None)
            session.clear()
            session.permanent = True
            session["uid"] = u["id"]
            nxt = request.args.get("next", "")
            return redirect(nxt if nxt.startswith("/") and not nxt.startswith("//") else url_for("index"))
        rate_limited(fail_key, 10, 300)  # record the failure
        flash("Wrong username or password.", "error")
    return render_template("login.html")


@app.post("/logout")
def logout():
    session.clear()
    return redirect(url_for("index"))


@app.post("/bonus")
@login_required
def bonus():
    today = date.today().isoformat()
    cur = get_db().execute(
        "UPDATE users SET balance = ROUND(balance + ?, 2), last_bonus = ? "
        "WHERE id = ? AND (last_bonus IS NULL OR last_bonus != ?)",
        (DAILY_BONUS, today, g.user["id"], today))
    if cur.rowcount:
        flash(f"Claimed your daily {DAILY_BONUS:.0f} {CURRENCY}!", "success")
    else:
        flash("You already claimed today's bonus. Come back tomorrow.", "error")
    return redirect(request.referrer or url_for("index"))


# ---------------------------------------------------------------- routes: markets

@app.route("/")
def index():
    db = get_db()
    status = request.args.get("status", "open")
    cat = request.args.get("cat", "")
    markets = [bundle(db, m) for m in db.execute("SELECT * FROM markets ORDER BY closes_at").fetchall()]
    if status in ("open", "closed", "resolved", "cancelled"):
        markets = [b for b in markets if b["state"] == status]
    if cat:
        markets = [b for b in markets if b["m"]["category"] == cat]
    if status == "open":
        markets.sort(key=lambda b: -b["volume"])
    elif status in ("resolved", "cancelled"):
        markets.sort(key=lambda b: b["m"]["resolved_at"] or "", reverse=True)
    return render_template("index.html", markets=markets, status=status, cat=cat)


@app.route("/market/<int:mid>")
def market(mid):
    db = get_db()
    m = db.execute("SELECT * FROM markets WHERE id = ?", (mid,)).fetchone()
    if m is None:
        abort(404)
    b = bundle(db, m)
    history = [{"t": r["created_at"], "p": json.loads(r["prices"])}
               for r in db.execute("SELECT * FROM price_history WHERE market_id = ? ORDER BY id", (mid,))]
    trades = db.execute(
        "SELECT t.*, u.username, o.label FROM trades t JOIN users u ON u.id = t.user_id "
        "JOIN outcomes o ON o.id = t.outcome_id WHERE t.market_id = ? ORDER BY t.id DESC LIMIT 25", (mid,)).fetchall()
    comments = db.execute(
        "SELECT c.*, u.username FROM comments c JOIN users u ON u.id = c.user_id "
        "WHERE c.market_id = ? ORDER BY c.id DESC", (mid,)).fetchall()
    my_positions = []
    if g.user:
        by_id = {o["id"]: o for o in b["outcomes"]}
        q = [o["shares"] for o in b["outcomes"]]
        index = {o["id"]: i for i, o in enumerate(b["outcomes"])}
        for p in db.execute(
                "SELECT p.* FROM positions p JOIN outcomes o ON o.id = p.outcome_id "
                "WHERE p.user_id = ? AND o.market_id = ? ORDER BY o.position", (g.user["id"], mid)):
            o = by_id[p["outcome_id"]]
            # Resolved markets pay 1 per winning share; otherwise show what the shares would sell for now.
            value = (p["shares"] * o["price"] if b["m"]["status"] == "resolved"
                     else lmsr.sell_value(q, b["m"]["b"], index[p["outcome_id"]], p["shares"]))
            my_positions.append({"outcome": o, "shares": p["shares"], "cost": p["cost"], "value": value})
    block_reason = trade_block_reason(db, g.user["id"], mid) if g.user else None
    blocked, all_users = [], []
    if g.user and g.user["is_admin"]:
        blocked = db.execute("SELECT u.id, u.username FROM market_blocks mb JOIN users u ON u.id = mb.user_id "
                             "WHERE mb.market_id = ? ORDER BY u.username", (mid,)).fetchall()
        all_users = [r["username"] for r in db.execute("SELECT username FROM users ORDER BY username")]
    return render_template("market.html", b=b, history=history, trades=trades, comments=comments,
                           my_positions=my_positions, block_reason=block_reason,
                           blocked=blocked, all_users=all_users)


@app.post("/market/<int:mid>/trade")
@login_required
def trade(mid):
    try:
        outcome_id = int(request.form["outcome_id"])
        value = float(request.form.get("value", ""))
        if not math.isfinite(value):
            raise ValueError
    except (KeyError, ValueError):
        flash("Pick an outcome and enter a valid number.", "error")
        return redirect(url_for("market", mid=mid))
    try:
        flash(execute_trade(get_db(), g.user["id"], mid, outcome_id, request.form.get("action"), value), "success")
    except TradeError as e:
        flash(str(e), "error")
    return redirect(url_for("market", mid=mid))


@app.post("/market/<int:mid>/comment")
@login_required
def comment(mid):
    body = request.form.get("body", "").strip()
    if not body:
        flash("Comment can't be empty.", "error")
    elif len(body) > 500:
        flash("Keep comments under 500 characters.", "error")
    elif get_db().execute("SELECT 1 FROM markets WHERE id = ?", (mid,)).fetchone():
        get_db().execute("INSERT INTO comments (market_id, user_id, body, created_at) VALUES (?, ?, ?, ?)",
                         (mid, g.user["id"], body, now_str()))
    return redirect(url_for("market", mid=mid) + "#discussion")


@app.get("/api/quote")
def quote():
    """Preview a trade without making it."""
    db = get_db()
    try:
        mid = int(request.args["market"])
        oid = int(request.args["outcome"])
        value = float(request.args["value"])
        action = request.args["action"]
        if not math.isfinite(value) or value <= 0:
            raise ValueError
    except (KeyError, ValueError):
        return jsonify(ok=False)
    m = db.execute("SELECT * FROM markets WHERE id = ?", (mid,)).fetchone()
    if m is None or market_state(m) != "open":
        return jsonify(ok=False, error="This market is no longer accepting bets.")
    outs = get_outcomes(db, mid)
    ids = [o["id"] for o in outs]
    if oid not in ids:
        return jsonify(ok=False, error="Unknown outcome.")
    i = ids.index(oid)
    balance = held = None  # logged-out visitors still get a price preview
    try:
        if g.user:
            block = trade_block_reason(db, g.user["id"], mid)
            if block:
                raise TradeError(block)
            pos = db.execute("SELECT shares FROM positions WHERE user_id = ? AND outcome_id = ?",
                             (g.user["id"], oid)).fetchone()
            balance, held = g.user["balance"], pos["shares"] if pos else 0.0
        shares, coins = check_trade(m, outs, i, action, value, balance, held)
    except TradeError as e:
        return jsonify(ok=False, error=str(e))
    q = [o["shares"] for o in outs]
    q[i] += shares if action == "buy" else -shares
    return jsonify(ok=True, shares=round(shares, 4), coins=coins,
                   avg_price=coins / shares if shares else 0,
                   new_price=lmsr.prices(q, m["b"])[i])


# ---------------------------------------------------------------- routes: people

@app.route("/portfolio")
@login_required
def portfolio():
    db = get_db()
    uid = g.user["id"]
    rows = db.execute(
        "SELECT p.*, o.label, o.market_id, m.question FROM positions p "
        "JOIN outcomes o ON o.id = p.outcome_id JOIN markets m ON m.id = o.market_id "
        "WHERE p.user_id = ? ORDER BY m.closes_at", (uid,)).fetchall()
    bundles = {}
    active, settled = [], []
    for r in rows:
        if r["market_id"] not in bundles:
            m = db.execute("SELECT * FROM markets WHERE id = ?", (r["market_id"],)).fetchone()
            bundles[r["market_id"]] = bundle(db, m)
        b = bundles[r["market_id"]]
        outs = b["outcomes"]
        i = next(k for k, o in enumerate(outs) if o["id"] == r["outcome_id"])
        price = outs[i]["price"]
        if b["m"]["status"] == "open":  # open or awaiting result: value = what the shares would sell for now
            value = lmsr.sell_value([o["shares"] for o in outs], b["m"]["b"], i, r["shares"])
        else:
            value = r["shares"] * price
        item = {"r": r, "b": b, "price": price, "value": value}
        (active if b["state"] in ("open", "closed") else settled).append(item)
    trades = db.execute(
        "SELECT t.*, o.label, m.question FROM trades t JOIN outcomes o ON o.id = t.outcome_id "
        "JOIN markets m ON m.id = t.market_id WHERE t.user_id = ? ORDER BY t.id DESC LIMIT 30", (uid,)).fetchall()
    worth = net_worths(db)[uid]
    # Joint per-market value, so the KPI matches net worth even when someone holds several outcomes of a market.
    invested = sum(open_book_values(db).get(uid, {}).values())
    return render_template("portfolio.html", active=active, settled=settled, trades=trades, worth=worth,
                           invested=invested, rows_total=sum(i["value"] for i in active))


@app.route("/leaderboard")
def leaderboard():
    db = get_db()
    worth = net_worths(db)
    counts = {r["user_id"]: r["n"] for r in db.execute("SELECT user_id, COUNT(*) AS n FROM trades GROUP BY user_id")}
    users = db.execute("SELECT id, username, balance FROM users").fetchall()
    board = sorted(({"username": u["username"], "worth": worth[u["id"]], "balance": u["balance"],
                     "trades": counts.get(u["id"], 0), "is_me": g.user is not None and g.user["id"] == u["id"]}
                    for u in users), key=lambda x: -x["worth"])
    return render_template("leaderboard.html", board=board)


# ---------------------------------------------------------------- routes: admin

@app.route("/admin")
@admin_required
def admin():
    db = get_db()
    markets = [bundle(db, m) for m in db.execute("SELECT * FROM markets WHERE status = 'open' ORDER BY closes_at")]
    settled = [bundle(db, m) for m in db.execute(
        "SELECT * FROM markets WHERE status != 'open' ORDER BY resolved_at DESC")]
    users = db.execute("SELECT u.*, (tb.user_id IS NOT NULL) AS banned FROM users u "
                       "LEFT JOIN trade_bans tb ON tb.user_id = u.id ORDER BY u.username").fetchall()
    proposals =[dict(p, outcomes=json.loads(p["outcomes"])) for p in db.execute(
        "SELECT p.*, u.username FROM proposals p JOIN users u ON u.id = p.user_id "
        "WHERE p.status = 'pending' ORDER BY p.id")]
    default_close = (datetime.now() + timedelta(days=7)).strftime("%Y-%m-%dT%H:%M")
    return render_template("admin.html", markets=markets, settled=settled, users=users,
                           proposals=proposals, default_close=default_close)


def read_market_form(f):
    """Validate a create/propose/review form. Returns (fields, error_message)."""
    question = f.get("question", "").strip()
    labels = parse_outcome_lines(f.get("outcomes", ""))
    try:
        closes_at = datetime.fromisoformat(f.get("closes_at", ""))
    except ValueError:
        closes_at = None
    if not question or len(question) > 200:
        return None, "Question is required (max 200 characters)."
    if not 2 <= len(labels) <= 8:
        return None, "Give 2–8 distinct outcomes, one per line."
    if closes_at is None or closes_at <= datetime.now():
        return None, "Pick a closing time in the future."
    return {
        "question": question,
        "description": f.get("description", "").strip()[:2000],
        "category": f.get("category") if f.get("category") in CATEGORIES else "Other",
        "closes_at": closes_at.strftime("%Y-%m-%d %H:%M:%S"),
        "labels": labels,
        "b": market_b(f.get("liquidity"), len(labels)),
    }, None


@app.post("/admin/markets")
@admin_required
def admin_create():
    fields, error = read_market_form(request.form)
    if error:
        flash(error, "error")
        return redirect(url_for("admin"))
    mid = create_market(get_db(), fields["question"], fields["description"], fields["category"],
                        fields["closes_at"], fields["labels"], fields["b"], g.user["id"])
    flash("Market created.", "success")
    return redirect(url_for("market", mid=mid))


# ---------------------------------------------------------------- routes: proposals

MAX_PENDING_PROPOSALS = 5


@app.route("/propose", methods=["GET", "POST"])
@login_required
def propose():
    db = get_db()
    if request.method == "POST":
        pending = db.execute("SELECT COUNT(*) FROM proposals WHERE user_id = ? AND status = 'pending'",
                             (g.user["id"],)).fetchone()[0]
        fields, error = read_market_form(request.form)
        if pending >= MAX_PENDING_PROPOSALS:
            error = f"You already have {MAX_PENDING_PROPOSALS} proposals waiting. Wait for an admin to review them."
        if error:
            flash(error, "error")
            return render_template("propose.html", form=request.form, mine=my_proposals(db))
        db.execute(
            "INSERT INTO proposals (user_id, question, description, category, outcomes, closes_at, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (g.user["id"], fields["question"], fields["description"], fields["category"],
             json.dumps(fields["labels"]), fields["closes_at"], now_str()))
        flash("Thanks! Your market was sent to the admins for approval.", "success")
        return redirect(url_for("propose"))
    return render_template("propose.html", form={}, mine=my_proposals(db))


def my_proposals(db):
    return [dict(p, outcomes=json.loads(p["outcomes"])) for p in db.execute(
        "SELECT * FROM proposals WHERE user_id = ? ORDER BY id DESC LIMIT 20", (g.user["id"],))]


@app.post("/propose/<int:pid>/withdraw")
@login_required
def withdraw_proposal(pid):
    cur = get_db().execute("DELETE FROM proposals WHERE id = ? AND user_id = ? AND status = 'pending'",
                           (pid, g.user["id"]))
    flash("Proposal withdrawn." if cur.rowcount else "That proposal can't be withdrawn.",
          "success" if cur.rowcount else "error")
    return redirect(url_for("propose"))


@app.route("/admin/proposals/<int:pid>", methods=["GET", "POST"])
@admin_required
def admin_review(pid):
    """Review a proposal: the admin can tweak any field, then approve (creates the market) or reject."""
    db = get_db()
    p = db.execute("SELECT p.*, u.username FROM proposals p JOIN users u ON u.id = p.user_id WHERE p.id = ?",
                   (pid,)).fetchone()
    if p is None:
        abort(404)
    if request.method == "POST":
        if p["status"] != "pending":
            flash("This proposal was already reviewed.", "error")
            return redirect(url_for("admin"))
        note = request.form.get("review_note", "").strip()[:500]
        if request.form.get("decision") == "reject":
            db.execute("UPDATE proposals SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = ? "
                       "WHERE id = ? AND status = 'pending'", (note, g.user["id"], now_str(), pid))
            flash("Proposal rejected.", "success")
            return redirect(url_for("admin") + "#proposals")
        fields, error = read_market_form(request.form)
        if error:
            flash(error, "error")
            return render_template("review_proposal.html", p=p, form=request.form)
        claimed = db.execute("UPDATE proposals SET status = 'approved', review_note = ?, reviewed_by = ?, "
                             "reviewed_at = ? WHERE id = ? AND status = 'pending'",
                             (note, g.user["id"], now_str(), pid)).rowcount
        if not claimed:  # another admin got there first
            flash("This proposal was already reviewed.", "error")
            return redirect(url_for("admin"))
        mid = create_market(db, fields["question"], fields["description"], fields["category"],
                            fields["closes_at"], fields["labels"], fields["b"], p["user_id"])
        db.execute("UPDATE proposals SET market_id = ? WHERE id = ?", (mid, pid))
        flash(f"Approved! The market is now live. (Proposed by {p['username']}.)", "success")
        return redirect(url_for("market", mid=mid))

    form = {"question": p["question"], "description": p["description"], "category": p["category"],
            "outcomes": "\n".join(json.loads(p["outcomes"])),
            "closes_at": parse_dt(p["closes_at"]).strftime("%Y-%m-%dT%H:%M"), "liquidity": "medium"}
    return render_template("review_proposal.html", p=p, form=form)


@app.post("/admin/markets/<int:mid>/resolve")
@admin_required
def admin_resolve(mid):
    try:
        n = resolve_market(get_db(), mid, int(request.form.get("outcome_id", 0)))
        flash(f"Market resolved. Paid out {n} winning position(s).", "success")
    except (TradeError, ValueError) as e:
        flash(str(e) or "Pick a winning outcome.", "error")
    return redirect(request.referrer or url_for("admin"))


@app.post("/admin/markets/<int:mid>/cancel")
@admin_required
def admin_cancel(mid):
    try:
        cancel_market(get_db(), mid)
        flash("Market cancelled and bets refunded.", "success")
    except TradeError as e:
        flash(str(e), "error")
    return redirect(request.referrer or url_for("admin"))


def parse_outcome_lines(text):
    labels = []
    for line in text.splitlines():
        line = line.strip()[:60]
        if line and line.lower() not in [x.lower() for x in labels]:
            labels.append(line)
    return labels


@app.route("/admin/markets/<int:mid>/edit", methods=["GET", "POST"])
@admin_required
def admin_edit(mid):
    """Edit a market. Text, category and closing time can always change. Once anyone has bet,
    outcomes can only be renamed (not added/removed) and liquidity is locked, so prices and payouts stay fair."""
    db = get_db()
    m = db.execute("SELECT * FROM markets WHERE id = ?", (mid,)).fetchone()
    if m is None:
        abort(404)
    outs = get_outcomes(db, mid)
    has_trades = db.execute("SELECT 1 FROM trades WHERE market_id = ? LIMIT 1", (mid,)).fetchone() is not None

    if request.method == "POST":
        f = request.form
        question = f.get("question", "").strip()
        try:
            closes_at = datetime.fromisoformat(f.get("closes_at", "")).strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            closes_at = None
        if has_trades:
            renames = {o["id"]: f.get(f"label_{o['id']}", "").strip()[:60] for o in outs}
            labels = list(renames.values())
        else:
            labels = parse_outcome_lines(f.get("outcomes", ""))
        error = None
        if not question or len(question) > 200:
            error = "Question is required (max 200 characters)."
        elif closes_at is None:
            error = "Pick a valid closing time."
        elif not all(labels) or len({x.lower() for x in labels}) != len(labels):
            error = "Outcome names must be filled in and different from each other."
        elif not 2 <= len(labels) <= 8:
            error = "Give 2–8 distinct outcomes, one per line."
        if error:
            flash(error, "error")
            return redirect(url_for("admin_edit", mid=mid))

        db.execute("BEGIN IMMEDIATE")
        try:
            db.execute("UPDATE markets SET question = ?, description = ?, category = ?, closes_at = ? WHERE id = ?",
                       (question, f.get("description", "").strip()[:2000],
                        f.get("category") if f.get("category") in CATEGORIES else "Other", closes_at, mid))
            if has_trades:
                for oid, label in renames.items():
                    db.execute("UPDATE outcomes SET label = ? WHERE id = ?", (label, oid))
            else:
                preset = f.get("liquidity")
                b = market_b(preset, len(labels)) if preset in LIQUIDITY else m["b"]
                db.execute("UPDATE markets SET b = ? WHERE id = ?", (b, mid))
                if [o["label"] for o in outs] != labels:
                    db.execute("DELETE FROM outcomes WHERE market_id = ?", (mid,))
                    for i, label in enumerate(labels):
                        db.execute("INSERT INTO outcomes (market_id, label, position) VALUES (?, ?, ?)", (mid, label, i))
                if b != m["b"] or [o["label"] for o in outs] != labels:
                    db.execute("DELETE FROM price_history WHERE market_id = ?", (mid,))
                    snapshot_prices(db, mid, b)
            db.execute("COMMIT")
        except Exception:
            db.execute("ROLLBACK")
            raise
        flash("Market updated.", "success")
        return redirect(url_for("market", mid=mid))

    liquidity = preset_for(m["b"], len(outs))
    return render_template("edit_market.html", m=m, outcomes=outs, has_trades=has_trades, liquidity=liquidity,
                           closes_value=parse_dt(m["closes_at"]).strftime("%Y-%m-%dT%H:%M"))


@app.post("/admin/markets/<int:mid>/delete")
@admin_required
def admin_delete(mid):
    try:
        delete_market(get_db(), mid)
        flash("Market deleted.", "success")
    except TradeError as e:
        flash(str(e), "error")
    return redirect(url_for("admin"))


@app.post("/admin/markets/<int:mid>/block")
@admin_required
def admin_block(mid):
    db = get_db()
    if db.execute("SELECT 1 FROM markets WHERE id = ?", (mid,)).fetchone() is None:
        abort(404)
    name = request.form.get("username", "").strip()
    u = db.execute("SELECT id, username FROM users WHERE username = ?", (name,)).fetchone()
    if u is None:
        flash(f"No user named “{name}”.", "error")
    else:
        refund = block_user_in_market(db, u["id"], mid)
        flash(f"{u['username']} can no longer bet on this market."
              + (f" Refunded Ⓜ{refund:,.2f} and removed their bets." if refund else ""), "success")
    return redirect(url_for("market", mid=mid) + "#admin")


@app.post("/admin/markets/<int:mid>/unblock/<int:uid>")
@admin_required
def admin_unblock(mid, uid):
    get_db().execute("DELETE FROM market_blocks WHERE market_id = ? AND user_id = ?", (mid, uid))
    flash("They can bet on this market again.", "success")
    return redirect(url_for("market", mid=mid) + "#admin")


@app.post("/admin/users/<int:uid>/trading")
@admin_required
def admin_trading(uid):
    db = get_db()
    u = db.execute("SELECT id, username FROM users WHERE id = ?", (uid,)).fetchone()
    if u is None:
        abort(404)
    if db.execute("SELECT 1 FROM trade_bans WHERE user_id = ?", (uid,)).fetchone():
        db.execute("DELETE FROM trade_bans WHERE user_id = ?", (uid,))
        flash(f"{u['username']} can trade again.", "success")
    else:
        refund = ban_user_from_trading(db, uid)
        flash(f"Trading turned off for {u['username']}."
              + (f" Refunded Ⓜ{refund:,.2f} from their open bets." if refund else ""), "success")
    return redirect(url_for("admin") + "#users")


@app.post("/admin/users/<int:uid>/grant")
@admin_required
def admin_grant(uid):
    try:
        amount = cents(float(request.form.get("amount", "")))
        if not math.isfinite(amount) or amount == 0 or abs(amount) > 100000:
            raise ValueError
    except ValueError:
        flash("Enter an amount between -100,000 and 100,000.", "error")
        return redirect(url_for("admin"))
    get_db().execute("UPDATE users SET balance = MAX(0, ROUND(balance + ?, 2)) WHERE id = ?", (amount, uid))
    flash(f"Adjusted balance by {amount:,.2f}.", "success")
    return redirect(url_for("admin") + "#users")


@app.post("/admin/users/<int:uid>/toggle-admin")
@admin_required
def admin_toggle(uid):
    if uid == g.user["id"]:
        flash("You can't remove your own admin access.", "error")
    else:
        get_db().execute("UPDATE users SET is_admin = 1 - is_admin WHERE id = ?", (uid,))
    return redirect(url_for("admin") + "#users")


@app.errorhandler(400)
@app.errorhandler(403)
@app.errorhandler(404)
def error_page(e):
    return render_template("error.html", error=e), e.code


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)), debug=os.environ.get("FLASK_DEBUG") == "1")
