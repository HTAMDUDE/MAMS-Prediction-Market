"""Tests for the admin controls, safeguards and polish ported from the Next.js branch."""
import os
import sqlite3
import tempfile
import sys
from datetime import datetime, timedelta

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_market import (RULES, _closed_market_with_bet, _fresh_db, _market, _post, _user, csrf, past,  # noqa: E402
                         signup, appmod)


@pytest.fixture(autouse=True)
def no_configured_owner(monkeypatch):
    monkeypatch.setattr(appmod, "OWNER_USERNAME", "")


@pytest.fixture(autouse=True)
def restore_db_path():
    old = appmod.DB_PATH
    yield
    appmod.DB_PATH = old


def _q(db, sql, *a):
    return db.execute(sql, a).fetchone()[0]


# ---------------------------------------------------------------- 1. fixes and safeguards

def test_delete_market_with_disputes_and_clarifications():
    old = appmod.DB_PATH
    try:
        db, mid, yes, no, admin, bob, eve = _closed_market_with_bet()
        _post(admin, f"/admin/markets/{mid}/propose-result", outcome_id=no)
        _post(bob, f"/market/{mid}/dispute", reason="Official page says Yes won")
        _post(admin, f"/admin/markets/{mid}/clarify", body="Clarifying how the source counts.")
        assert _q(db, "SELECT COUNT(*) FROM disputes") == 1 and _q(db, "SELECT COUNT(*) FROM clarifications") == 1
        r = _post(admin, f"/admin/markets/{mid}/delete")
        assert r.status_code == 200
        assert _q(db, "SELECT COUNT(*) FROM markets WHERE id=?", mid) == 0
        assert _q(db, "SELECT COUNT(*) FROM disputes") == 0 and _q(db, "SELECT COUNT(*) FROM clarifications") == 0
    finally:
        appmod.DB_PATH = old


def test_cancel_settles_open_disputes_and_clears_proposal():
    old = appmod.DB_PATH
    try:
        db, mid, yes, no, admin, bob, eve = _closed_market_with_bet()
        _post(admin, f"/admin/markets/{mid}/propose-result", outcome_id=no)
        _post(bob, f"/market/{mid}/dispute", reason="Official page says Yes won")
        _post(admin, f"/admin/markets/{mid}/cancel")
        m = db.execute("SELECT * FROM markets WHERE id=?", (mid,)).fetchone()
        assert m["status"] == "cancelled"
        assert m["proposed_outcome_id"] is None and m["finalizes_at"] is None
        assert _q(db, "SELECT COUNT(*) FROM disputes WHERE handled_at IS NULL") == 0
        # portfolio shows the real refund
        page = bob.get("/portfolio").get_data(as_text=True)
        assert "Refunded Ⓜ100.00" in page
    finally:
        appmod.DB_PATH = old


def test_slippage_guard_on_buy_and_sell():
    db = _fresh_db()
    a, b = _user(db, "a"), _user(db, "b")
    mid, (o0, o1) = _market(db)
    quote_shares = appmod.lmsr.shares_for_amount([0, 0], 300, 0, 50)
    appmod.execute_trade(db, b, mid, o0, "buy", 200)  # price moves after "the quote"
    with pytest.raises(appmod.TradeError, match="price moved"):
        appmod.execute_trade(db, a, mid, o0, "buy", 50, min_out=quote_shares * 0.98)
    assert _q(db, "SELECT COUNT(*) FROM trades WHERE user_id=?", a) == 0
    appmod.execute_trade(db, a, mid, o0, "buy", 50, min_out=1)  # a sane floor passes
    held = _q(db, "SELECT shares FROM positions WHERE user_id=? AND outcome_id=?", a, o0)
    stale_coins = 1000.0
    with pytest.raises(appmod.TradeError, match="price moved"):
        appmod.execute_trade(db, a, mid, o0, "sell", held, min_out=stale_coins)
    appmod.execute_trade(db, a, mid, o0, "sell", held, min_out=0)


