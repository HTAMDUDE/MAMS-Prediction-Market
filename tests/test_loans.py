"""Player-to-player loans."""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_market import _fresh_db, _post, _user, past, signup, appmod  # noqa: E402


@pytest.fixture(autouse=True)
def restore_db_path():
    old = appmod.DB_PATH
    yield
    appmod.DB_PATH = old


def bal(db, uid):
    return db.execute("SELECT balance FROM users WHERE id = ?", (uid,)).fetchone()[0]


def loan(db, lid):
    return db.execute("SELECT * FROM loans WHERE id = ?", (lid,)).fetchone()


def test_offer_borrow_and_repay():
    db = _fresh_db()
    ann, bob = _user(db, "ann"), _user(db, "bob")
    before = appmod.net_worths(db)
    lid = appmod.offer_loan(db, ann, "", 100, 10, 7)
    assert bal(db, ann) == 900                                    # held while the offer is open
    assert appmod.net_worths(db)[ann] == pytest.approx(before[ann])

    owed = appmod.accept_loan(db, lid, bob)
    assert owed == 110 and bal(db, bob) == 1100
    l = loan(db, lid)
    assert l["status"] == "active" and l["borrower_id"] == bob and l["owed"] == 110 and l["due_at"] > appmod.now_str()
    worth = appmod.net_worths(db)
    assert worth[ann] == pytest.approx(1010) and worth[bob] == pytest.approx(990)  # interest counts right away
    assert worth[ann] + worth[bob] == pytest.approx(before[ann] + before[bob])     # zero-sum

    assert appmod.repay_loan(db, lid, bob, 40) == 40
    assert loan(db, lid)["owed"] == 70 and bal(db, ann) == 940
    assert appmod.repay_loan(db, lid, bob) == 70                   # None = the rest
    l = loan(db, lid)
    assert l["status"] == "repaid" and l["owed"] == 0 and l["repaid"] == 110
    assert bal(db, ann) == 1010 and bal(db, bob) == 990
    with pytest.raises(appmod.TradeError):
        appmod.repay_loan(db, lid, bob)
    kinds = [r[0] for r in db.execute("SELECT kind FROM activity WHERE user_id IN (?, ?)", (ann, bob))]
    assert kinds.count("loan") == 6  # offer, borrow, and each repayment on both sides


def test_repaying_more_than_owed_only_takes_what_is_owed():
    db = _fresh_db()
    ann, bob = _user(db, "ann"), _user(db, "bob")
    lid = appmod.offer_loan(db, ann, "bob", 50, 0, 3)
    appmod.accept_loan(db, lid, bob)
    assert appmod.repay_loan(db, lid, bob, 500) == 50
    assert loan(db, lid)["status"] == "repaid" and bal(db, bob) == 1000


def test_offer_rules():
    db = _fresh_db()
    ann, bob, cat = _user(db, "ann", balance=200), _user(db, "bob"), _user(db, "cat")
    for args, msg in [((0.5, 10, 7), "at least"), ((300, 10, 7), "only have"), ((50, -1, 7), "between"),
                      ((50, 101, 7), "between"), ((50, 10, 0), "1 to"), ((50, 10, 31), "1 to"),
                      ((float("nan"), 10, 7), "at least")]:
        with pytest.raises(appmod.TradeError, match=msg):
            appmod.offer_loan(db, ann, "", *args)
    with pytest.raises(appmod.TradeError, match="yourself"):
        appmod.offer_loan(db, ann, "ann", 50, 10, 7)
    with pytest.raises(appmod.TradeError, match="no player"):
        appmod.offer_loan(db, ann, "nobody", 50, 10, 7)
    assert bal(db, ann) == 200 and db.execute("SELECT COUNT(*) FROM loans").fetchone()[0] == 0

    lid = appmod.offer_loan(db, ann, "bob", 50, 10, 7)
    with pytest.raises(appmod.TradeError, match="someone else"):
        appmod.accept_loan(db, lid, cat)
    with pytest.raises(appmod.TradeError, match="your own"):
        appmod.accept_loan(db, lid, ann)
    with pytest.raises(appmod.TradeError):
        appmod.end_loan_offer(db, lid, cat, "declined")          # only bob can decline
    appmod.end_loan_offer(db, lid, bob, "declined")
    assert loan(db, lid)["status"] == "declined" and bal(db, ann) == 200
    with pytest.raises(appmod.TradeError, match="isn't available"):
        appmod.accept_loan(db, lid, bob)

    lid = appmod.offer_loan(db, ann, "", 50, 10, 7)
    with pytest.raises(appmod.TradeError):
        appmod.end_loan_offer(db, lid, bob, "cancelled")         # only the lender can withdraw
    appmod.end_loan_offer(db, lid, ann, "cancelled")
    assert loan(db, lid)["status"] == "cancelled" and bal(db, ann) == 200


