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
    assert "Bought" in r.get_data(as_text=True)
    bal = db.execute("SELECT balance FROM users WHERE username='bob'").fetchone()[0]
    assert bal == pytest.approx(900)
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
    assert db.execute("SELECT balance FROM users WHERE username='bob'").fetchone()[0] == pytest.approx(900)
    assert "Proposed result" in bob.get(f"/market/{mid}").get_data(as_text=True)

    # window ends with no dispute -> the next request finalizes and pays 1 per share
    db.execute("UPDATE markets SET finalizes_at = ? WHERE id = ?", (past(), mid))
    bob.get("/")
    bal = db.execute("SELECT balance FROM users WHERE username='bob'").fetchone()[0]
    assert bal == pytest.approx(900 + shares, abs=0.01)

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
        assert m["b"] == pytest.approx(600 * 1.5849625007)  # "high", 3 outcomes
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
        assert db.execute("SELECT b FROM markets WHERE id=?", (mid,)).fetchone()[0] == pytest.approx(600 * 1.5849625007)
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
        assert m["question"] == "Will the pep rally have a live band?" and m["b"] == 600
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
    assert appmod.market_b("medium", 2) == 300
    assert appmod.market_b("medium", 8) == 900
    assert appmod.market_b("bogus", 2) == 300
    assert appmod.preset_for(900, 8) == "medium"
    assert appmod.preset_for(50, 2) == "low"  # old-style markets map to the nearest preset


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
        assert b == pytest.approx(900)
        page = admin.get(f"/admin/markets/{mid}/edit").get_data(as_text=True)
        assert re.search(r'<option value="medium"\s+selected', page)
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
    assert err is None and fields["labels"] == ["Yes", "No"] and fields["b"] == 300
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