def test_tiny_sell_is_refused_in_trade_and_quote():
    db = _fresh_db()
    a = _user(db, "a")
    mid, (o0, o1) = _market(db, b=100000)
    appmod.execute_trade(db, a, mid, o0, "buy", 1)
    held = _q(db, "SELECT shares FROM positions WHERE user_id=?", a)
    with pytest.raises(appmod.TradeError, match="less than Ⓜ0.01"):
        appmod.execute_trade(db, a, mid, o0, "sell", 0.001)
    assert held > 0
    outs = appmod.get_outcomes(db, mid)
    with pytest.raises(appmod.TradeError, match="less than Ⓜ0.01"):
        appmod.check_trade(appmod_market(db, mid), outs, 0, "sell", 0.001)


def appmod_market(db, mid):
    return db.execute("SELECT * FROM markets WHERE id=?", (mid,)).fetchone()


def test_unknown_result_decision_is_an_error():
    old = appmod.DB_PATH
    try:
        db, mid, yes, no, admin, bob, eve = _closed_market_with_bet()
        page = _post(admin, f"/admin/markets/{mid}/result-action", decision="bogus").get_data(as_text=True)
        assert "Unknown action." in page
    finally:
        appmod.DB_PATH = old


def test_min_bet_and_balance_messages():
    db = _fresh_db()
    a = _user(db, "a", balance=50)
    mid, (o0, o1) = _market(db)
    with pytest.raises(appmod.TradeError, match="Minimum bet is Ⓜ1"):
        appmod.execute_trade(db, a, mid, o0, "buy", 0.5)
    with pytest.raises(appmod.TradeError, match="Your balance is Ⓜ50.00"):
        appmod.execute_trade(db, a, mid, o0, "buy", 500)


# ---------------------------------------------------------------- 2. password tools

def _login(client, name, pw):
    return client.post("/login", data={"csrf_token": csrf(client.get("/login")), "username": name, "password": pw},
                       follow_redirects=True)


def test_change_password_and_other_sessions_are_signed_out():
    _fresh_db()
    laptop, phone = appmod.app.test_client(), appmod.app.test_client()
    signup(laptop, "dana")
    _login(phone, "dana", "secret1")
    assert phone.get("/portfolio").status_code == 200

    def change(cur, new, conf=None):
        return _post(laptop, "/account/password", current=cur, new=new, confirm=conf or new).get_data(as_text=True)

    assert "current password is wrong" in change("nope", "newsecret")
    assert "at least 6" in change("secret1", "abc")
    assert "don&#39;t match" in change("secret1", "newsecret", "different")
    assert "Password changed." in change("secret1", "newsecret")
    assert laptop.get("/portfolio").status_code == 200       # this device stays signed in
    assert phone.get("/portfolio").status_code == 302        # the other one is signed out
    assert "Wrong username" in _login(appmod.app.test_client(), "dana", "secret1").get_data(as_text=True)
    assert "Wrong username" not in _login(appmod.app.test_client(), "dana", "newsecret").get_data(as_text=True)


def test_temporary_password_signs_out_and_clears_lockout(capsys):
    db = _fresh_db()
    u = _user(db, "erin")
    for _ in range(10):
        appmod.rate_limited(("login-fail", "erin"), 10, 300)
    pw = appmod.set_temporary_password(db, u)
    assert len(pw) == 12
    assert ("login-fail", "erin") not in appmod._hits
    assert appmod.check_password_hash(db.execute("SELECT password_hash FROM users WHERE id=?", (u,)).fetchone()[0], pw)
    assert _q(db, "SELECT session_gen FROM users WHERE id=?", u) == 1
    import reset_password
    assert reset_password.main(["reset_password.py", "erin"]) == 0
    assert "Temporary password for erin:" in capsys.readouterr().out
    assert reset_password.main(["reset_password.py", "nobody"]) == 1


# ---------------------------------------------------------------- 3. audit log

def _audit(db):
    return [(r["action"], r["actor_name"], r["target_label"], r["detail"])
            for r in db.execute("SELECT * FROM audit_log ORDER BY id")]