def test_overdue_loans_are_collected_from_cash_including_later_money():
    db = _fresh_db()
    ann, bob = _user(db, "ann"), _user(db, "bob", balance=0)
    lid = appmod.offer_loan(db, ann, "bob", 100, 20, 7)
    appmod.accept_loan(db, lid, bob)                               # bob: 100 cash, owes 120
    db.execute("UPDATE users SET balance = 30 WHERE id = ?", (bob,))  # spent most of it
    appmod.collect_overdue_loans(db)
    assert loan(db, lid)["owed"] == 120                            # not due yet: nothing taken

    db.execute("UPDATE loans SET due_at = ? WHERE id = ?", (past(), lid))
    assert appmod.has_overdue_loan(db, bob)
    appmod.collect_overdue_loans(db)
    # 120 owed + 12 late fee, minus the 30 taken
    assert bal(db, bob) == 0 and loan(db, lid)["owed"] == 102 and bal(db, ann) == 930

    other = appmod.offer_loan(db, ann, "", 10, 0, 1)
    with pytest.raises(appmod.TradeError, match="overdue"):
        appmod.accept_loan(db, other, bob)

    db.execute("UPDATE users SET balance = 200 WHERE id = ?", (bob,))  # e.g. a payout later
    appmod.collect_overdue_loans(db)
    assert loan(db, lid)["status"] == "repaid" and bal(db, bob) == 98 and bal(db, ann) == 1022  # 1000 - 100 lent - 10 held in an offer + 132
    assert not appmod.has_overdue_loan(db, bob)
    detail = db.execute("SELECT detail FROM activity WHERE user_id = ? ORDER BY id DESC LIMIT 1", (bob,)).fetchone()[0]
    assert "Overdue loan collected" in detail and "paid off" in detail


def test_overdue_collection_runs_on_page_loads():
    db = _fresh_db()
    client = appmod.app.test_client()
    signup(client, "bob")
    bob = db.execute("SELECT id FROM users WHERE username = 'bob'").fetchone()[0]
    ann = _user(db, "ann")
    lid = appmod.offer_loan(db, ann, "bob", 100, 10, 7)
    appmod.accept_loan(db, lid, bob)
    db.execute("UPDATE loans SET due_at = ? WHERE id = ?", (past(), lid))
    client.get("/leaderboard")
    assert loan(db, lid)["status"] == "repaid"


def test_loans_page_and_routes():
    db = _fresh_db()
    ann_c, bob_c = appmod.app.test_client(), appmod.app.test_client()
    signup(ann_c, "ann")
    signup(bob_c, "bob")
    ann, bob = (db.execute("SELECT id FROM users WHERE username = ?", (n,)).fetchone()[0] for n in ("ann", "bob"))
    page = _post(ann_c, "/loans/offer", amount="100", rate="12.5", days="5", borrower="bob", note="good luck")
    html = page.get_data(as_text=True)
    assert "Offer posted" in html and "waiting to be taken" in html
    lid = db.execute("SELECT id FROM loans").fetchone()[0]

    html = bob_c.get("/loans").get_data(as_text=True)
    assert "just for you" in html and "good luck" in html and "Ⓜ112.50" in html
    assert 'class="badge"' in html                                  # nav badge for the offer
    assert "Loan taken" in _post(bob_c, f"/loans/{lid}/accept").get_data(as_text=True)
    html = bob_c.get("/loans").get_data(as_text=True)
    assert "Loans you&#39;re paying back" in html or "Loans you're paying back" in html
    assert "you owe Ⓜ112.50" in bob_c.get("/portfolio").get_data(as_text=True)
    assert "Paid back Ⓜ12.50" in _post(bob_c, f"/loans/{lid}/repay", amount="12.50").get_data(as_text=True)
    assert "Paid back Ⓜ100.00" in _post(bob_c, f"/loans/{lid}/repay", amount="").get_data(as_text=True)
    assert bal(db, ann) == pytest.approx(1012.5)
    assert "Loan" in ann_c.get("/activity/mine?show=other").get_data(as_text=True)

    assert "Fill in" in _post(ann_c, "/loans/offer", amount="lots", rate="1", days="1").get_data(as_text=True)
    assert appmod.app.test_client().get("/loans").status_code == 302   # logged out


