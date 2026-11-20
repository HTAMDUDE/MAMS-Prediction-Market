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

    # admin resolves Yes -> bob paid 1 per share
    tok = csrf(admin.get(f"/market/{mid}"))
    admin.post(f"/admin/markets/{mid}/resolve", data={"csrf_token": tok, "outcome_id": yes})
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
            return sam.post("/propose", data={"csrf_token": tok, "question": question, "description": "why",
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
            "description": "why", "outcomes": "Yes\nNo", "category": "Events", "closes_at": closes,
            "liquidity": "high", "review_note": "Clarified wording"}, follow_redirects=True)
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