def test_admin_actions_are_audited_and_forbidden_ones_are_not():
    old = appmod.DB_PATH
    try:
        db, mid, yes, no, admin, bob, eve = _closed_market_with_bet()
        bob_id = _q(db, "SELECT id FROM users WHERE username='bob'")
        _post(admin, f"/admin/markets/{mid}/propose-result", outcome_id=yes)
        _post(admin, f"/admin/markets/{mid}/result-action", decision="retract")
        _post(admin, f"/admin/markets/{mid}/clarify", body="A clarification about the source.")
        _post(admin, f"/admin/users/{bob_id}/grant", amount="5")
        _post(admin, f"/admin/users/{bob_id}/trading")
        _post(admin, f"/admin/users/{bob_id}/trading")
        _post(admin, f"/admin/users/{bob_id}/toggle-admin")
        log = _audit(db)
        actions = [a[0] for a in log]
        assert actions == ["result.propose", "result.retract", "market.clarify", "user.grant", "user.ban",
                           "user.unban", "user.admin_on"]
        assert log[0][1] == "chief" and log[0][2] == "Win?" and "Proposed" in log[0][3]
        assert log[3][3] == "+Ⓜ5.00"
        # a regular user hitting an admin action is refused and leaves no entry
        _post(bob, f"/admin/users/{bob_id}/grant", amount="99")
        assert len(_audit(db)) == 7
        # delete keeps the entry after the market is gone
        _post(admin, f"/admin/markets/{mid}/delete")
        assert _audit(db)[-1][0] == "market.delete" and "Status was open" in _audit(db)[-1][3]
    finally:
        appmod.DB_PATH = old


def test_admin_log_page_search_pages_and_permissions():
    old = appmod.DB_PATH
    try:
        db, mid, yes, no, admin, bob, eve = _closed_market_with_bet()
        assert bob.get("/admin/log").status_code == 403
        assert "No admin activity yet." in admin.get("/admin/log").get_data(as_text=True)
        _post(admin, f"/admin/markets/{mid}/propose-result", outcome_id=yes)
        _post(admin, f"/admin/markets/{mid}/cancel")
        page = admin.get("/admin/log").get_data(as_text=True)
        assert "Proposed a result" in page and "Cancelled a market" in page and f"/market/{mid}" in page
        assert "Cancelled a market" not in admin.get("/admin/log?q=proposed").get_data(as_text=True)
        assert "Nothing matches" in admin.get("/admin/log?q=zzzz").get_data(as_text=True)
        for i in range(55):
            db.execute("INSERT INTO audit_log (actor_name, action, target_type, created_at) "
                       "VALUES ('chief', 'user.grant', 'user', ?)", (appmod.now_str(),))
        assert "Page 1 of 2" in admin.get("/admin/log").get_data(as_text=True)
        assert "Page 2 of 2" in admin.get("/admin/log?page=2").get_data(as_text=True)
    finally:
        appmod.DB_PATH = old


def test_admin_reset_password_rules():
    old = appmod.DB_PATH
    try:
        db = _fresh_db()
        owner, helper, bob = (appmod.app.test_client() for _ in range(3))
        signup(owner, "boss")
        signup(helper, "helper")
        signup(bob, "bob")
        uid = lambda n: _q(db, "SELECT id FROM users WHERE username=?", n)
        _post(owner, f"/admin/users/{uid('helper')}/toggle-admin")
        # an admin can reset a regular user, but not the owner
        page = _post(helper, f"/admin/users/{uid('bob')}/reset-password").get_data(as_text=True)
        assert "Temporary password for bob:" in page
        assert "Only the site owner" in _post(helper, f"/admin/users/{uid('boss')}/reset-password").get_data(as_text=True)
        assert bob.get("/portfolio").status_code == 302  # bob was signed out
        assert [a[0] for a in _audit(db)].count("user.password_reset") == 1
    finally:
        appmod.DB_PATH = old


# ---------------------------------------------------------------- 4. users admin and account deletion

def _site(*names):
    """A fresh DB where the first name is the owner. Returns (db, {name: client}, uid-lookup)."""
    db = _fresh_db()
    clients = {}
    for n in names:
        clients[n] = appmod.app.test_client()
        signup(clients[n], n)
    return db, clients, (lambda n: _q(db, "SELECT id FROM users WHERE username=?", n))