def test_account_with_running_loan_cannot_be_deleted_and_offers_are_refunded():
    db = _fresh_db()
    ann, bob, cat = _user(db, "ann"), _user(db, "bob"), _user(db, "cat")
    lid = appmod.offer_loan(db, ann, "bob", 100, 10, 7)
    appmod.accept_loan(db, lid, bob)
    with pytest.raises(appmod.TradeError, match="loan"):
        appmod.delete_account(db, bob)
    appmod.repay_loan(db, lid, bob)
    pending = appmod.offer_loan(db, ann, "cat", 50, 10, 7)
    appmod.delete_account(db, cat)                                  # offer to cat goes back to ann
    assert bal(db, ann) == 1010 and loan(db, pending) is None
    appmod.delete_account(db, bob)
    assert db.execute("SELECT COUNT(*) FROM loans").fetchone()[0] == 0


# ---------------------------------------------------------------- credit scores and defaults

def score(db, uid):
    return db.execute("SELECT credit_score FROM users WHERE id = ?", (uid,)).fetchone()[0]


def test_on_time_repayment_raises_credit_by_loan_size():
    db = _fresh_db()
    ann, bob = _user(db, "ann"), _user(db, "bob")
    assert score(db, bob) == appmod.CREDIT_START == 600
    lid = appmod.offer_loan(db, ann, "", 80, 10, 7)
    appmod.accept_loan(db, lid, bob)
    appmod.repay_loan(db, lid, bob, 40)
    assert score(db, bob) == 600                      # nothing until it's paid off
    appmod.repay_loan(db, lid, bob)
    assert score(db, bob) == 608                      # +1 per Ⓜ10
    big = appmod.offer_loan(db, ann, "", 400, 0, 7)
    appmod.accept_loan(db, big, bob)
    appmod.repay_loan(db, big, bob)
    assert score(db, bob) == 623                      # capped at +15
    tiny = appmod.offer_loan(db, ann, "", 5, 0, 7)
    appmod.accept_loan(db, tiny, bob)
    appmod.repay_loan(db, tiny, bob)
    assert score(db, bob) == 623                      # tiny loans can't farm credit
    reasons = [r[0] for r in db.execute("SELECT reason FROM credit_events WHERE user_id = ? ORDER BY id", (bob,))]
    assert len(reasons) == 2 and "on time" in reasons[0]


def test_late_then_default_then_paid_off():
    db = _fresh_db()
    ann, bob = _user(db, "ann"), _user(db, "bob", balance=0)
    lid = appmod.offer_loan(db, ann, "bob", 100, 10, 7)
    appmod.accept_loan(db, lid, bob)
    db.execute("UPDATE users SET balance = 0 WHERE id = ?", (bob,))    # spent it all
    db.execute("UPDATE loans SET due_at = ? WHERE id = ?", (past(), lid))
    appmod.process_loan_deadlines(db)
    l = loan(db, lid)
    assert l["late_at"] and l["penalty"] == 11 and l["owed"] == 121 and not l["defaulted_at"]
    assert score(db, bob) == 560
    appmod.process_loan_deadlines(db)                                  # only once
    assert loan(db, lid)["owed"] == 121 and score(db, bob) == 560

    db.execute("UPDATE loans SET due_at = ? WHERE id = ?", (past(24 * 8), lid))
    appmod.process_loan_deadlines(db)
    assert loan(db, lid)["defaulted_at"] and score(db, bob) == 460
    assert appmod.has_defaulted_loan(db, bob)
    # punishments: can't borrow or lend, shown on the leaderboard
    other = appmod.offer_loan(db, ann, "", 10, 0, 1)
    with pytest.raises(appmod.TradeError, match="defaulted"):
        appmod.accept_loan(db, other, bob)
    db.execute("UPDATE users SET balance = 50 WHERE id = ?", (bob,))
    with pytest.raises(appmod.TradeError, match="defaulted"):
        appmod.offer_loan(db, bob, "", 10, 0, 1)
    appmod.process_loan_deadlines(db)                                   # the 50 is collected
    assert bal(db, bob) == 0 and loan(db, lid)["owed"] == 71

    db.execute("UPDATE users SET balance = 100 WHERE id = ?", (bob,))
    appmod.process_loan_deadlines(db)
    assert loan(db, lid)["status"] == "repaid" and bal(db, bob) == 29
    assert score(db, bob) == 480 and not appmod.has_defaulted_loan(db, bob)
    assert bal(db, ann) == 1000 - 100 - 10 + 121                         # lender got the late fee too


