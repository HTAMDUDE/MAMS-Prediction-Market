"""Credit scores: the model, borrowing limits, offer filters, the directory and the admin tools."""
import json
import os
import sys
from datetime import datetime, timedelta

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_market import _fresh_db as _raw_db, _post, _user, signup, appmod  # noqa: E402
import credit  # noqa: E402


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    old = appmod.DB_PATH
    monkeypatch.setattr(appmod, "OWNER_USERNAME", "")
    yield
    appmod.DB_PATH = old


def _fresh_db():
    """A fresh database whose first account (the owner, who isn't scored) already exists."""
    db = _raw_db()
    _user(db, "owner")
    return db


def ago(days):
    return (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")


def make_loan(db, lender, borrower, status="repaid", principal=100, started=30, term=7, closed_after=None):
    """A loan taken `started` days ago for `term` days. A repaid loan closed `closed_after` days after it was taken
    (default: on the due date). An 'active' one is still running (overdue if started > term)."""
    due = datetime.now() - timedelta(days=started) + timedelta(days=term)
    closed = (datetime.now() - timedelta(days=started) + timedelta(days=closed_after if closed_after is not None else term))
    fmt = "%Y-%m-%d %H:%M:%S"
    return db.execute(
        "INSERT INTO loans (lender_id, borrower_id, principal, rate, days, status, owed, repaid, due_at, created_at, "
        "accepted_at, closed_at) VALUES (?, ?, ?, 10, ?, ?, ?, ?, ?, ?, ?, ?)",
        (lender, borrower, principal, term, status, principal * 1.1 if status == "active" else 0,
         principal * 1.1 if status == "repaid" else 0, due.strftime(fmt), ago(started), ago(started),
         closed.strftime(fmt) if status in ("repaid", "forgiven") else None)).lastrowid


def score(db, uid):
    return appmod.apply_credit(db, uid, "test")


def test_new_player_is_a_thin_file_in_the_middle_band():
    db = _fresh_db()
    ann = _user(db, "ann")
    c = score(db, ann)
    assert c["thin"] and 580 <= c["score"] <= 680
    assert appmod.credit_limit(db, ann)[0] == 500.0          # a new player keeps the old floor


def test_repaying_on_time_raises_the_score_and_late_and_default_cost_more():
    db = _fresh_db()
    lenders = [_user(db, f"l{i}") for i in range(3)]
    good, late, bad = _user(db, "good"), _user(db, "late"), _user(db, "bad")
    base = score(db, good)["score"]
    for l in lenders:
        make_loan(db, l, good, started=40)
        make_loan(db, l, late, started=40, closed_after=7 + 6)       # six days late
    make_loan(db, lenders[0], bad, status="active", started=40)       # 33 days overdue: in default
    s_good, s_late, s_bad = (score(db, u)["score"] for u in (good, late, bad))
    assert s_good > base and s_good > s_late > s_bad
    assert s_good >= 680 and s_bad <= 450                              # a default caps the score


def test_overdue_inside_the_grace_period_is_capped_below_good():
    db = _fresh_db()
    ann, bob = _user(db, "ann"), _user(db, "bob")
    for _ in range(3):
        make_loan(db, ann, bob, started=30)
    assert score(db, bob)["score"] >= 680
    make_loan(db, ann, bob, status="active", started=8, term=7)       # due a day ago, inside the 2-day grace
    c = score(db, bob)
    assert c["score"] <= 560 and any("overdue" in t for t in c["caps"])


def test_old_defaults_count_for_less_than_recent_ones():
    db = _fresh_db()
    ann, recent, old = _user(db, "ann"), _user(db, "recent"), _user(db, "old")
    make_loan(db, ann, recent, status="forgiven", started=12)
    make_loan(db, ann, old, status="forgiven", started=400)
    assert score(db, old)["score"] > score(db, recent)["score"]


def test_repaying_a_linked_account_counts_for_little():
    db = _fresh_db()
    friend, stranger, a, b = _user(db, "friend"), _user(db, "stranger"), _user(db, "a"), _user(db, "b")
    for _ in range(4):
        make_loan(db, friend, a, started=30)
        make_loan(db, stranger, b, started=30)
    db.execute("INSERT INTO user_risk (user_id, links, updated_at) VALUES (?, ?, 0)",
               (a, json.dumps({str(friend): {"username": "friend", "why": ["device"]}})))
    exp = lambda c: next(f for f in c["factors"] if f["key"] == "experience")["value"]
    assert exp(score(db, a)) < exp(score(db, b))


def test_risk_penalty_and_a_hold_cap_the_score():
    db = _fresh_db()
    ann, bob = _user(db, "ann"), _user(db, "bob")
    for _ in range(3):
        make_loan(db, ann, bob, started=30)
    clean = score(db, bob)["score"]
    db.execute("INSERT INTO user_risk (user_id, score, status, updated_at) VALUES (?, 70, 'held', 0)", (bob,))
    held = score(db, bob)
    assert held["score"] <= 500 < clean


def test_the_multiplier_scales_the_limit_and_an_override_wins():
    db = _fresh_db()
    ann, bob = _user(db, "ann"), _user(db, "bob", balance=10000)
    for _ in range(4):
        make_loan(db, ann, bob, started=40)
    c = score(db, bob)
    detail = appmod.credit_limit_detail(db, bob)
    assert c["multiplier"] > 1 and detail["limit"] == pytest.approx(0.5 * 10000 * c["multiplier"])
    db.execute("UPDATE user_credit SET limit_override = 123 WHERE user_id = ?", (bob,))
    assert appmod.credit_limit(db, bob)[0] == 123


def test_a_poor_score_shrinks_the_floor():
    db = _fresh_db()
    ann, bob = _user(db, "ann"), _user(db, "bob")
    make_loan(db, ann, bob, status="active", started=60)
    c = score(db, bob)
    assert c["multiplier"] < 0.75 and appmod.credit_limit(db, bob)[0] < 500


def test_min_score_on_an_offer_and_frozen_borrowers():
    db = _fresh_db()
    ann, bob, cy = _user(db, "ann"), _user(db, "bob"), _user(db, "cy")
    for _ in range(4):
        make_loan(db, ann, cy, started=40)
    score(db, cy)
    picky = appmod.offer_loan(db, ann, "", 50, 5, 7, min_score=700)
    with pytest.raises(appmod.TradeError, match="needs a credit score of 700; yours is"):
        appmod.accept_loan(db, picky, bob)
    assert appmod.accept_loan(db, picky, cy) == 52.5
    with pytest.raises(appmod.TradeError, match="between 300 and 850"):
        appmod.offer_loan(db, ann, "", 10, 0, 7, min_score=900)
    score(db, bob)
    db.execute("UPDATE user_credit SET frozen = 1 WHERE user_id = ?", (bob,))
    with pytest.raises(appmod.TradeError, match="paused on your account"):
        appmod.accept_loan(db, appmod.offer_loan(db, ann, "", 10, 0, 7), bob)


def test_repaying_and_taking_a_loan_move_the_stored_score(monkeypatch):
    db = _fresh_db()
    ann, bob = _user(db, "ann"), _user(db, "bob")
    thin = score(db, bob)
    assert thin["thin"] and thin["ontime"] == 0
    lid = appmod.offer_loan(db, ann, "", 100, 0, 7)
    appmod.accept_loan(db, lid, bob)
    appmod.repay_loan(db, lid, bob)
    appmod.rescore_credit(db, bob, ann, reason="loan repayment")       # what the repay route does afterwards
    c = db.execute("SELECT * FROM user_credit WHERE user_id = ?", (bob,)).fetchone()
    assert c["ontime"] == 1 and not c["thin"]
    assert db.execute("SELECT COUNT(*) FROM credit_history WHERE user_id = ?", (bob,)).fetchone()[0] >= 1


def test_config_validation():
    cfg = credit.merged_config("")
    assert credit.validate_config(cfg) == []
    cfg["weights"]["payment"] = 0.9
    assert any("100%" in e for e in credit.validate_config(cfg))
    cfg = credit.merged_config(json.dumps({"tiers": [["A", 500], ["B", 600]]}))
    assert any("high to low" in e for e in credit.validate_config(cfg))
    assert credit.merged_config("not json") == credit.merged_config("")


def test_admins_are_not_scored():
    db = _fresh_db()
    admin = _user(db, "boss")
    db.execute("UPDATE users SET is_admin = 1 WHERE id = ?", (admin,))
    assert appmod.apply_credit(db, admin) is None and appmod.get_credit(db, admin) is None
    assert appmod.credit_limit(db, admin)[0] == 500.0


def pages():
    db = _raw_db()                                       # headadmin signs up first, so is the owner
    admin, ann_c, bob_c = (appmod.app.test_client() for _ in range(3))
    signup(admin, "headadmin")
    signup(ann_c, "ann")
    signup(bob_c, "bob")
    ids = {n: db.execute("SELECT id FROM users WHERE username = ?", (n,)).fetchone()[0] for n in ("headadmin", "ann", "bob")}
    return db, admin, ann_c, bob_c, ids


def test_player_pages_render_and_hide_the_breakdown_from_lenders():
    db, admin, ann_c, bob_c, ids = pages()
    for _ in range(2):
        make_loan(db, ids["ann"], ids["bob"], started=30)
    mine = bob_c.get("/credit").get_data(as_text=True)
    assert "Your credit score" in mine and "What goes into it" in mine and "Payment history" in mine
    theirs = ann_c.get("/credit/bob").get_data(as_text=True)
    assert "bob&#39;s credit score" in theirs and "What goes into it" not in theirs and "Offer a loan" in theirs
    assert "What goes into it" in admin.get("/credit/bob").get_data(as_text=True)
    assert ann_c.get("/credit/headadmin").status_code == 404           # admins aren't scored
    assert ann_c.get("/credit/nobody").status_code == 404
    assert "aren't scored" in admin.get("/credit").get_data(as_text=True)
    loans_page = ann_c.get("/loans?to=bob").get_data(as_text=True)
    assert 'value="bob"' in loans_page and "Minimum credit tier" in loans_page and "Browse borrowers" in loans_page


def test_offer_form_sets_a_minimum_and_the_borrower_sees_it_disabled():
    db, admin, ann_c, bob_c, ids = pages()
    _post(ann_c, "/loans/offer", amount="50", rate="5", days="7", borrower="", min_tier="excellent")
    row = db.execute("SELECT * FROM loans WHERE lender_id = ?", (ids["ann"],)).fetchone()
    assert row["min_score"] == 760
    html = bob_c.get("/loans").get_data(as_text=True)
    assert "Needs 760+" in html and "can't take this one yet" in html and "disabled" in html
    assert "whole number" in _post(ann_c, "/loans/offer", amount="5", rate="5", days="7", min_score="abc").get_data(as_text=True)
    _post(ann_c, "/loans/offer", amount="5", rate="5", days="7", min_score="650")        # a typed number wins over the tier
    assert db.execute("SELECT min_score FROM loans WHERE lender_id = ? ORDER BY id DESC", (ids["ann"],)).fetchone()[0] == 650


def test_borrower_directory_filters_and_sorts():
    db, admin, ann_c, bob_c, ids = pages()
    cy, dee = _user(db, "cy"), _user(db, "dee")
    for _ in range(4):
        make_loan(db, ids["ann"], cy, started=40)
    make_loan(db, ids["ann"], dee, status="active", started=60)
    db.execute("UPDATE users SET balance = 0 WHERE id = ?", (dee,))         # or the first request collects the debt
    page = ann_c.get("/loans/borrowers").get_data(as_text=True)
    assert "cy" in page and "dee" in page and "bob" in page and "headadmin" not in page
    assert "/credit/ann" not in page and "/credit/cy" in page             # you're not listed in your own directory
    assert "dee" not in ann_c.get("/loans/borrowers?min=600").get_data(as_text=True)
    only_clean = ann_c.get("/loans/borrowers?clean=1&repaid=1").get_data(as_text=True)
    assert "cy" in only_clean and "dee" not in only_clean and "bob" not in only_clean
    assert "/credit/dee" in ann_c.get("/loans/borrowers?max=599").get_data(as_text=True)
    first = ann_c.get("/loans/borrowers?sort=score").get_data(as_text=True)
    assert first.index("/credit/cy") < first.index("/credit/dee")


def test_admin_credit_console_and_user_actions():
    db, admin, ann_c, bob_c, ids = pages()
    make_loan(db, ids["ann"], ids["bob"], status="active", started=60)
    db.execute("UPDATE users SET balance = 0 WHERE id = ?", (ids["bob"],))   # or the first request collects the debt
    assert ann_c.get("/admin/credit").status_code == 403
    assert _post(ann_c, f"/admin/users/{ids['bob']}/credit/freeze", freeze="1").status_code == 403
    html = admin.get("/admin/credit").get_data(as_text=True)
    assert "Scoring model" in html and "Default rate" in html and "bob" in html
    assert "bob" in admin.get("/admin/credit?flag=default").get_data(as_text=True)
    assert "ann" not in admin.get("/admin/credit?flag=default").get_data(as_text=True).split('id="players"')[1].split("<tbody>")[1]

    page = admin.get(f"/admin/users/{ids['bob']}").get_data(as_text=True)
    assert 'id="credit"' in page and "Freeze borrowing" in page

    before = appmod.get_credit(db, ids["bob"])["score"]
    _post(admin, f"/admin/users/{ids['bob']}/credit/adjust", points="40", reason="")
    assert appmod.get_credit(db, ids["bob"])["adjust"] == 0              # a reason is required
    _post(admin, f"/admin/users/{ids['bob']}/credit/adjust", points="500", reason="too much")
    assert appmod.get_credit(db, ids["bob"])["adjust"] == 0              # out of range
    _post(admin, f"/admin/users/{ids['bob']}/credit/adjust", points="40", reason="vouched for")
    c = appmod.get_credit(db, ids["bob"])
    assert c["adjust"] == 40 and c["score"] == min(before + 40, 850)     # applied after the caps
    _post(admin, f"/admin/users/{ids['bob']}/credit/freeze", freeze="1", reason="suspicious")
    assert appmod.get_credit(db, ids["bob"])["frozen"] == 1
    _post(admin, f"/admin/users/{ids['bob']}/credit/limit", limit="77")
    assert appmod.credit_limit(db, ids["bob"])[0] == 77
    _post(admin, f"/admin/users/{ids['bob']}/credit/limit", limit="")
    assert appmod.get_credit(db, ids["bob"])["limit_override"] is None
    _post(admin, f"/admin/users/{ids['bob']}/credit/freeze", freeze="0")
    assert appmod.get_credit(db, ids["bob"])["frozen"] == 0
    actions = [r[0] for r in db.execute("SELECT action FROM audit_log ORDER BY id")]
    assert actions == ["credit.adjust", "credit.freeze", "credit.limit", "credit.limit", "credit.unfreeze"]
    assert "your own account" in _post(admin, f"/admin/users/{ids['headadmin']}/credit/freeze", freeze="1").get_data(as_text=True)


def test_owner_edits_the_model_with_preview_validation_and_reset():
    db, admin, ann_c, bob_c, ids = pages()
    make_loan(db, ids["ann"], ids["bob"], status="active", started=60)
    db.execute("UPDATE users SET balance = 0 WHERE id = ?", (ids["bob"],))
    base = {f"w_{k}": str(round(v * 100)) for k, v in credit.DEFAULTS["weights"].items()}
    tiers = {f"t_{i}": str(f) for i, (_, f) in enumerate(credit.DEFAULTS["tiers"])}
    mults = {}
    for i, (x, y) in enumerate(credit.DEFAULTS["multiplier"]):
        mults[f"mx_{i}"], mults[f"my_{i}"] = str(x), str(y)
    extra = {"default_cap": "450", "overdue_cap": "560", "held_cap": "500", "half_life": "90"}
    form = {**base, **tiers, **mults, **extra}

    html = _post(admin, "/admin/credit/config", action="preview", **{**form, "w_payment": "60"}).get_data(as_text=True)
    assert "add up to 100%" in html and not db.execute("SELECT 1 FROM site_settings WHERE key = 'credit_cfg'").fetchone()
    shifted = {**form, "w_payment": "45", "w_velocity": "0"}
    html = _post(admin, "/admin/credit/config", action="preview", **shifted).get_data(as_text=True)
    assert "would change score" in html and not db.execute("SELECT 1 FROM site_settings WHERE key = 'credit_cfg'").fetchone()
    _post(admin, "/admin/credit/config", action="save", **shifted)
    assert json.loads(appmod.get_setting(db, "credit_cfg"))["weights"]["payment"] == 0.45
    assert appmod.credit_config(db)["weights"]["velocity"] == 0
    _post(admin, "/admin/credit/config", action="reset")
    assert appmod.credit_config(db)["weights"]["payment"] == 0.35
    assert ann_c.post("/admin/credit/config", data={"action": "save"}).status_code in (302, 400, 403)
    actions = [r[0] for r in db.execute("SELECT action FROM audit_log ORDER BY id")]
    assert actions == ["credit.config", "credit.config"]
    _post(admin, "/admin/credit/recompute")
    assert db.execute("SELECT action FROM audit_log ORDER BY id DESC").fetchone()[0] == "credit.recompute"


def test_a_second_admin_can_view_but_not_change_the_model():
    db, admin, ann_c, bob_c, ids = pages()
    mod = appmod.app.test_client()
    signup(mod, "mod")
    db.execute("UPDATE users SET is_admin = 1 WHERE username = 'mod'")
    html = mod.get("/admin/credit").get_data(as_text=True)
    assert "Only the owner can change these" in html
    out = _post(mod, "/admin/credit/config", action="reset").get_data(as_text=True)
    assert "Only the owner can change the scoring model" in out


def test_a_loan_that_goes_overdue_after_scoring_shows_up_in_the_filters():
    db, admin, ann_c, bob_c, ids = pages()
    cy = _user(db, "cy")
    for _ in range(4):
        make_loan(db, ids["ann"], cy, started=40)
    lid = make_loan(db, ids["ann"], cy, status="active", started=3, term=7)   # running and not due yet
    db.execute("UPDATE users SET balance = 0 WHERE id = ?", (cy,))
    assert appmod.refresh_credit(db) >= 1                                       # scores everyone, cy as fine
    assert appmod.get_credit(db, cy)["defaulted"] == 0 and appmod.get_credit(db, cy)["score"] >= 660
    assert "/credit/cy" in ann_c.get("/loans/borrowers?min=660").get_data(as_text=True)
    # time passes: the loan falls due and the grace period runs out, with no cash for anything to collect
    db.execute("UPDATE user_credit SET updated_at = ?", (ago(10),))            # that score is ten days old now
    db.execute("UPDATE loans SET due_at = ? WHERE id = ?", (ago(5), lid))
    assert "/credit/cy" not in ann_c.get("/loans/borrowers?min=660").get_data(as_text=True)
    assert appmod.get_credit(db, cy, max_age=10 ** 6)["defaulted"] == 1 and appmod.get_credit(db, cy, max_age=10 ** 6)["score"] <= 450
    assert "cy" in admin.get("/admin/credit?flag=default").get_data(as_text=True).split('id="players"')[1]
    assert "1 / 1" in admin.get("/admin/credit").get_data(as_text=True) or "1 / 0" in admin.get("/admin/credit").get_data(as_text=True)


def test_alt_risk_details_never_reach_a_player_and_an_approved_account_has_no_penalty():
    db, admin, ann_c, bob_c, ids = pages()
    for _ in range(3):
        make_loan(db, ids["ann"], ids["bob"], started=30)
    db.execute("INSERT INTO user_risk (user_id, score, status, updated_at) VALUES (?, 70, 'held', 0)", (ids["bob"],))
    appmod.apply_credit(db, ids["bob"], "test")
    mine = bob_c.get("/credit").get_data(as_text=True)
    assert "linked to other accounts" not in mine and "held for review" not in mine and "Some account checks also apply" in mine
    assert "linked to other accounts" in admin.get("/credit/bob").get_data(as_text=True)
    held = appmod.get_credit(db, ids["bob"])["score"]
    db.execute("UPDATE user_risk SET status = 'approved' WHERE user_id = ?", (ids["bob"],))
    assert score(db, ids["bob"])["score"] > held                                 # approved: no cap, no penalty
    assert not any("linked" in t for _, t in appmod.get_credit(db, ids["bob"])["reasons"])


def test_lenders_see_only_the_score_and_record_not_loans_limits_or_debts():
    db, admin, ann_c, bob_c, ids = pages()
    make_loan(db, ids["ann"], ids["bob"], started=30, principal=123)
    page = ann_c.get("/credit/bob").get_data(as_text=True)
    assert "Loan record" in page and "Loans taken" not in page and "Borrowing limit" not in page and "Owes now" not in page
    assert "Loans taken" in bob_c.get("/credit").get_data(as_text=True)


def test_refused_borrow_leaves_no_tier_event_behind():
    db = _fresh_db()
    ann, bob = _user(db, "ann"), _user(db, "bob")
    make_loan(db, ann, bob, status="active", started=60)                         # in default, so bob can't borrow
    db.execute("UPDATE users SET balance = 0 WHERE id = ?", (bob,))
    score(db, bob)
    with pytest.raises(appmod.TradeError):
        appmod.accept_loan(db, appmod.offer_loan(db, ann, "", 10, 0, 7), bob)
    assert db.execute("SELECT COUNT(*) FROM credit_history WHERE user_id = ?", (bob,)).fetchone()[0] >= 1


def test_deleting_an_account_removes_its_credit_rows():
    db, admin, ann_c, bob_c, ids = pages()
    appmod.apply_credit(db, ids["bob"], "test")
    _post(admin, f"/admin/users/{ids['bob']}/delete")
    assert not db.execute("SELECT 1 FROM user_credit WHERE user_id = ?", (ids["bob"],)).fetchone()
    assert not db.execute("SELECT 1 FROM credit_history WHERE user_id = ?", (ids["bob"],)).fetchone()


def test_legacy_overdue_loans_get_their_grace_from_the_rules_start():
    db = _fresh_db()
    ann, bob = _user(db, "ann"), _user(db, "bob")
    make_loan(db, ann, bob, status="active", started=60)
    db.execute("UPDATE users SET balance = 0 WHERE id = ?", (bob,))
    assert score(db, bob)["defaulted"] == 1
    db.execute("INSERT OR REPLACE INTO site_settings (key, value, updated_at) VALUES ('loans_v2_at', ?, ?)",
               (appmod.now_str(), appmod.now_str()))                              # the rules began just now
    c = score(db, bob)
    assert c["defaulted"] == 0 and c["late"] == 1               # overdue, still in its grace period
    assert not appmod.in_default(db, db.execute("SELECT * FROM loans WHERE borrower_id = ?", (bob,)).fetchone())


def test_all_loans_page_is_public_and_leaderboard_shows_scores_and_defaults():
    db, admin, ann_c, bob_c, ids = pages()
    cy, dee = _user(db, "cy"), _user(db, "dee")
    make_loan(db, ids["ann"], cy, status="active", started=3, term=7)         # on time
    make_loan(db, ids["ann"], dee, status="active", started=60)               # in default
    db.execute("UPDATE users SET balance = 0 WHERE id IN (?, ?)", (cy, dee))
    appmod.refresh_credit(db)
    offer = appmod.offer_loan(db, ids["ann"], "", 25, 0, 7)                   # an open offer is counted, not listed
    public = appmod.app.test_client()                                          # not logged in
    html = public.get("/loans/all").get_data(as_text=True)
    assert "All loans" in html and ">cy<" not in html and "cy" in html and "dee" in html
    assert html.index("dee") < html.index("cy")                               # in default comes first
    assert "in default" in html and "1 offer" in html
    assert 'class="credit credit-' in html                                     # the borrowers' scores are shown
    board = public.get("/leaderboard").get_data(as_text=True)
    assert ">Credit<" in board and "in default" in board
    assert "All loans" in ann_c.get("/activity").get_data(as_text=True)
    assert offer


def test_credit_report_lists_why_it_was_rescored_but_hides_review_reasons_from_the_player():
    db, admin, ann_c, bob_c, ids = pages()
    appmod.apply_credit(db, ids["bob"], "loan repayment")
    db.execute("UPDATE credit_history SET created_at = ?", (ago(1),))
    db.execute("INSERT INTO user_risk (user_id, score, status, updated_at) VALUES (?, 10, 'clear', 0)", (ids["bob"],))
    appmod.rescore_credit(db, ids["bob"], reason="risk status")
    db.execute("INSERT INTO credit_history (user_id, score, tier, reason, created_at) VALUES (?, 500, 'Poor', 'risk status', ?)",
               (ids["bob"], appmod.now_str()))
    mine = bob_c.get("/credit").get_data(as_text=True)
    assert "loan repayment" in mine and "Account review" in mine and "risk status" not in mine
    assert "risk status" in admin.get("/credit/bob").get_data(as_text=True)