def test_users_search_filter_and_paging():
    db, c, uid = _site("boss", "bob", "bobby", "carol")
    for i in range(30):
        _user(db, f"filler{i:02d}")
    page = c["boss"].get("/admin").get_data(as_text=True)
    assert "Page 1 of 2" in page and "Manage" in page
    assert "Page 2 of 2" in c["boss"].get("/admin?upage=2").get_data(as_text=True)
    found = c["boss"].get("/admin?q=bob").get_data(as_text=True)
    assert "bobby" in found and "carol" not in found
    assert "No users match." in c["boss"].get("/admin?q=zzz").get_data(as_text=True)
    _post(c["boss"], f"/admin/users/{uid('carol')}/trading")
    _post(c["boss"], f"/admin/users/{uid('bob')}/comment-mute")
    banned = c["boss"].get("/admin?filter=banned").get_data(as_text=True)
    assert "carol" in banned and "bobby" not in banned
    assert "bob</strong>" in c["boss"].get("/admin?filter=muted").get_data(as_text=True)
    admins = c["boss"].get("/admin?filter=admins").get_data(as_text=True)
    assert "boss" in admins and "carol" not in admins  # the owner counts even if the flag was never set


def test_manage_page_permissions():
    db, c, uid = _site("boss", "helper", "bob")
    _post(c["boss"], f"/admin/users/{uid('helper')}/toggle-admin")
    assert c["bob"].get(f"/admin/users/{uid('bob')}").status_code == 403
    page = c["helper"].get(f"/admin/users/{uid('boss')}").get_data(as_text=True)
    assert "Only the site owner can manage this account." in page
    assert "Delete account" in c["helper"].get(f"/admin/users/{uid('bob')}").get_data(as_text=True)
    # an admin can't mute the owner or another admin; the owner can't be muted by anyone
    assert "Only the site owner" in _post(c["helper"], f"/admin/users/{uid('boss')}/comment-mute").get_data(as_text=True)
    assert "can&#39;t be muted" in _post(c["boss"], f"/admin/users/{uid('boss')}/comment-mute").get_data(as_text=True)


def test_delete_account_refusals():
    db, c, uid = _site("boss", "helper", "bob")
    _post(c["boss"], f"/admin/users/{uid('helper')}/toggle-admin")
    say = lambda who, target: _post(c[who], f"/admin/users/{uid(target)}/delete").get_data(as_text=True)
    assert "can&#39;t delete your own account" in say("boss", "boss")
    assert "owner&#39;s account can&#39;t be deleted" in say("helper", "boss")
    assert "Remove their admin role" in say("boss", "helper")
    # an open dispute blocks deletion
    closes = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")
    mid = appmod.create_market(db, "Win?", RULES, "Events", closes, ["Yes", "No"], 100, None)
    yes, no = [o["id"] for o in appmod.get_outcomes(db, mid)]
    appmod.execute_trade(db, uid("bob"), mid, yes, "buy", 50)
    db.execute("UPDATE markets SET closes_at = ? WHERE id = ?", (past(), mid))
    _post(c["boss"], f"/admin/markets/{mid}/propose-result", outcome_id=no)
    _post(c["bob"], f"/market/{mid}/dispute", reason="The official page says Yes won")
    assert "open dispute" in say("boss", "bob")
    assert _q(db, "SELECT COUNT(*) FROM users WHERE username='bob'") == 1
    # a running market they created blocks it too
    db.execute("UPDATE disputes SET handled_at = ?", (appmod.now_str(),))
    appmod.create_market(db, "Bob's market?", RULES, "Events", closes, ["Yes", "No"], 100, uid("bob"))
    assert "still running" in say("boss", "bob")


