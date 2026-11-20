import json
import os
import re
import sys
import tempfile
from datetime import datetime, timedelta

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["MAMS_DB"] = os.path.join(tempfile.mkdtemp(), "test.db")

import lmsr  # noqa: E402
import app as appmod  # noqa: E402


@pytest.fixture(autouse=True)
def no_configured_owner(monkeypatch):
    """Tests assume the first account is the owner/admin, as on a fresh site with no OWNER_USERNAME set."""
    monkeypatch.setattr(appmod, "OWNER_USERNAME", "")


# ---------------------------------------------------------------- LMSR math

def test_prices_sum_to_one_and_start_equal():
    ps = lmsr.prices([0, 0, 0], 100)
    assert sum(ps) == pytest.approx(1)
    assert ps[0] == pytest.approx(1 / 3)


def test_shares_for_amount_inverts_cost():
    q, b = [10.0, -5.0, 3.0], 100
    s = lmsr.shares_for_amount(q, b, 1, 42.0)
    assert lmsr.cost_for_shares(q, b, 1, s) == pytest.approx(42.0)


def test_buy_then_sell_round_trips():
    q, b = [0.0, 0.0], 100
    s = lmsr.shares_for_amount(q, b, 0, 50)
    q[0] += s
    assert lmsr.sell_value(q, b, 0, s) == pytest.approx(50)


def test_buying_raises_price():
    q, b = [0.0, 0.0], 100
    s = lmsr.shares_for_amount(q, b, 0, 100)
    assert lmsr.prices([s, 0], b)[0] > 0.5


# ---------------------------------------------------------------- web flow