def test_late_but_paid_before_default_earns_a_little_back():
    db = _fresh_db()
    ann, bob = _user(db, "ann"), _user(db, "bob")
    lid = appmod.offer_loan(db, ann, "bob", 100, 0, 7)
    appmod.accept_loan(db, lid, bob)
    db.execute("UPDATE users SET balance = 0 WHERE id = ?", (bob,))
    db.execute("UPDATE loans SET due_at = ? WHERE id = ?", (past(), lid))
    appmod.process_loan_deadlines(db)
    db.execute("UPDATE users SET balance = 500 WHERE id = ?", (bob,))
    appmod.process_loan_deadlines(db)
    assert loan(db, lid)["status"] == "repaid" and score(db, bob) == 600 - 40 + 5


def test_credit_limits_and_minimum_scores():
    db = _fresh_db()
    ann, bob = _user(db, "ann", balance=10000), _user(db, "bob")
    # Fair (600): can owe up to Ⓜ500 in total, interest included
    lid = appmod.offer_loan(db, ann, "", 460, 10, 7)
    with pytest.raises(appmod.TradeError, match="at most Ⓜ500"):
        appmod.accept_loan(db, lid, bob)                                # 506 owed
    ok = appmod.offer_loan(db, ann, "", 300, 0, 7)
    appmod.accept_loan(db, ok, bob)
    more = appmod.offer_loan(db, ann, "", 250, 0, 7)
    with pytest.raises(appmod.TradeError, match="already owe"):
        appmod.accept_loan(db, more, bob)
    # lender asks for 650+
    picky = appmod.offer_loan(db, ann, "", 10, 0, 7, min_credit=650)
    with pytest.raises(appmod.TradeError, match="at least 650"):
        appmod.accept_loan(db, picky, bob)
    with pytest.raises(appmod.TradeError, match="between"):
        appmod.offer_loan(db, ann, "", 10, 0, 7, min_credit=900)
    # Bad credit: no borrowing at all
    db.execute("UPDATE users SET credit_score = 400 WHERE id = ?", (bob,))
    small = appmod.offer_loan(db, ann, "", 5, 0, 7)
    with pytest.raises(appmod.TradeError, match="too low"):
        appmod.accept_loan(db, small, bob)
    # never below 300 or above 850
    with appmod.app.app_context():
        appmod.adjust_credit(db, bob, -1000, "test")
        assert score(db, bob) == 300
        appmod.adjust_credit(db, bob, 5000, "test")
        assert score(db, bob) == 850


def test_credit_shows_on_loans_page_and_leaderboard():
    db = _fresh_db()
    c = appmod.app.test_client()
    signup(c, "bob")
    bob = db.execute("SELECT id FROM users WHERE username = 'bob'").fetchone()[0]
    ann = _user(db, "ann")
    html = c.get("/loans").get_data(as_text=True)
    assert "Credit score" in html and ">600<" in html and "Fair" in html
    lid = appmod.offer_loan(db, ann, "bob", 100, 0, 7)
    appmod.accept_loan(db, lid, bob)
    db.execute("UPDATE users SET balance = 0 WHERE id = ?", (bob,))
    db.execute("UPDATE loans SET due_at = ? WHERE id = ?", (past(24 * 8), lid))
    html = c.get("/loans").get_data(as_text=True)                      # the request runs the deadlines
    assert "defaulted on a loan" in html and "Defaulted on a loan from ann" in html and "late fee" in html
    board = c.get("/leaderboard").get_data(as_text=True)
    assert "defaulted</span>" in board and ">460<" in board
    page = _post(c, "/loans/offer", amount="10", rate="0", days="3", min_credit="700")
    assert "defaulted loan" in page.get_data(as_text=True)