def test_delete_account_reverses_open_bets_and_keeps_settled_payouts():
    db, c, uid = _site("boss", "alice", "bob")
    closes = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")
    open_m = appmod.create_market(db, "Open one?", RULES, "Events", closes, ["Yes", "No"], 100, None)
    done_m = appmod.create_market(db, "Done one?", RULES, "Events", closes, ["Yes", "No"], 100, None)
    oy = appmod.get_outcomes(db, open_m)[0]["id"]
    dy, dn = [o["id"] for o in appmod.get_outcomes(db, done_m)]
    price_before = appmod.lmsr.prices([o["shares"] for o in appmod.get_outcomes(db, open_m)], 100)[0]
    appmod.execute_trade(db, uid("bob"), open_m, oy, "buy", 100)
    appmod.execute_trade(db, uid("bob"), done_m, dn, "buy", 40)
    appmod.execute_trade(db, uid("alice"), done_m, dy, "buy", 60)
    db.execute("UPDATE markets SET closes_at = ? WHERE id = ?", (past(), done_m))
    appmod.propose_result(db, done_m, dy, uid("boss"))
    db.execute("UPDATE markets SET finalizes_at = ? WHERE id = ?", (past(), done_m))
    appmod.finalize_due(db)
    alice_before = _q(db, "SELECT balance FROM users WHERE username='alice'")
    db.execute("INSERT INTO comments (market_id, user_id, body, created_at) VALUES (?, ?, 'hi', ?)",
               (open_m, uid("bob"), appmod.now_str()))
    page = _post(c["boss"], f"/admin/users/{uid('bob')}/delete").get_data(as_text=True)
    assert "Deleted bob" in page and "Reversed" in page
    assert _q(db, "SELECT COUNT(*) FROM users WHERE username='bob'") == 0
    for table in ("trades", "positions", "comments", "activity"):
        assert _q(db, f"SELECT COUNT(*) FROM {table} WHERE user_id NOT IN (SELECT id FROM users)") == 0
    # bob's effect on the open market's price is gone, and nobody else's balance moved
    assert appmod.lmsr.prices([o["shares"] for o in appmod.get_outcomes(db, open_m)], 100)[0] == pytest.approx(price_before)
    assert _q(db, "SELECT balance FROM users WHERE username='alice'") == pytest.approx(alice_before)
    log = _audit(db)[-1]
    assert log[0] == "user.delete" and log[2] == "bob" and "Open bets reversed" in log[3]
    assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_delete_former_admin_who_wrote_clarifications():
    db, c, uid = _site("boss", "helper")
    _post(c["boss"], f"/admin/users/{uid('helper')}/toggle-admin")
    closes = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")
    mid = appmod.create_market(db, "Clarify?", RULES, "Events", closes, ["Yes", "No"], 100, None)
    _post(c["helper"], f"/admin/markets/{mid}/clarify", body="A note from the helper admin.")
    _post(c["boss"], f"/admin/users/{uid('helper')}/toggle-admin")  # demote first
    assert "Deleted helper" in _post(c["boss"], f"/admin/users/{uid('helper')}/delete").get_data(as_text=True)
    assert _q(db, "SELECT admin_id FROM clarifications") is None
    assert "A note from the helper admin." in c["boss"].get(f"/market/{mid}").get_data(as_text=True)


def test_migration_makes_clarification_admin_nullable_and_keeps_rows():
    path = os.path.join(tempfile.mkdtemp(), "old.db")
    old = appmod.DB_PATH
    appmod.DB_PATH = path
    try:
        raw = sqlite3.connect(path)
        raw.executescript(open(os.path.join(appmod.BASE_DIR, "schema.sql")).read())
        raw.executescript("""
            DROP TABLE clarifications;
            CREATE TABLE clarifications (id INTEGER PRIMARY KEY AUTOINCREMENT,
              market_id INTEGER NOT NULL REFERENCES markets(id), admin_id INTEGER NOT NULL REFERENCES users(id),
              body TEXT NOT NULL, created_at TEXT NOT NULL);
            CREATE INDEX idx_clarifications_market ON clarifications(market_id);
            INSERT INTO users (username, password_hash, balance, created_at) VALUES ('a', 'x', 1, 'now');
            INSERT INTO markets (question, b, closes_at, created_at) VALUES ('Q', 100, 'later', 'now');
            INSERT INTO clarifications (market_id, admin_id, body, created_at) VALUES (1, 1, 'kept', 'now');""")
        raw.close()
        appmod.init_db()
        appmod.init_db()  # repeatable
        db = appmod.connect()
        cols = {r["name"]: r["notnull"] for r in db.execute("PRAGMA table_info(clarifications)")}
        assert cols["admin_id"] == 0
        assert _q(db, "SELECT body FROM clarifications") == "kept"
        assert db.execute("SELECT 1 FROM sqlite_master WHERE name='idx_clarifications_market'").fetchone()
    finally:
        appmod.DB_PATH = old