def past(hours=1):
    return (datetime.now() - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")


def csrf(resp):
    return re.search(r'name="csrf_token" value="([0-9a-f]+)"', resp.get_data(as_text=True)).group(1)


def signup(client, name):
    tok = csrf(client.get("/register"))
    return client.post("/register", data={"csrf_token": tok, "username": name, "password": "secret1",
                                          "confirm": "secret1"}, follow_redirects=True)


def test_full_flow():
    appmod.app.config["TESTING"] = True
    admin, bob = appmod.app.test_client(), appmod.app.test_client()

    signup(admin, "teacher")  # first user -> admin
    signup(bob, "bob")
    db = appmod.connect()
    assert db.execute("SELECT is_admin FROM users WHERE username='teacher'").fetchone()[0] == 1
    assert db.execute("SELECT is_admin FROM users WHERE username='bob'").fetchone()[0] == 0

    # bob cannot reach admin
    assert bob.get("/admin").status_code == 403

    # admin creates a market
    tok = csrf(admin.get("/admin"))
    closes = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%dT%H:%M")
    r = admin.post("/admin/markets", data={"csrf_token": tok, "question": "Snow day?", "outcomes": "Yes\nNo",
                                           "description": "Resolves YES if the school announces a snow day.", "rules_source": "Principal's email",
                                           "category": "Weather", "closes_at": closes, "liquidity": "medium"})
    assert r.status_code == 302
    mid = db.execute("SELECT id FROM markets WHERE question='Snow day?'").fetchone()[0]
    yes, no = [r[0] for r in db.execute("SELECT id FROM outcomes WHERE market_id=? ORDER BY position", (mid,))]

    # missing csrf is rejected
    assert bob.post(f"/market/{mid}/trade", data={"action": "buy", "outcome_id": yes, "value": 10}).status_code == 400

    # bob bets 100 on Yes
    tok = csrf(bob.get(f"/market/{mid}"))
    r = bob.post(f"/market/{mid}/trade", data={"csrf_token": tok, "action": "buy", "outcome_id": yes, "value": 100},
                 follow_redirects=True)
    assert "You paid" in r.get_data(as_text=True)
    bal = db.execute("SELECT balance FROM users WHERE username='bob'").fetchone()[0]
    assert bal == pytest.approx(890)  # Ⓜ100 bet + Ⓜ10 entry fee on his first bet in this market
    # the admin paid Ⓜ20 to create the market and earned Bob's Ⓜ10 entry fee
    assert db.execute("SELECT balance FROM users WHERE username='teacher'").fetchone()[0] == pytest.approx(990)
    shares = db.execute("SELECT shares FROM positions WHERE outcome_id=?", (yes,)).fetchone()[0]
    assert shares > 100  # bought below 1 coin/share

    # can't overspend
    r = bob.post(f"/market/{mid}/trade", data={"csrf_token": tok, "action": "buy", "outcome_id": no, "value": 5000},
                 follow_redirects=True)
    assert "enough" in r.get_data(as_text=True)

    # quote endpoint works
    q = bob.get(f"/api/quote?market={mid}&outcome={no}&action=buy&value=10").get_json()
    assert q["ok"] and q["shares"] > 10

    # pages render
    for path in ["/", "/?status=all", f"/market/{mid}", "/portfolio", "/leaderboard"]:
        assert bob.get(path).status_code == 200, path

    # the result can't be proposed while betting is still open
    tok = csrf(admin.get(f"/market/{mid}"))
    r = admin.post(f"/admin/markets/{mid}/propose-result", data={"csrf_token": tok, "outcome_id": yes},
                   follow_redirects=True)
    assert "closed yet" in r.get_data(as_text=True)

    # after the close, an admin proposes Yes; nobody is paid until the window ends
    db.execute("UPDATE markets SET closes_at = ? WHERE id = ?", (past(), mid))
    admin.post(f"/admin/markets/{mid}/propose-result", data={"csrf_token": tok, "outcome_id": yes})
    assert db.execute("SELECT balance FROM users WHERE username='bob'").fetchone()[0] == pytest.approx(890)
    assert "Proposed result" in bob.get(f"/market/{mid}").get_data(as_text=True)

    # window ends with no dispute -> the next request finalizes and pays 1 per share
    db.execute("UPDATE markets SET finalizes_at = ? WHERE id = ?", (past(), mid))
    bob.get("/")
    bal = db.execute("SELECT balance FROM users WHERE username='bob'").fetchone()[0]
    assert bal == pytest.approx(890 + shares, abs=0.01)

    # no more trading after resolution
    tok = csrf(bob.get(f"/market/{mid}"))
    r = bob.post(f"/market/{mid}/trade", data={"csrf_token": tok, "action": "buy", "outcome_id": yes, "value": 10},
                 follow_redirects=True)
    assert "no longer accepting" in r.get_data(as_text=True)


def test_cancel_refunds():
    db = appmod.connect()
    uid = db.execute("INSERT INTO users (username, password_hash, balance, created_at) VALUES ('cara', 'x', 1000, ?)",
                     (appmod.now_str(),)).lastrowid
    closes = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d %H:%M:%S")
    mid = appmod.create_market(db, "Cancel me?", "", "Other", closes, ["A", "B", "C"], 50)
    oid = db.execute("SELECT id FROM outcomes WHERE market_id=? AND label='B'", (mid,)).fetchone()[0]
    appmod.execute_trade(db, uid, mid, oid, "buy", 200)
    held = db.execute("SELECT shares FROM positions WHERE user_id=?", (uid,)).fetchone()[0]
    appmod.execute_trade(db, uid, mid, oid, "sell", held / 2)
    appmod.cancel_market(db, mid)
    assert db.execute("SELECT balance FROM users WHERE id=?", (uid,)).fetchone()[0] == pytest.approx(1000, abs=0.02)


def test_delete_refunds_and_removes():
    db = appmod.connect()
    uid = db.execute("INSERT INTO users (username, password_hash, balance, created_at) VALUES ('dan', 'x', 1000, ?)",
                     (appmod.now_str(),)).lastrowid
    closes = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d %H:%M:%S")
    mid = appmod.create_market(db, "Delete me?", "", "Other", closes, ["Yes", "No"], 100)
    oid = db.execute("SELECT id FROM outcomes WHERE market_id=? AND label='Yes'", (mid,)).fetchone()[0]
    appmod.execute_trade(db, uid, mid, oid, "buy", 300)
    appmod.delete_market(db, mid)
    assert db.execute("SELECT balance FROM users WHERE id=?", (uid,)).fetchone()[0] == pytest.approx(1000)
    assert db.execute("SELECT COUNT(*) FROM markets WHERE id=?", (mid,)).fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM positions WHERE user_id=?", (uid,)).fetchone()[0] == 0
    client = appmod.app.test_client()
    signup(client, "admin_check")
    for path in ["/admin", "/"]:
        assert client.get(path).status_code in (200, 403)


def test_admin_edit():
    path = os.path.join(tempfile.mkdtemp(), "edit.db")
    old = appmod.DB_PATH
    appmod.DB_PATH = path
    try:
        appmod.init_db()
        db = appmod.connect()
        closes = (datetime.now() + timedelta(days=2)).strftime("%Y-%m-%d %H:%M:%S")
        mid = appmod.create_market(db, "Old?", "", "Other", closes, ["Yes", "No"], 100)
        admin, bob = appmod.app.test_client(), appmod.app.test_client()
        signup(admin, "editor")
        signup(bob, "bettor")
        assert bob.get(f"/admin/markets/{mid}/edit").status_code == 403
        new_close = (datetime.now() + timedelta(days=9)).strftime("%Y-%m-%dT%H:%M")

        # no bets yet: outcomes and liquidity can be replaced
        tok = csrf(admin.get(f"/admin/markets/{mid}/edit"))
        r = admin.post(f"/admin/markets/{mid}/edit", data={
            "csrf_token": tok, "question": "New?", "description": "d", "category": "Sports",
            "closes_at": new_close, "outcomes": "A\nB\nC", "liquidity": "high"}, follow_redirects=True)
        assert "Market updated." in r.get_data(as_text=True)
        m = db.execute("SELECT * FROM markets WHERE id=?", (mid,)).fetchone()
        assert (m["question"], m["category"]) == ("New?", "Sports")
        assert m["b"] == pytest.approx(1000 * 1.5849625007)  # 3 outcomes
        labels = [o["label"] for o in appmod.get_outcomes(db, mid)]
        assert labels == ["A", "B", "C"]

        # after a bet: renames only, liquidity locked
        uid = db.execute("SELECT id FROM users WHERE username='bettor'").fetchone()[0]
        outs = appmod.get_outcomes(db, mid)
        appmod.execute_trade(db, uid, mid, outs[0]["id"], "buy", 50)
        tok = csrf(admin.get(f"/admin/markets/{mid}/edit"))
        data = {"csrf_token": tok, "question": "New?", "description": "", "category": "Sports",
                "closes_at": new_close, "liquidity": "low", "outcomes": "X\nY"}
        data.update({f"label_{o['id']}": l for o, l in zip(outs, ["Alpha", "B", "C"])})
        admin.post(f"/admin/markets/{mid}/edit", data=data)
        assert [o["label"] for o in appmod.get_outcomes(db, mid)] == ["Alpha", "B", "C"]
        assert db.execute("SELECT b FROM markets WHERE id=?", (mid,)).fetchone()[0] == pytest.approx(1000 * 1.5849625007)
        assert db.execute("SELECT COUNT(*) FROM positions WHERE user_id=?", (uid,)).fetchone()[0] == 1
        assert admin.get(f"/market/{mid}").status_code == 200
        assert admin.get("/admin").status_code == 200
    finally:
        appmod.DB_PATH = old


def test_login_lockout_after_repeated_failures():
    client = appmod.app.test_client()
    signup(client, "lockme")
    client = appmod.app.test_client()
    for _ in range(10):
        r = client.post("/login", data={"csrf_token": csrf(client.get("/login")), "username": "lockme",
                                        "password": "wrong"})
        assert "Wrong username or password." in r.get_data(as_text=True)
    r = client.post("/login", data={"csrf_token": csrf(client.get("/login")), "username": "lockme",
                                    "password": "secret1"})
    assert "Too many wrong passwords" in r.get_data(as_text=True)
    appmod._hits.clear()
    r = client.post("/login", data={"csrf_token": csrf(client.get("/login")), "username": "lockme",
                                    "password": "secret1"})
    assert r.status_code == 302


def test_uses_school_timezone():
    import time as _time
    assert _time.tzname[0] in ("EST", "EDT")


def test_proposals_flow():
    path = os.path.join(tempfile.mkdtemp(), "proposals.db")
    old = appmod.DB_PATH
    appmod.DB_PATH = path
    appmod._hits.clear()
    try:
        appmod.init_db()
        db = appmod.connect()
        admin, sam = appmod.app.test_client(), appmod.app.test_client()
        signup(admin, "headadmin")
        signup(sam, "sam")
        closes = (datetime.now() + timedelta(days=5)).strftime("%Y-%m-%dT%H:%M")

        def propose(question):
            tok = csrf(sam.get("/propose"))
            return sam.post("/propose", data={"csrf_token": tok, "question": question, "description": "Resolves YES if a live band plays.",
                                              "outcomes": "Yes\nNo", "category": "Events", "closes_at": closes},
                            follow_redirects=True)

        assert "sent to the admins" in propose("Will the pep rally have a band?").get_data(as_text=True)
        assert sam.get("/admin").status_code == 403
        pid = db.execute("SELECT id FROM proposals WHERE question LIKE 'Will the pep%'").fetchone()[0]
        assert sam.get(f"/admin/proposals/{pid}").status_code == 403

        # admin sees it, with a badge, and approves with edited wording
        page = admin.get("/admin").get_data(as_text=True)
        assert "Will the pep rally have a band?" in page and 'class="badge"' in page
        tok = csrf(admin.get(f"/admin/proposals/{pid}"))
        r = admin.post(f"/admin/proposals/{pid}", data={
            "csrf_token": tok, "decision": "approve", "question": "Will the pep rally have a live band?",
            "description": "Resolves YES if a live band plays.", "outcomes": "Yes\nNo", "category": "Events",
            "closes_at": closes, "liquidity": "high", "review_note": "Clarified wording"}, follow_redirects=True)
        assert "Approved!" in r.get_data(as_text=True)
        p = db.execute("SELECT * FROM proposals WHERE id=?", (pid,)).fetchone()
        assert p["status"] == "approved" and p["market_id"]
        m = db.execute("SELECT * FROM markets WHERE id=?", (p["market_id"],)).fetchone()
        assert m["question"] == "Will the pep rally have a live band?" and m["b"] == 1000
        assert "Clarified wording" in sam.get("/propose").get_data(as_text=True)

        # approving twice does nothing
        tok = csrf(admin.get("/admin"))
        admin.post(f"/admin/proposals/{pid}", data={"csrf_token": tok, "decision": "approve", "question": "X",
                                                    "outcomes": "A\nB", "closes_at": closes})
        assert db.execute("SELECT COUNT(*) FROM markets").fetchone()[0] == 1

        # rejection with a note
        propose("Bad question?")
        pid2 = db.execute("SELECT id FROM proposals WHERE question='Bad question?'").fetchone()[0]
        tok = csrf(admin.get(f"/admin/proposals/{pid2}"))
        admin.post(f"/admin/proposals/{pid2}", data={"csrf_token": tok, "decision": "reject",
                                                     "review_note": "Too vague"})
        assert db.execute("SELECT status FROM proposals WHERE id=?", (pid2,)).fetchone()[0] == "rejected"
        assert "Too vague" in sam.get("/propose").get_data(as_text=True)

        # withdraw, and the 5-pending cap
        for i in range(5):
            propose(f"Q{i}?")
        assert "already have 5" in propose("One too many?").get_data(as_text=True)
        q0 = db.execute("SELECT id FROM proposals WHERE question='Q0?'").fetchone()[0]
        sam.post(f"/propose/{q0}/withdraw", data={"csrf_token": csrf(sam.get("/propose"))})
        assert db.execute("SELECT COUNT(*) FROM proposals WHERE id=?", (q0,)).fetchone()[0] == 0

        # deleting the approved market still works
        appmod.delete_market(db, p["market_id"])
        for path_ in ["/", "/propose", "/admin", f"/admin/proposals/{pid}"]:
            assert admin.get(path_).status_code == 200, path_
    finally:
        appmod.DB_PATH = old


def test_blocking_and_bans_refund_bets():
    path = os.path.join(tempfile.mkdtemp(), "blocks.db")
    old = appmod.DB_PATH
    appmod.DB_PATH = path
    appmod._hits.clear()
    try:
        appmod.init_db()
        db = appmod.connect()
        admin, eve, fay = (appmod.app.test_client() for _ in range(3))
        signup(admin, "boss")
        signup(eve, "eve")
        signup(fay, "fay")
        uid = lambda n: db.execute("SELECT id FROM users WHERE username=?", (n,)).fetchone()[0]
        bal = lambda n: db.execute("SELECT balance FROM users WHERE username=?", (n,)).fetchone()[0]
        closes = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")
        m1 = appmod.create_market(db, "M1?", "", "Other", closes, ["Yes", "No"], 100)
        m2 = appmod.create_market(db, "M2?", "", "Other", closes, ["Yes", "No"], 100)
        yes1 = appmod.get_outcomes(db, m1)[0]["id"]
        yes2 = appmod.get_outcomes(db, m2)[0]["id"]

        appmod.execute_trade(db, uid("eve"), m1, yes1, "buy", 200)
        appmod.execute_trade(db, uid("fay"), m1, yes1, "buy", 100)
        fay_shares = db.execute("SELECT shares FROM positions WHERE user_id=?", (uid("fay"),)).fetchone()[0]

        # per-market block: eve refunded, her shares leave the market, fay untouched
        tok = csrf(admin.get(f"/market/{m1}"))
        r = admin.post(f"/admin/markets/{m1}/block", data={"csrf_token": tok, "username": "eve"},
                       follow_redirects=True)
        assert "Refunded Ⓜ200.00" in r.get_data(as_text=True)
        assert bal("eve") == pytest.approx(1000)
        assert db.execute("SELECT COUNT(*) FROM trades WHERE user_id=?", (uid("eve"),)).fetchone()[0] == 0
        q = db.execute("SELECT shares FROM outcomes WHERE id=?", (yes1,)).fetchone()[0]
        assert q == pytest.approx(fay_shares)
        assert bal("fay") == pytest.approx(900)
        assert "blocked you from betting" in eve.get(f"/market/{m1}").get_data(as_text=True)
        with pytest.raises(appmod.TradeError):
            appmod.execute_trade(db, uid("eve"), m1, yes1, "buy", 10)
        appmod.execute_trade(db, uid("eve"), m2, yes2, "buy", 10)  # other markets still fine

        # unblock
        tok = csrf(admin.get(f"/market/{m1}"))
        admin.post(f"/admin/markets/{m1}/unblock/{uid('eve')}", data={"csrf_token": tok})
        appmod.execute_trade(db, uid("eve"), m1, yes1, "buy", 10)

        # site-wide ban refunds every open market
        tok = csrf(admin.get("/admin"))
        r = admin.post(f"/admin/users/{uid('eve')}/trading", data={"csrf_token": tok}, follow_redirects=True)
        assert "Trading turned off for eve" in r.get_data(as_text=True)
        assert bal("eve") == pytest.approx(1000)
        with pytest.raises(appmod.TradeError):
            appmod.execute_trade(db, uid("eve"), m2, yes2, "buy", 10)
        assert "Banned" in admin.get("/admin").get_data(as_text=True)

        # lift the ban
        tok = csrf(admin.get("/admin"))
        admin.post(f"/admin/users/{uid('eve')}/trading", data={"csrf_token": tok})
        appmod.execute_trade(db, uid("eve"), m2, yes2, "buy", 10)

        # deleting a market with blocks still works
        block_tok = csrf(admin.get(f"/market/{m2}"))
        admin.post(f"/admin/markets/{m2}/block", data={"csrf_token": block_tok, "username": "fay"})
        appmod.delete_market(db, m2)
        assert admin.get(f"/market/{m1}").status_code == 200
    finally:
        appmod.DB_PATH = old


# ---------------------------------------------------------------- pricing audit regressions

def _fresh_db():
    path = os.path.join(tempfile.mkdtemp(), "pricing.db")
    appmod.DB_PATH = path
    appmod._hits.clear()
    appmod.init_db()
    return appmod.connect()


def _user(db, name, balance=1000):
    return db.execute("INSERT INTO users (username, password_hash, balance, created_at) VALUES (?, 'x', ?, ?)",
                      (name, balance, appmod.now_str())).lastrowid


def _market(db, n=2, b=300):
    closes = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")
    mid = appmod.create_market(db, f"Q{n}-{b}?", "", "Other", closes, [f"o{i}" for i in range(n)], b)
    return mid, [o["id"] for o in appmod.get_outcomes(db, mid)]


@pytest.mark.parametrize("b", [50, 150, 600])
@pytest.mark.parametrize("n", [2, 8])
@pytest.mark.parametrize("amount", [1e-12, 1.0, 1e5])
def test_shares_for_amount_inverts_cost_at_extremes(b, n, amount):
    q = [0.0] * n
    q[0] = 40 * b  # outcome 1 is priced near e^-40
    s = lmsr.shares_for_amount(q, b, 1, amount)
    assert s >= 0
    assert lmsr.cost_for_shares(q, b, 1, s) == pytest.approx(amount, rel=1e-6, abs=1e-9)


def test_buying_does_not_inflate_net_worth():
    old = appmod.DB_PATH
    try:
        db = _fresh_db()
        uid = _user(db, "buyer")
        mid, (yes, no) = _market(db, 2, 100)
        appmod.execute_trade(db, uid, mid, yes, "buy", 100)
        assert appmod.net_worths(db)[uid] == pytest.approx(1000, abs=0.02)
    finally:
        appmod.DB_PATH = old


def test_holding_both_sides_is_worth_its_cost():
    old = appmod.DB_PATH
    try:
        db = _fresh_db()
        uid = _user(db, "hedger")
        mid, (yes, no) = _market(db, 2, 50)
        appmod.execute_trade(db, uid, mid, yes, "buy", 400)
        appmod.execute_trade(db, uid, mid, no, "buy", 400)
        assert appmod.net_worths(db)[uid] == pytest.approx(1000, abs=0.05)
    finally:
        appmod.DB_PATH = old


def test_market_b_scales_with_outcomes():
    assert appmod.market_b(2) == 1000
    assert appmod.market_b(8) == 3000
    assert appmod.market_b(1) == 1000  # never below the yes/no level


def test_form_market_stores_scaled_b():
    old = appmod.DB_PATH
    try:
        _fresh_db()
        admin = appmod.app.test_client()
        signup(admin, "formboss")
        closes = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%dT%H:%M")
        admin.post("/admin/markets", data={"csrf_token": csrf(admin.get("/admin")), "question": "Eight?",
                                           "outcomes": "\n".join("abcdefgh"), "category": "Other",
                                           "description": "The winner is the first letter drawn.",
                                           "closes_at": closes, "liquidity": "medium"})
        db = appmod.connect()
        mid, b = db.execute("SELECT id, b FROM markets WHERE question='Eight?'").fetchone()
        assert b == pytest.approx(3000)
        page = admin.get(f"/admin/markets/{mid}/edit").get_data(as_text=True)
        assert 'name="liquidity"' not in page  # no liquidity setting any more
    finally:
        appmod.DB_PATH = old


def test_quote_matches_trade_and_reports_errors():
    old = appmod.DB_PATH
    try:
        db = _fresh_db()
        client = appmod.app.test_client()
        signup(client, "quoter")
        uid = db.execute("SELECT id FROM users WHERE username='quoter'").fetchone()[0]
        mid, (yes, no) = _market(db, 2, 100)
        url = lambda o, a, v: f"/api/quote?market={mid}&outcome={o}&action={a}&value={v}"

        assert "Minimum bet" in client.get(url(yes, "buy", 0.5)).get_json()["error"]
        assert "enough" in client.get(url(yes, "buy", 5000)).get_json()["error"]
        assert "only own" in client.get(url(yes, "sell", 5)).get_json()["error"]

        q = client.get(url(yes, "buy", 100)).get_json()
        assert q["ok"]
        bal0 = db.execute("SELECT balance FROM users WHERE id=?", (uid,)).fetchone()[0]
        appmod.execute_trade(db, uid, mid, yes, "buy", 100)
        held = db.execute("SELECT shares FROM positions WHERE user_id=?", (uid,)).fetchone()[0]
        assert held == pytest.approx(q["shares"], abs=1e-3)
        assert db.execute("SELECT balance FROM users WHERE id=?", (uid,)).fetchone()[0] == pytest.approx(bal0 - q["coins"])

        sq = client.get(url(yes, "sell", held)).get_json()
        assert sq["ok"]
        before = db.execute("SELECT balance FROM users WHERE id=?", (uid,)).fetchone()[0]
        appmod.execute_trade(db, uid, mid, yes, "sell", held)
        after = db.execute("SELECT balance FROM users WHERE id=?", (uid,)).fetchone()[0]
        assert after - before == pytest.approx(sq["coins"], abs=0.01)

        # blocked users see the reason; logged-out visitors still get a price preview
        db.execute("INSERT INTO market_blocks (market_id, user_id, created_at) VALUES (?, ?, ?)", (mid, uid, appmod.now_str()))
        assert "blocked" in client.get(url(yes, "buy", 10)).get_json()["error"]
        assert appmod.app.test_client().get(url(yes, "buy", 10)).get_json()["ok"]
    finally:
        appmod.DB_PATH = old


# ---------------------------------------------------------------- Yes/No, rules, optimistic resolution

RULES = "Resolves YES if the official results list MAMS first."


def test_migration_adds_missing_columns_and_is_repeatable():
    import sqlite3
    path = os.path.join(tempfile.mkdtemp(), "old.db")
    old = appmod.DB_PATH
    try:
        raw = sqlite3.connect(path)  # a database from before rules/resolution columns existed
        raw.execute("CREATE TABLE markets (id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT NOT NULL, "
                    "description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Other', b REAL NOT NULL, "
                    "status TEXT NOT NULL DEFAULT 'open', closes_at TEXT NOT NULL, resolved_outcome_id INTEGER, "
                    "resolved_at TEXT, created_by INTEGER, created_at TEXT NOT NULL)")
        raw.execute("CREATE TABLE proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, "
                    "question TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Other', "
                    "outcomes TEXT NOT NULL, closes_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', "
                    "review_note TEXT NOT NULL DEFAULT '', reviewed_by INTEGER, reviewed_at TEXT, market_id INTEGER, "
                    "created_at TEXT NOT NULL)")
        raw.execute("INSERT INTO markets (question, b, closes_at, created_at) VALUES ('Old?', 100, '2030-01-01 00:00:00', 'x')")
        raw.commit()
        raw.close()
        appmod.DB_PATH = path
        appmod.init_db()
        appmod.init_db()  # second run changes nothing
        db = appmod.connect()
        cols = {r["name"] for r in db.execute("PRAGMA table_info(markets)")}
        assert {"rules_source", "rules_otherwise", "proposed_outcome_id", "finalizes_at", "resolved_by"} <= cols
        assert "rules_source" in {r["name"] for r in db.execute("PRAGMA table_info(proposals)")}
        assert db.execute("SELECT question, rules_source FROM markets").fetchone()[:] == ("Old?", "")
        db.execute("SELECT * FROM disputes")
        db.execute("SELECT * FROM clarifications")
    finally:
        appmod.DB_PATH = old


def test_market_form_kinds_and_required_rules():
    base = {"question": "Q?", "description": RULES, "closes_at": (datetime.now() + timedelta(days=2)).isoformat(),
            "category": "Events"}
    fields, err = appmod.read_market_form({**base, "kind": "yesno", "outcomes": "ignored\nme"})
    assert err is None and fields["labels"] == ["Yes", "No"] and fields["b"] == 1000
    fields, err = appmod.read_market_form({**base, "kind": "multi", "outcomes": "A\nB\nC"})
    assert err is None and fields["labels"] == ["A", "B", "C"]
    _, err = appmod.read_market_form({**base, "kind": "multi", "outcomes": "Only"})
    assert "2–8" in err
    _, err = appmod.read_market_form({**base, "kind": "yesno", "description": "too short"})
    assert "decided" in err
    fields, _ = appmod.read_market_form({**base, "kind": "yesno", "rules_source": "Results page",
                                         "rules_otherwise": "Postponed means NO."})
    assert (fields["rules_source"], fields["rules_otherwise"]) == ("Results page", "Postponed means NO.")
    assert appmod.is_binary(["Yes", "No"]) and not appmod.is_binary(["Yes", "No", "Maybe"])


def _closed_market_with_bet():
    """A Yes/No market past its close date where `bob` holds Yes. Returns (db, mid, yes, no, admin, bob, eve)."""
    db = _fresh_db()
    admin, bob, eve = (appmod.app.test_client() for _ in range(3))
    signup(admin, "chief")
    signup(bob, "bob")
    signup(eve, "eve")  # never trades
    closes = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")
    mid = appmod.create_market(db, "Win?", RULES, "Events", closes, ["Yes", "No"], 100, None)
    yes, no = [o["id"] for o in appmod.get_outcomes(db, mid)]
    bob_id = db.execute("SELECT id FROM users WHERE username='bob'").fetchone()[0]
    appmod.execute_trade(db, bob_id, mid, yes, "buy", 100)
    db.execute("UPDATE markets SET closes_at = ? WHERE id = ?", (past(), mid))
    return db, mid, yes, no, admin, bob, eve


def _post(client, url, **data):
    return client.post(url, data={"csrf_token": csrf(client.get("/")), **data}, follow_redirects=True)


def test_undisputed_result_finalizes_once_and_pays_winners():
    old = appmod.DB_PATH
    try:
        db, mid, yes, no, admin, bob, eve = _closed_market_with_bet()
        shares = db.execute("SELECT shares FROM positions WHERE outcome_id=?", (yes,)).fetchone()[0]
        _post(admin, f"/admin/markets/{mid}/propose-result", outcome_id=yes)
        m = db.execute("SELECT * FROM markets WHERE id=?", (mid,)).fetchone()
        assert m["status"] == "open" and m["proposed_outcome_id"] == yes and m["finalizes_at"] > appmod.now_str()
        bob.get("/")  # window still running: nothing happens
        assert db.execute("SELECT status FROM markets WHERE id=?", (mid,)).fetchone()[0] == "open"
        assert appmod.market_state(m) == "proposed"

        db.execute("UPDATE markets SET finalizes_at = ? WHERE id = ?", (past(), mid))
        bob.get("/")
        bob.get("/")  # a second request must not pay again
        row = db.execute("SELECT status, resolved_outcome_id, resolved_by FROM markets WHERE id=?", (mid,)).fetchone()
        assert (row["status"], row["resolved_outcome_id"]) == ("resolved", yes) and row["resolved_by"]
        assert db.execute("SELECT balance FROM users WHERE username='bob'").fetchone()[0] == pytest.approx(900 + shares, abs=0.01)
    finally:
        appmod.DB_PATH = old


def test_dispute_pauses_finalizing_and_admin_can_confirm_or_change():
    old = appmod.DB_PATH
    try:
        db, mid, yes, no, admin, bob, eve = _closed_market_with_bet()
        bal = lambda: db.execute("SELECT balance FROM users WHERE username='bob'").fetchone()[0]
        _post(admin, f"/admin/markets/{mid}/propose-result", outcome_id=no)

        # people who never traded can't dispute; traders can, once
        assert "Only people who traded" in _post(eve, f"/market/{mid}/dispute", reason="I think it is wrong").get_data(as_text=True)
        assert "Explain the problem" in _post(bob, f"/market/{mid}/dispute", reason="no").get_data(as_text=True)
        page = _post(bob, f"/market/{mid}/dispute", reason="Official page says Yes won").get_data(as_text=True)
        assert "Dispute sent" in page and "Result disputed" in page
        assert "already disputed" in _post(bob, f"/market/{mid}/dispute", reason="Official page says Yes won").get_data(as_text=True)
        assert db.execute("SELECT COUNT(*) FROM disputes").fetchone()[0] == 1

        # window ends but the dispute keeps it from finalizing
        db.execute("UPDATE markets SET finalizes_at = ? WHERE id = ?", (past(), mid))
        bob.get("/")
        assert db.execute("SELECT status FROM markets WHERE id=?", (mid,)).fetchone()[0] == "open"

        # an ordinary user can't use the admin actions
        assert bob.post(f"/admin/markets/{mid}/result-action", data={"csrf_token": csrf(bob.get("/")), "decision": "confirm"}).status_code == 403

        # admin changes the outcome: window restarts, dispute is handled, still unpaid
        _post(admin, f"/admin/markets/{mid}/propose-result", outcome_id=yes)
        m = db.execute("SELECT * FROM markets WHERE id=?", (mid,)).fetchone()
        assert m["proposed_outcome_id"] == yes and m["finalizes_at"] > appmod.now_str()
        assert db.execute("SELECT COUNT(*) FROM disputes WHERE handled_at IS NULL").fetchone()[0] == 0
        assert bal() == pytest.approx(900)

        # a new dispute can be confirmed straight away
        _post(bob, f"/market/{mid}/dispute", reason="Still looks wrong to me")
        _post(admin, f"/admin/markets/{mid}/result-action", decision="confirm")
        assert db.execute("SELECT status FROM markets WHERE id=?", (mid,)).fetchone()[0] == "resolved"
        assert bal() > 900
    finally:
        appmod.DB_PATH = old


def test_confirm_needs_a_dispute_and_retract_removes_proposal():
    old = appmod.DB_PATH
    try:
        db, mid, yes, no, admin, bob, eve = _closed_market_with_bet()
        _post(admin, f"/admin/markets/{mid}/propose-result", outcome_id=yes)
        assert "Only a disputed result" in _post(admin, f"/admin/markets/{mid}/result-action", decision="confirm").get_data(as_text=True)
        assert db.execute("SELECT status FROM markets WHERE id=?", (mid,)).fetchone()[0] == "open"

        _post(admin, f"/admin/markets/{mid}/result-action", decision="retract")
        m = db.execute("SELECT * FROM markets WHERE id=?", (mid,)).fetchone()
        assert m["proposed_outcome_id"] is None and m["finalizes_at"] is None
        assert appmod.market_state(m) == "closed"
        bob.get("/")
        assert db.execute("SELECT status FROM markets WHERE id=?", (mid,)).fetchone()[0] == "open"
        # pages for every state render
        for state_page in ("/", "/?status=closed", f"/market/{mid}", "/portfolio", "/admin"):
            assert (admin if state_page == "/admin" else bob).get(state_page).status_code == 200
    finally:
        appmod.DB_PATH = old


def test_rules_lock_after_first_bet_and_clarifications():
    old = appmod.DB_PATH
    try:
        db = _fresh_db()
        admin = appmod.app.test_client()
        signup(admin, "ruler")
        closes = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")
        mid = appmod.create_market(db, "Rules?", RULES, "Other", closes, ["Yes", "No"], 100, None, "Results page", "Tie means NO.")
        new_close = (datetime.now() + timedelta(days=4)).strftime("%Y-%m-%dT%H:%M")
        edit = lambda **kw: _post(admin, f"/admin/markets/{mid}/edit", question="Rules?", category="Other",
                                  closes_at=new_close, outcomes="Yes\nNo", liquidity="medium", **kw)

        edit(description="Resolves YES if it rains on Tuesday.", rules_source="Weather app", rules_otherwise="")
        m = db.execute("SELECT * FROM markets WHERE id=?", (mid,)).fetchone()
        assert (m["description"], m["rules_source"], m["rules_otherwise"]) == ("Resolves YES if it rains on Tuesday.", "Weather app", "")

        uid = _user(db, "better")
        appmod.execute_trade(db, uid, mid, appmod.get_outcomes(db, mid)[0]["id"], "buy", 10)
        edit(description="Totally different rules now!!", rules_source="Other", rules_otherwise="Changed")
        m = db.execute("SELECT * FROM markets WHERE id=?", (mid,)).fetchone()
        assert (m["description"], m["rules_source"]) == ("Resolves YES if it rains on Tuesday.", "Weather app")

        _post(admin, f"/admin/markets/{mid}/clarify", body="Drizzle counts as rain.")
        assert "5–500" in _post(admin, f"/admin/markets/{mid}/clarify", body="x").get_data(as_text=True)
        page = admin.get(f"/market/{mid}").get_data(as_text=True)
        assert "Drizzle counts as rain." in page and "Resolves YES if it rains on Tuesday." in page
        assert "Weather app" in page and "chance of Yes" in page
    finally:
        appmod.DB_PATH = old


def test_trade_labels_for_admins_and_creators_and_yesno_layout():
    old = appmod.DB_PATH
    try:
        db = _fresh_db()
        admin, maker = appmod.app.test_client(), appmod.app.test_client()
        signup(admin, "boss")
        signup(maker, "maker")
        maker_id = db.execute("SELECT id FROM users WHERE username='maker'").fetchone()[0]
        admin_id = db.execute("SELECT id FROM users WHERE username='boss'").fetchone()[0]
        closes = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")
        mid = appmod.create_market(db, "Labels?", RULES, "Other", closes, ["Yes", "No"], 100, maker_id)
        yes = appmod.get_outcomes(db, mid)[0]["id"]
        appmod.execute_trade(db, maker_id, mid, yes, "buy", 10)
        appmod.execute_trade(db, admin_id, mid, yes, "buy", 10)
        page = maker.get(f"/market/{mid}").get_data(as_text=True)
        assert ">creator<" in page and ">admin<" in page
        assert "¢" in page and "binary" in page  # Yes/No buttons show cents
        assert "chance" in maker.get("/").get_data(as_text=True)
        multi, _ = _market(db, 3, 100)
        assert "binary" not in maker.get(f"/market/{multi}").get_data(as_text=True).split('class="outcome-pick')[1][:10]
    finally:
        appmod.DB_PATH = old


def test_how_it_works_and_propose_pages_render_logged_out_and_in():
    old = appmod.DB_PATH
    try:
        _fresh_db()
        anon, user = appmod.app.test_client(), appmod.app.test_client()
        assert "Prices are probabilities" in anon.get("/how-it-works").get_data(as_text=True)
        signup(user, "writer")
        page = user.get("/propose").get_data(as_text=True)
        assert 'value="yesno"' in page and "Resolves YES if" in page and "market-preview" in page
    finally:
        appmod.DB_PATH = old


# ---------------------------------------------------------------- owner role

def test_owner_cannot_be_overridden_by_other_admins():
    path = os.path.join(tempfile.mkdtemp(), "owner.db")
    old = appmod.DB_PATH
    appmod.DB_PATH = path
    appmod._hits.clear()
    try:
        appmod.init_db()
        db = appmod.connect()
        owner, helper, kid = (appmod.app.test_client() for _ in range(3))
        signup(owner, "founder")
        signup(helper, "helper")
        signup(kid, "kid")
        uid = lambda n: db.execute("SELECT id FROM users WHERE username=?", (n,)).fetchone()[0]
        row = lambda n: db.execute("SELECT * FROM users WHERE username=?", (n,)).fetchone()
        banned = lambda n: db.execute("SELECT 1 FROM trade_bans WHERE user_id=?", (uid(n),)).fetchone() is not None

        # owner promotes helper
        owner.post(f"/admin/users/{uid('helper')}/toggle-admin", data={"csrf_token": csrf(owner.get("/admin"))})
        assert row("helper")["is_admin"] == 1
        page = owner.get("/admin").get_data(as_text=True)
        assert ">Owner<" in page and "only you can add or remove admins" in page

        # helper can't touch the owner in any way
        tok = csrf(helper.get("/admin"))
        r = helper.post(f"/admin/users/{uid('founder')}/toggle-admin", data={"csrf_token": tok}, follow_redirects=True)
        assert "Only the site owner" in r.get_data(as_text=True)
        assert row("founder")["is_admin"] == 1
        helper.post(f"/admin/users/{uid('founder')}/trading", data={"csrf_token": tok})
        assert not banned("founder")
        helper.post(f"/admin/users/{uid('founder')}/grant", data={"csrf_token": tok, "amount": -1000})
        assert row("founder")["balance"] == pytest.approx(1000)
        closes = (datetime.now() + timedelta(days=2)).strftime("%Y-%m-%d %H:%M:%S")
        mid = appmod.create_market(db, "Owner test?", "", "Other", closes, ["Yes", "No"], 100)
        helper.post(f"/admin/markets/{mid}/block", data={"csrf_token": tok, "username": "founder"})
        assert db.execute("SELECT COUNT(*) FROM market_blocks").fetchone()[0] == 0

        # helper can't make new admins
        helper.post(f"/admin/users/{uid('kid')}/toggle-admin", data={"csrf_token": tok})
        assert row("kid")["is_admin"] == 0

        # helper CAN manage regular users
        helper.post(f"/admin/users/{uid('kid')}/trading", data={"csrf_token": tok})
        assert banned("kid")
        helper.post(f"/admin/users/{uid('kid')}/grant", data={"csrf_token": tok, "amount": 50})
        assert row("kid")["balance"] == pytest.approx(1050)

        # owner can demote the helper; owner can't be banned even by themself
        tok = csrf(owner.get("/admin"))
        owner.post(f"/admin/users/{uid('helper')}/toggle-admin", data={"csrf_token": tok})
        assert row("helper")["is_admin"] == 0
        assert helper.get("/admin").status_code == 403
        owner.post(f"/admin/users/{uid('founder')}/trading", data={"csrf_token": tok})
        assert not banned("founder")
    finally:
        appmod.DB_PATH = old


def test_owner_from_env_var(monkeypatch):
    path = os.path.join(tempfile.mkdtemp(), "owner_env.db")
    old = appmod.DB_PATH
    appmod.DB_PATH = path
    appmod._hits.clear()
    monkeypatch.setattr(appmod, "OWNER_USERNAME", "realowner")
    try:
        appmod.init_db()
        db = appmod.connect()
        first, real = appmod.app.test_client(), appmod.app.test_client()
        signup(first, "earlybird")      # first account, but not the configured owner
        signup(real, "RealOwner")       # matches MAMS_OWNER case-insensitively
        admin_flag = lambda n: db.execute("SELECT is_admin FROM users WHERE username=?", (n,)).fetchone()[0]
        assert admin_flag("earlybird") == 0
        assert admin_flag("RealOwner") == 1
        assert ">Owner<" in real.get("/admin").get_data(as_text=True)
    finally:
        appmod.DB_PATH = old


def test_existing_markets_upgraded_to_deeper_liquidity_without_moving_prices():
    old = appmod.DB_PATH
    try:
        db = _fresh_db()
        uid = db.execute("INSERT INTO users (username, password_hash, balance, created_at) VALUES ('olduser', 'x', 1000, ?)",
                         (appmod.now_str(),)).lastrowid
        closes = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")
        mid = appmod.create_market(db, "Old shallow?", "Resolves YES if the old market says so.", "Other",
                                   closes, ["Yes", "No", "Maybe"], 300)  # created under the old "medium" setting
        done = appmod.create_market(db, "Already settled?", "Resolves YES if the old market says so.", "Other",
                                    closes, ["Yes", "No"], 300)
        db.execute("UPDATE markets SET status = 'resolved' WHERE id = ?", (done,))
        yes = appmod.get_outcomes(db, mid)[0]["id"]
        appmod.execute_trade(db, uid, mid, yes, "buy", 200)
        q_before = [o["shares"] for o in appmod.get_outcomes(db, mid)]
        prices_before = appmod.lmsr.prices(q_before, 300)
        held = db.execute("SELECT shares FROM positions WHERE user_id=?", (uid,)).fetchone()[0]
        bal = db.execute("SELECT balance FROM users WHERE id=?", (uid,)).fetchone()[0]

        appmod.deepen_liquidity(db)
        appmod.deepen_liquidity(db)  # running again changes nothing

        b = db.execute("SELECT b FROM markets WHERE id=?", (mid,)).fetchone()[0]
        assert b == pytest.approx(appmod.market_b(3))
        q_after = [o["shares"] for o in appmod.get_outcomes(db, mid)]
        assert appmod.lmsr.prices(q_after, b) == pytest.approx(prices_before)          # prices unchanged
        assert db.execute("SELECT shares FROM positions WHERE user_id=?", (uid,)).fetchone()[0] == held
        assert db.execute("SELECT balance FROM users WHERE id=?", (uid,)).fetchone()[0] == bal
        assert db.execute("SELECT b FROM markets WHERE id=?", (done,)).fetchone()[0] == 300  # settled: untouched

        # the same bet now moves the price less than it would have before
        shallow = appmod.lmsr.prices([q_before[0] + appmod.lmsr.shares_for_amount(q_before, 300, 0, 100)] + q_before[1:], 300)[0]
        deep = appmod.lmsr.prices([q_after[0] + appmod.lmsr.shares_for_amount(q_after, b, 0, 100)] + q_after[1:], b)[0]
        assert deep - prices_before[0] < (shallow - prices_before[0]) / 2
    finally:
        appmod.DB_PATH = old


# ---------------------------------------------------------------- over/under

def test_ou_labels_and_text():
    assert appmod.ou_labels(85, "%") == ["Over 85%", "Under 85%"]
    assert appmod.ou_labels(90, "minutes") == ["Over 90 minutes", "Under 90 minutes"]
    assert appmod.ou_labels(50.5, "") == ["Over 50.5", "Under 50.5"]
    assert appmod.ou_text(1200, "pts") == "1,200 pts"
    assert appmod.parse_ou({"ou_line": "abc"})[2]
    assert appmod.parse_ou({"ou_line": "nan"})[2]
    assert appmod.parse_ou({"ou_line": " 1,250.5 ", "ou_unit": " points "})[:2] == (1250.5, "points")


def test_over_under_create_trade_and_resolve():
    old = appmod.DB_PATH
    try:
        db = _fresh_db()
        admin, kid = appmod.app.test_client(), appmod.app.test_client()
        signup(admin, "ouboss")
        signup(kid, "oukid")
        closes = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%dT%H:%M")
        r = admin.post("/admin/markets", data={
            "csrf_token": csrf(admin.get("/admin")), "kind": "overunder", "ou_line": "85", "ou_unit": "%",
            "question": "Physics test average?", "description": "The class average as announced by the teacher.",
            "category": "Academics", "closes_at": closes, "outcomes": "should be ignored"}, follow_redirects=True)
        assert "Market created." in r.get_data(as_text=True)
        m = db.execute("SELECT * FROM markets WHERE question='Physics test average?'").fetchone()
        assert (m["ou_line"], m["ou_unit"], m["b"]) == (85, "%", 1000)
        over, under = appmod.get_outcomes(db, m["id"])
        assert (over["label"], under["label"]) == ("Over 85%", "Under 85%")

        page = kid.get(f"/market/{m['id']}").get_data(as_text=True)
        assert "Over / Under 85%" in page and "chance of Over 85%" in page
        assert "Over / Under 85%" in kid.get("/").get_data(as_text=True)

        kid_id = db.execute("SELECT id FROM users WHERE username='oukid'").fetchone()[0]
        appmod.execute_trade(db, kid_id, m["id"], over["id"], "buy", 100)
        db.execute("UPDATE markets SET closes_at = ? WHERE id = ?",
                   ((datetime.now() - timedelta(minutes=1)).strftime("%Y-%m-%d %H:%M:%S"), m["id"]))

        url = f"/admin/markets/{m['id']}/propose-result"
        r = admin.post(url, data={"csrf_token": csrf(admin.get("/admin")), "actual": "85"}, follow_redirects=True)
        assert "exactly on the line" in r.get_data(as_text=True)
        r = admin.post(url, data={"csrf_token": csrf(admin.get("/admin")), "actual": "abc"}, follow_redirects=True)
        assert "Enter the actual number" in r.get_data(as_text=True)

        admin.post(url, data={"csrf_token": csrf(admin.get("/admin")), "actual": "87.3"})
        m = db.execute("SELECT * FROM markets WHERE id=?", (m["id"],)).fetchone()
        assert m["proposed_outcome_id"] == over["id"] and m["ou_result"] == 87.3
        assert "Result: <b>87.3%</b>" in kid.get(f"/market/{m['id']}").get_data(as_text=True)

        # withdrawing clears the number; a lower number picks Under
        admin.post(f"/admin/markets/{m['id']}/result-action",
                   data={"csrf_token": csrf(admin.get("/admin")), "decision": "retract"})
        assert db.execute("SELECT ou_result FROM markets WHERE id=?", (m["id"],)).fetchone()[0] is None
        admin.post(url, data={"csrf_token": csrf(admin.get("/admin")), "actual": "80"})
        assert db.execute("SELECT proposed_outcome_id FROM markets WHERE id=?", (m["id"],)).fetchone()[0] == under["id"]
    finally:
        appmod.DB_PATH = old


def test_over_under_proposal_and_edit():
    old = appmod.DB_PATH
    try:
        db = _fresh_db()
        admin, kid = appmod.app.test_client(), appmod.app.test_client()
        signup(admin, "ouadmin")
        signup(kid, "ouproposer")
        closes = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%dT%H:%M")
        assert 'value="overunder"' in kid.get("/propose").get_data(as_text=True)
        kid.post("/propose", data={"csrf_token": csrf(kid.get("/propose")), "kind": "overunder", "ou_line": "90",
                                   "ou_unit": "minutes", "question": "How long is the assembly?",
                                   "description": "From scheduled start to dismissal, timed by the admins.",
                                   "category": "Events", "closes_at": closes})
        p = db.execute("SELECT * FROM proposals WHERE question='How long is the assembly?'").fetchone()
        assert (p["ou_line"], p["ou_unit"]) == (90, "minutes")
        review = admin.get(f"/admin/proposals/{p['id']}").get_data(as_text=True)
        assert re.search(r'value="overunder"\s+checked', review) and 'value="90"' in review

        admin.post(f"/admin/proposals/{p['id']}", data={
            "csrf_token": csrf(admin.get(f"/admin/proposals/{p['id']}")), "decision": "approve", "kind": "overunder",
            "ou_line": "90", "ou_unit": "minutes", "question": "How long is the assembly?",
            "description": "From scheduled start to dismissal, timed by the admins.", "category": "Events",
            "closes_at": closes})
        mid = db.execute("SELECT market_id FROM proposals WHERE id=?", (p["id"],)).fetchone()[0]
        assert [o["label"] for o in appmod.get_outcomes(db, mid)] == ["Over 90 minutes", "Under 90 minutes"]

        # before any bets the line can be edited; afterwards it's locked
        edit = lambda line: admin.post(f"/admin/markets/{mid}/edit", data={
            "csrf_token": csrf(admin.get(f"/admin/markets/{mid}/edit")), "question": "How long is the assembly?",
            "description": "From scheduled start to dismissal, timed by the admins.", "category": "Events",
            "closes_at": closes, "ou_line": line, "ou_unit": "min"})
        assert 'name="ou_line"' in admin.get(f"/admin/markets/{mid}/edit").get_data(as_text=True)
        edit("75.5")
        assert [o["label"] for o in appmod.get_outcomes(db, mid)] == ["Over 75.5 min", "Under 75.5 min"]
        kid_id = db.execute("SELECT id FROM users WHERE username='ouproposer'").fetchone()[0]
        appmod.execute_trade(db, kid_id, mid, appmod.get_outcomes(db, mid)[1]["id"], "buy", 50)
        edit("120")
        assert db.execute("SELECT ou_line FROM markets WHERE id=?", (mid,)).fetchone()[0] == 75.5
        assert [o["label"] for o in appmod.get_outcomes(db, mid)] == ["Over 75.5 min", "Under 75.5 min"]
    finally:
        appmod.DB_PATH = old


@pytest.mark.parametrize("yes_means", ["over", "under"])
def test_convert_yes_no_to_over_under_keeps_bets(yes_means):
    old = appmod.DB_PATH
    try:
        db = _fresh_db()
        admin = appmod.app.test_client()
        signup(admin, "convboss")
        uid = db.execute("SELECT id FROM users WHERE username='convboss'").fetchone()[0]
        closes = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")
        mid = appmod.create_market(db, "Physics Average +- 85%", RULES, "Academics", closes, ["YES", "NO"], 1000)
        yes, no = appmod.get_outcomes(db, mid)
        appmod.execute_trade(db, uid, mid, yes["id"], "buy", 200)
        yes_price = appmod.bundle(db, db.execute("SELECT * FROM markets WHERE id=?", (mid,)).fetchone())["outcomes"][0]["price"]
        history_before = [json.loads(r[0]) for r in db.execute("SELECT prices FROM price_history WHERE market_id=? ORDER BY id", (mid,))]
        bal = db.execute("SELECT balance FROM users WHERE id=?", (uid,)).fetchone()[0]

        r = admin.post(f"/admin/markets/{mid}/convert-ou", data={
            "csrf_token": csrf(admin.get(f"/market/{mid}")), "ou_line": "85", "ou_unit": "%", "yes_means": yes_means},
            follow_redirects=True)
        assert "bets carried over" in r.get_data(as_text=True)

        m = db.execute("SELECT * FROM markets WHERE id=?", (mid,)).fetchone()
        b = appmod.bundle(db, m)
        assert b["ou"]["text"] == "85%" and b["binary"]
        assert [o["label"] for o in b["outcomes"]] == ["Over 85%", "Under 85%"]
        held_label = db.execute("SELECT o.label FROM positions p JOIN outcomes o ON o.id = p.outcome_id "
                                "WHERE p.user_id=?", (uid,)).fetchone()[0]
        assert held_label == ("Over 85%" if yes_means == "over" else "Under 85%")
        side = 0 if yes_means == "over" else 1
        assert b["outcomes"][side]["price"] == pytest.approx(yes_price)      # YES's price moved with its bets
        history_after = [json.loads(r[0]) for r in db.execute("SELECT prices FROM price_history WHERE market_id=? ORDER BY id", (mid,))]
        assert history_after == (history_before if yes_means == "over" else [h[::-1] for h in history_before])
        assert db.execute("SELECT balance FROM users WHERE id=?", (uid,)).fetchone()[0] == bal
        note = db.execute("SELECT body FROM clarifications WHERE market_id=?", (mid,)).fetchone()[0]
        assert "Converted to Over/Under 85%" in note
        assert admin.get(f"/market/{mid}").status_code == 200

        # can't convert twice, or convert multiple-choice markets
        r = admin.post(f"/admin/markets/{mid}/convert-ou", data={
            "csrf_token": csrf(admin.get(f"/market/{mid}")), "ou_line": "90", "yes_means": "over"}, follow_redirects=True)
        assert "already Over/Under" in r.get_data(as_text=True)
        multi = appmod.create_market(db, "Which month?", RULES, "Other", closes, ["Dec", "Jan", "Feb"], 1585)
        r = admin.post(f"/admin/markets/{multi}/convert-ou", data={
            "csrf_token": csrf(admin.get(f"/market/{multi}")), "ou_line": "1", "yes_means": "over"}, follow_redirects=True)
        assert "Only Yes/No markets" in r.get_data(as_text=True)
    finally:
        appmod.DB_PATH = old


# ---------------------------------------------------------------- activity log

def test_activity_log_records_every_balance_change():
    old = appmod.DB_PATH
    try:
        db = _fresh_db()
        admin, ann, ben = (appmod.app.test_client() for _ in range(3))
        signup(admin, "logboss")
        signup(ann, "ann")
        signup(ben, "ben")
        uid = lambda n: db.execute("SELECT id FROM users WHERE username=?", (n,)).fetchone()[0]
        bal = lambda n: db.execute("SELECT balance FROM users WHERE username=?", (n,)).fetchone()[0]
        log = lambda n: db.execute("SELECT kind, amount, balance_after, detail FROM activity WHERE user_id=? ORDER BY id",
                                   (uid(n),)).fetchall()
        closes = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")

        assert [tuple(r)[:3] for r in log("ann")] == [("signup", 1000, 1000)]
        ann.post("/bonus", data={"csrf_token": csrf(ann.get("/"))})
        assert log("ann")[-1]["kind"] == "bonus" and log("ann")[-1]["balance_after"] == 1100

        # buy / sell
        m1 = appmod.create_market(db, "Win?", RULES, "Other", closes, ["Yes", "No"], 1000)
        yes, no = appmod.get_outcomes(db, m1)
        appmod.execute_trade(db, uid("ann"), m1, yes["id"], "buy", 200)
        appmod.execute_trade(db, uid("ben"), m1, no["id"], "buy", 50)
        buy = log("ann")[-1]
        assert buy["kind"] == "buy" and buy["amount"] == -200 and buy["balance_after"] == 900
        assert "Bought" in buy["detail"] and "“Yes”" in buy["detail"]
        held = db.execute("SELECT shares FROM positions WHERE user_id=?", (uid("ann"),)).fetchone()[0]
        msg = appmod.execute_trade(db, uid("ann"), m1, yes["id"], "sell", held / 4)
        sell = log("ann")[-1]
        assert sell["kind"] == "sell" and sell["amount"] > 0 and sell["balance_after"] == pytest.approx(bal("ann"))
        assert "You received" in msg and "Balance:" in msg

        # resolution: winner paid, loser told they got nothing
        db.execute("UPDATE markets SET closes_at = ? WHERE id = ?",
                   ((datetime.now() - timedelta(minutes=1)).strftime("%Y-%m-%d %H:%M:%S"), m1))
        appmod.resolve_market(db, m1, yes["id"])
        payout = log("ann")[-1]
        assert payout["kind"] == "payout" and payout["amount"] == pytest.approx(held * 0.75, abs=0.01)
        assert payout["balance_after"] == pytest.approx(bal("ann"))
        loss = log("ben")[-1]
        assert loss["kind"] == "loss" and loss["amount"] == 0 and "“No”" in loss["detail"]

        # refunds: cancelled market, and being blocked
        m2 = appmod.create_market(db, "Cancel?", RULES, "Other", closes, ["Yes", "No"], 1000)
        appmod.execute_trade(db, uid("ben"), m2, appmod.get_outcomes(db, m2)[0]["id"], "buy", 40)
        appmod.cancel_market(db, m2)
        assert tuple(log("ben")[-1])[:2] == ("refund", 40) and "cancelled" in log("ben")[-1]["detail"]
        m3 = appmod.create_market(db, "Block?", RULES, "Other", closes, ["Yes", "No"], 1000)
        appmod.execute_trade(db, uid("ben"), m3, appmod.get_outcomes(db, m3)[0]["id"], "buy", 30)
        appmod.block_user_in_market(db, uid("ben"), m3)
        assert tuple(log("ben")[-1])[:2] == ("refund", 30) and "blocked" in log("ben")[-1]["detail"]

        # admin adjustment records what actually changed (can't go below zero)
        admin.post(f"/admin/users/{uid('ben')}/grant", data={"csrf_token": csrf(admin.get("/admin")), "amount": -99999})
        adj = log("ben")[-1]
        assert adj["kind"] == "admin" and adj["balance_after"] == 0 and adj["amount"] < 0 and "logboss" in adj["detail"]

        # every balance_after matches a running total of the amounts
        for name in ("ann", "ben"):
            running = 0
            for r in log(name):
                running = round(running + r["amount"], 2)
                assert r["balance_after"] == pytest.approx(running, abs=0.02), (name, tuple(r))

        # pages: own log, admin can view others, non-admins can't
        page = ann.get("/activity/mine").get_data(as_text=True)
        assert "Your balance history" in page and "Daily bonus" in page and "Win?" in page
        assert "Your balance history" in ann.get("/activity/mine?user=ben").get_data(as_text=True)   # ignored for non-admins
        other = admin.get("/activity/mine?user=ben").get_data(as_text=True)
        assert "ben&#39;s balance history" in other and "Refund: market cancelled" in other
        assert admin.get("/activity/mine?user=nobody").status_code == 404
        assert "Bought" in ann.get("/activity/mine?show=trades").get_data(as_text=True)
        assert "Daily bonus" not in ann.get("/activity/mine?show=trades").get_data(as_text=True)

        # deleting a market keeps the history
        appmod.delete_market(db, m3)
        assert "Block? (deleted)" in admin.get("/activity/mine?user=ben").get_data(as_text=True)
    finally:
        appmod.DB_PATH = old


def test_activity_backfilled_from_old_trades():
    old = appmod.DB_PATH
    try:
        db = _fresh_db()
        uid = db.execute("INSERT INTO users (username, password_hash, balance, created_at) VALUES ('vet', 'x', 1000, ?)",
                         (appmod.now_str(),)).lastrowid
        closes = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")
        mid = appmod.create_market(db, "Old trades?", RULES, "Other", closes, ["Yes", "No"], 1000)
        appmod.execute_trade(db, uid, mid, appmod.get_outcomes(db, mid)[0]["id"], "buy", 25)
        db.execute("DELETE FROM activity")           # simulate a database from before the log existed
        appmod.backfill_activity(db)
        rows = db.execute("SELECT kind, amount, balance_after, detail FROM activity WHERE user_id=?", (uid,)).fetchall()
        assert [(r["kind"], r["amount"], r["balance_after"]) for r in rows] == [("buy", -25, None)]
        assert rows[0]["detail"].startswith("Bought ")
        appmod.backfill_activity(db)                 # only runs once
        assert db.execute("SELECT COUNT(*) FROM activity").fetchone()[0] == 1
    finally:
        appmod.DB_PATH = old


def test_activity_feed_shows_every_trade():
    old = appmod.DB_PATH
    try:
        db = _fresh_db()
        ann, ben, visitor = (appmod.app.test_client() for _ in range(3))
        signup(ann, "feedann")
        signup(ben, "feedben")
        uid = lambda n: db.execute("SELECT id FROM users WHERE username=?", (n,)).fetchone()[0]
        closes = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")
        m1 = appmod.create_market(db, "Feed market one?", RULES, "Other", closes, ["Yes", "No"], 1000)
        m2 = appmod.create_market(db, "Feed market two?", RULES, "Other", closes, ["Yes", "No"], 1000)
        y1, y2 = appmod.get_outcomes(db, m1)[0]["id"], appmod.get_outcomes(db, m2)[0]["id"]
        appmod.execute_trade(db, uid("feedann"), m1, y1, "buy", 60)
        appmod.execute_trade(db, uid("feedben"), m2, y2, "buy", 40)
        held = db.execute("SELECT shares FROM positions WHERE user_id=?", (uid("feedann"),)).fetchone()[0]
        appmod.execute_trade(db, uid("feedann"), m1, y1, "sell", held / 2)
        ann.post("/bonus", data={"csrf_token": csrf(ann.get("/"))})   # not a trade: must not appear

        page = visitor.get("/activity").get_data(as_text=True)          # public, no login needed
        assert page.count('class="kind kind-') == 3
        assert "feedann" in page and "feedben" in page and "Feed market two?" in page
        assert "Daily bonus" not in page and "Starting balance" not in page
        assert ">3<" in page                                              # trade count

        only_ann = visitor.get("/activity?trader=feedann").get_data(as_text=True)
        assert only_ann.count('class="kind kind-') == 2 and "Feed market two?" not in only_ann.split("Showing only")[1]
        only_m2 = visitor.get(f"/activity?market={m2}").get_data(as_text=True)
        assert only_m2.count('class="kind kind-') == 1
        assert visitor.get("/activity?show=sells").get_data(as_text=True).count('class="kind kind-sell"') == 1
        assert visitor.get("/activity?show=buys").get_data(as_text=True).count('class="kind kind-') == 2

        # trades stay in the feed after their market is deleted
        appmod.delete_market(db, m2)
        assert "Feed market two? (deleted)" in visitor.get("/activity").get_data(as_text=True)
        assert visitor.get("/activity?market=abc").status_code == 404
    finally:
        appmod.DB_PATH = old


def test_activity_feed_pages_back_through_history():
    old = appmod.DB_PATH
    try:
        db = _fresh_db()
        uid = db.execute("INSERT INTO users (username, password_hash, balance, created_at) VALUES ('pager', 'x', 100000, ?)",
                         (appmod.now_str(),)).lastrowid
        closes = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")
        mid = appmod.create_market(db, "Busy?", RULES, "Other", closes, ["Yes", "No"], 1000)
        yes = appmod.get_outcomes(db, mid)[0]["id"]
        for _ in range(appmod.FEED_PAGE + 5):
            appmod.execute_trade(db, uid, mid, yes, "buy", 1)
        client = appmod.app.test_client()
        first = client.get("/activity").get_data(as_text=True)
        assert first.count('class="kind kind-') == appmod.FEED_PAGE and "Older trades" in first
        before = re.search(r"before=(\d+)", first).group(1)
        second = client.get(f"/activity?before={before}").get_data(as_text=True)
        assert second.count('class="kind kind-') == 5 and "Older trades" not in second
    finally:
        appmod.DB_PATH = old


# ---------------------------------------------------------------- fees & dispute window

def test_dispute_window_is_two_hours():
    old = appmod.DB_PATH
    try:
        db = _fresh_db()
        assert appmod.DISPUTE_WINDOW == timedelta(hours=2) and appmod.DISPUTE_HOURS == 2
        aid = db.execute("INSERT INTO users (username, password_hash, balance, is_admin, created_at) VALUES ('w', 'x', 0, 1, ?)",
                         (appmod.now_str(),)).lastrowid
        past = (datetime.now() - timedelta(minutes=1)).strftime("%Y-%m-%d %H:%M:%S")
        mid = appmod.create_market(db, "Window?", RULES, "Other", past, ["Yes", "No"], 1000)
        appmod.propose_result(db, mid, appmod.get_outcomes(db, mid)[0]["id"], aid)
        fin = appmod.parse_dt(db.execute("SELECT finalizes_at FROM markets WHERE id=?", (mid,)).fetchone()[0])
        assert timedelta(minutes=119) < fin - datetime.now() <= timedelta(hours=2)
        assert "2 hours" in appmod.app.test_client().get("/how-it-works").get_data(as_text=True)
    finally:
        appmod.DB_PATH = old


def test_creation_fee_for_proposals_and_admin_markets():
    old = appmod.DB_PATH
    try:
        db = _fresh_db()
        admin, kid = appmod.app.test_client(), appmod.app.test_client()
        signup(admin, "feeboss")
        signup(kid, "feekid")
        bal = lambda n: db.execute("SELECT balance FROM users WHERE username=?", (n,)).fetchone()[0]
        closes = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%dT%H:%M")
        form = lambda q: {"kind": "yesno", "question": q, "description": RULES, "category": "Events", "closes_at": closes}

        def propose(q):
            return kid.post("/propose", data={"csrf_token": csrf(kid.get("/propose")), **form(q)}, follow_redirects=True)

        assert "Costs Ⓜ20 to propose" in kid.get("/propose").get_data(as_text=True)
        assert "You paid the Ⓜ20 fee" in propose("Kept?").get_data(as_text=True)
        assert bal("feekid") == 980
        propose("Withdrawn?")
        assert bal("feekid") == 960

        # withdrawing refunds; rejecting keeps the fee
        pid = db.execute("SELECT id FROM proposals WHERE question='Withdrawn?'").fetchone()[0]
        r = kid.post(f"/propose/{pid}/withdraw", data={"csrf_token": csrf(kid.get("/propose"))}, follow_redirects=True)
        assert "Ⓜ20 fee was refunded" in r.get_data(as_text=True) and bal("feekid") == 980
        pid = db.execute("SELECT id FROM proposals WHERE question='Kept?'").fetchone()[0]
        admin.post(f"/admin/proposals/{pid}", data={"csrf_token": csrf(admin.get(f"/admin/proposals/{pid}")),
                                                     "decision": "reject", "review_note": "Too vague"})
        assert bal("feekid") == 980
        assert "fee kept" in kid.get("/propose").get_data(as_text=True)

        # approving doesn't charge again
        propose("Approved?")
        pid = db.execute("SELECT id FROM proposals WHERE question='Approved?'").fetchone()[0]
        admin.post(f"/admin/proposals/{pid}", data={"csrf_token": csrf(admin.get(f"/admin/proposals/{pid}")),
                                                     "decision": "approve", **form("Approved?")})
        assert bal("feekid") == 960 and bal("feeboss") == 1000

        # can't propose without Ⓜ20
        db.execute("UPDATE users SET balance = 15 WHERE username='feekid'")
        assert "costs Ⓜ20" in propose("Broke?").get_data(as_text=True)
        assert db.execute("SELECT COUNT(*) FROM proposals WHERE question='Broke?'").fetchone()[0] == 0
        assert bal("feekid") == 15

        # admins pay too when creating directly
        r = admin.post("/admin/markets", data={"csrf_token": csrf(admin.get("/admin")), **form("Admin made?")},
                       follow_redirects=True)
        assert "You paid the Ⓜ20 creation fee" in r.get_data(as_text=True) and bal("feeboss") == 980
        db.execute("UPDATE users SET balance = 5 WHERE username='feeboss'")
        r = admin.post("/admin/markets", data={"csrf_token": csrf(admin.get("/admin")), **form("Too poor?")},
                       follow_redirects=True)
        assert "costs Ⓜ20" in r.get_data(as_text=True)
        assert db.execute("SELECT COUNT(*) FROM markets WHERE question='Too poor?'").fetchone()[0] == 0
        kinds = [r[0] for r in db.execute("SELECT kind FROM activity WHERE user_id=(SELECT id FROM users WHERE username='feekid')")]
        assert kinds.count("fee") == 3 and kinds.count("refund") == 1  # Kept, Withdrawn, Approved; Broke? was blocked
    finally:
        appmod.DB_PATH = old


def test_entry_fee_paid_to_creator_once_per_trader():
    old = appmod.DB_PATH
    try:
        db = _fresh_db()
        ids = {}
        for n in ("maker", "t1", "t2", "oldtimer"):
            ids[n] = db.execute("INSERT INTO users (username, password_hash, balance, created_at) VALUES (?, 'x', 1000, ?)",
                                (n, appmod.now_str())).lastrowid
        bal = lambda n: db.execute("SELECT balance FROM users WHERE id=?", (ids[n],)).fetchone()[0]
        closes = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")
        mid = appmod.create_market(db, "Fee market?", RULES, "Other", closes, ["Yes", "No"], 1000, ids["maker"])
        yes, no = [o["id"] for o in appmod.get_outcomes(db, mid)]

        # someone who traded before entry fees existed isn't charged
        db.execute("INSERT INTO trades (user_id, market_id, outcome_id, shares, amount, created_at) VALUES (?, ?, ?, 0, 0, ?)",
                   (ids["oldtimer"], mid, yes, appmod.now_str()))
        appmod.execute_trade(db, ids["oldtimer"], mid, yes, "buy", 50)
        assert bal("oldtimer") == 950

        msg = appmod.execute_trade(db, ids["t1"], mid, yes, "buy", 100)
        assert "plus a Ⓜ10 entry fee to maker" in msg
        assert bal("t1") == 890 and bal("maker") == 1010
        appmod.execute_trade(db, ids["t1"], mid, no, "buy", 100)          # second bet, other side: no fee
        assert bal("t1") == 790 and bal("maker") == 1010
        held = db.execute("SELECT shares FROM positions WHERE user_id=? AND outcome_id=?", (ids["t1"], yes)).fetchone()[0]
        before = bal("t1")
        appmod.execute_trade(db, ids["t1"], mid, yes, "sell", held / 2)   # selling never costs a fee
        assert bal("maker") == 1010 and bal("t1") > before
        appmod.execute_trade(db, ids["maker"], mid, yes, "buy", 20)        # creator's own market: no fee
        assert bal("maker") == 990

        # the bet plus the fee must fit in your balance
        db.execute("UPDATE users SET balance = 105 WHERE id=?", (ids["t2"],))
        with pytest.raises(appmod.TradeError, match=r"need Ⓜ110.00"):
            appmod.execute_trade(db, ids["t2"], mid, yes, "buy", 100)
        assert bal("t2") == 105 and bal("maker") == 990
        appmod.execute_trade(db, ids["t2"], mid, yes, "buy", 95)
        assert bal("t2") == 0 and bal("maker") == 1000

        # markets with no creator have no fee
        free = appmod.create_market(db, "Free?", RULES, "Other", closes, ["Yes", "No"], 1000)
        db.execute("UPDATE users SET balance = 100 WHERE id=?", (ids["t2"],))
        appmod.execute_trade(db, ids["t2"], free, appmod.get_outcomes(db, free)[0]["id"], "buy", 100)
        assert bal("t2") == 0

        # activity shows the fee and the creator's earnings
        assert db.execute("SELECT COUNT(*) FROM activity WHERE user_id=? AND kind='earning'", (ids["maker"],)).fetchone()[0] == 2
        assert db.execute("SELECT detail FROM activity WHERE user_id=? AND kind='fee'", (ids["t1"],)).fetchone()[0] \
            == "Entry fee (first bet), paid to maker"
    finally:
        appmod.DB_PATH = old


def test_entry_fees_refunded_on_cancel_and_block_and_shown_in_quote():
    old = appmod.DB_PATH
    try:
        db = _fresh_db()
        maker, trader = appmod.app.test_client(), appmod.app.test_client()
        signup(maker, "qmaker")
        signup(trader, "qtrader")
        uid = lambda n: db.execute("SELECT id FROM users WHERE username=?", (n,)).fetchone()[0]
        bal = lambda n: db.execute("SELECT balance FROM users WHERE username=?", (n,)).fetchone()[0]
        closes = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")
        mid = appmod.create_market(db, "Quote fee?", RULES, "Other", closes, ["Yes", "No"], 1000, uid("qmaker"))
        yes = appmod.get_outcomes(db, mid)[0]["id"]

        page = trader.get(f"/market/{mid}").get_data(as_text=True)
        assert "Ⓜ10 entry fee" in page and 'data-entry-fee="10.0"' in page
        q = trader.get(f"/api/quote?market={mid}&outcome={yes}&action=buy&value=50").get_json()
        assert q["ok"] and q["entry_fee"] == 10 and q["creator"] == "qmaker" and q["coins"] == 50
        assert maker.get(f"/api/quote?market={mid}&outcome={yes}&action=buy&value=50").get_json()["entry_fee"] == 0
        assert "you earn Ⓜ10" in maker.get(f"/market/{mid}").get_data(as_text=True)

        appmod.execute_trade(db, uid("qtrader"), mid, yes, "buy", 50)
        assert trader.get(f"/api/quote?market={mid}&outcome={yes}&action=buy&value=50").get_json()["entry_fee"] == 0
        assert "already paid the entry fee" in trader.get(f"/market/{mid}").get_data(as_text=True)
        assert (bal("qtrader"), bal("qmaker")) == (940, 1010)

        # blocked: bet and entry fee both come back, creator gives the fee back
        appmod.block_user_in_market(db, uid("qtrader"), mid)
        assert (bal("qtrader"), bal("qmaker")) == (1000, 1000)

        # cancelled: same
        mid2 = appmod.create_market(db, "Cancel fee?", RULES, "Other", closes, ["Yes", "No"], 1000, uid("qmaker"))
        appmod.execute_trade(db, uid("qtrader"), mid2, appmod.get_outcomes(db, mid2)[0]["id"], "buy", 30)
        assert (bal("qtrader"), bal("qmaker")) == (960, 1010)
        appmod.cancel_market(db, mid2)
        assert (bal("qtrader"), bal("qmaker")) == (1000, 1000)
        assert "Entry fee refunded: market cancelled" in trader.get("/activity/mine").get_data(as_text=True)
    finally:
        appmod.DB_PATH = old


def test_pending_results_moved_onto_shorter_dispute_window():
    old = appmod.DB_PATH
    try:
        db = _fresh_db()
        aid = db.execute("INSERT INTO users (username, password_hash, balance, is_admin, created_at) VALUES ('sw', 'x', 0, 1, ?)",
                         (appmod.now_str(),)).lastrowid
        past = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d %H:%M:%S")
        fmt = lambda d: d.strftime("%Y-%m-%d %H:%M:%S")
        now = datetime.now()

        def market(q, proposed_ago, deadline_in):
            mid = appmod.create_market(db, q, RULES, "Other", past, ["Yes", "No"], 1000)
            db.execute("UPDATE markets SET proposed_outcome_id = ?, proposed_by = ?, proposed_at = ?, finalizes_at = ? "
                       "WHERE id = ?", (appmod.get_outcomes(db, mid)[0]["id"], aid, fmt(now - proposed_ago),
                                        fmt(now + deadline_in), mid))
            return mid

        recent = market("Proposed 30 min ago?", timedelta(minutes=30), timedelta(hours=23, minutes=30))
        stale = market("Proposed 5 hours ago?", timedelta(hours=5), timedelta(hours=19))
        already = market("Already short?", timedelta(minutes=10), timedelta(minutes=50))  # earlier than 2h: untouched
        before_already = db.execute("SELECT finalizes_at FROM markets WHERE id=?", (already,)).fetchone()[0]

        appmod.shorten_dispute_windows(db)
        appmod.shorten_dispute_windows(db)  # running again changes nothing

        fin = lambda mid: appmod.parse_dt(db.execute("SELECT finalizes_at FROM markets WHERE id=?", (mid,)).fetchone()[0])
        assert abs((fin(recent) - (now + timedelta(minutes=90))).total_seconds()) < 2
        assert fin(stale) < datetime.now()
        assert db.execute("SELECT finalizes_at FROM markets WHERE id=?", (already,)).fetchone()[0] == before_already

        # the overdue one finalizes on the next page load; the others keep waiting
        appmod.app.test_client().get("/")
        status = lambda mid: db.execute("SELECT status FROM markets WHERE id=?", (mid,)).fetchone()[0]
        assert (status(stale), status(recent), status(already)) == ("resolved", "open", "open")
    finally:
        appmod.DB_PATH = old
