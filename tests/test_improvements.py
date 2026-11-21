"""Tests for the admin controls, safeguards and polish ported from the Next.js branch."""
import os
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
