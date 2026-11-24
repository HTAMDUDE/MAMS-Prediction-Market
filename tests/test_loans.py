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
    assert bal(db, bob) == 0 and loan(db, lid)["owed"] == 90 and bal(db, ann) == 930

    other = appmod.offer_loan(db, ann, "", 10, 0, 1)
    with pytest.raises(appmod.TradeError, match="overdue"):
        appmod.accept_loan(db, other, bob)

    db.execute("UPDATE users SET balance = 200 WHERE id = ?", (bob,))  # e.g. a payout later
    appmod.collect_overdue_loans(db)
    assert loan(db, lid)["status"] == "repaid" and bal(db, bob) == 110 and bal(db, ann) == 1010
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
