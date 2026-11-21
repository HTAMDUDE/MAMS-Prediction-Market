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
