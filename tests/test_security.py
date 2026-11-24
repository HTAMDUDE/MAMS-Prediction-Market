"""Alt detection, risk scoring, email rules and the admin security tools."""
import json
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from test_market import _fresh_db, _market, _post, _user, csrf, signup, appmod  # noqa: E402
import security  # noqa: E402

SCHOOL_IP = "34.120.2.50"   # a public address; loopback, private and documentation ranges are ignored as signals


@pytest.fixture(autouse=True)
def no_configured_owner(monkeypatch):
    monkeypatch.setattr(appmod, "OWNER_USERNAME", "")


@pytest.fixture(autouse=True)
def restore_db_path():
    old = appmod.DB_PATH
    yield
    appmod.DB_PATH = old


@pytest.fixture
def sent(monkeypatch):
    out = []
    monkeypatch.setattr(appmod, "send_login_code_email", lambda to, code: out.append((to, code)))
    return out


def client_at(ip=SCHOOL_IP, ua="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"):
    c = appmod.app.test_client()
    c.environ_base["REMOTE_ADDR"] = ip
    c.environ_base["HTTP_USER_AGENT"] = ua
    return c


def fp(canvas="c1", webgl="gpu1", token="", platform="Win32", touch=0):
    return json.dumps({"canvas": canvas, "webgl": webgl, "audio": "0.1", "fonts": "1.2.3", "screen": "1920x1080",
                       "tz": "America/New_York", "langs": "en-US", "platform": platform, "touch": touch,
                       "hc": 8, "dm": 8, "wd": 0, "token": token})


def register(c, name, email=None, fp_json="", password="secret1"):
    with c.session_transaction() as sess:
        sess.pop("uid", None)          # a new sign-up on a browser that was logged in: same cookies, fresh session
    return c.post("/register", data={"csrf_token": csrf(c.get("/register")), "username": name,
                                     "email": email or f"{name}@example.org", "password": password,
                                     "confirm": password, "fp": fp_json}, follow_redirects=True)


def seed_owner(db):
    """The first account is the owner, and owners are never scored; tests about scoring need one in place first."""
    oid = _user(db, "owner0")
    db.execute("UPDATE users SET is_admin = 1 WHERE id = ?", (oid,))
    return oid


def uid(db, name):
    return db.execute("SELECT id FROM users WHERE username = ?", (name,)).fetchone()[0]


def risk(db, name):
    r = db.execute("SELECT * FROM user_risk WHERE user_id = ?", (uid(db, name),)).fetchone()
    return None if r is None else dict(r, reasons=json.loads(r["reasons"]))


def held(db, name):
    return db.execute("SELECT held FROM users WHERE username = ?", (name,)).fetchone()[0]


# ---------------------------------------------------------------- pure helpers

@pytest.mark.parametrize("raw, canonical", [
    ("J.O.E+x@GoogleMail.com", "joe@gmail.com"),
    ("joe@gmail.com", "joe@gmail.com"),
    ("  Joe.Smith+alt1@GMAIL.COM ", "joesmith@gmail.com"),
    ("some-keyword@yahoo.com", "some@yahoo.com"),
    ("a.b@outlook.com", "a.b@outlook.com"),          # dots matter outside Gmail
    ("x+tag@hotmail.com", "x@hotmail.com"),          # separate mailboxes from outlook.com / live.com: never folded
    ("x@live.com", "x@live.com"),
    ("x@ymail.com", "x@ymail.com"),
    ("me@mac.com", "me@icloud.com"),
    ("sam@pm.me", "sam@proton.me"),
    ("x@bücher.de", "x@xn--bcher-kva.de"),
    ("ＪＯＥ@example.com", "joe@example.com"),          # full-width letters fold to ASCII
])
def test_normalize_email(raw, canonical):
    assert security.normalize_email(raw)[1] == canonical


@pytest.mark.parametrize("bad", ["", "nope", "a@@b.com", "a b@c.com", "@x.com", "a@nodot", "a..b@x.com", ".a@x.com",
                                 "a@-x.com", "a\n@x.com", "+@x.com"])
def test_normalize_email_rejects_junk(bad):
    assert security.normalize_email(bad) == (None, None)


def test_display_keeps_typed_local_part_but_lowercases_domain():
    assert security.normalize_email("Old.Timer@Example.COM")[0] == "Old.Timer@example.com"


def test_provider_classes():
    cls = lambda d: security.email_provider_class(d, school=set())[0]
    assert cls("mailinator.com") == "blocked" and cls("x.guerrillamail.de") == "blocked"
    assert cls("yopmail.fr") == "blocked" and cls("10minutemail.net") == "blocked"
    assert cls("duck.com") == "shady" and cls("gmx.net") == "shady" and cls("cock.li") == "shady"
    assert cls("simplelogin.io") == "shady"
    assert cls("gmail.com") == "normal" and cls("wpi.edu") == "normal"
    assert cls("notmailinator.org") == "normal"                      # only real subdomains match, not suffixes
    assert security.email_provider_class("x.org", extra_blocked=["x.org"])[0] == "blocked"
    assert security.email_provider_class("school.edu", school={"school.edu"})[:2] == ("school", -15)


def test_domain_list_parsing():
    assert security.parse_domain_list("A.com, @b.net\n*.c.org  bad domain! a.com") == ["a.com", "b.net", "c.org", "bad"]


def test_usable_ip_ignores_local_and_private():
    for ip in ("127.0.0.1", "::1", "10.1.2.3", "192.168.0.9", "172.16.0.1", "169.254.1.1", "", "garbage"):
        assert not security.usable_ip(ip), ip
    assert security.usable_ip("34.120.2.5") and security.usable_ip("2001:4860:4860::8888")
    assert security.net_of("34.120.2.77") == "34.120.2.0/24"


def test_fp_digest_validates_and_hashes():
    assert security.fp_digest("") is None and security.fp_digest("{not json") is None
    assert security.fp_digest("[1,2]") is None and security.fp_digest("x" * 7000) is None
    d = security.fp_digest(fp(token="a" * 32))
    assert d["token"] == "a" * 32 and {"fp", "fp_parts", "fp_canvas", "fp_webgl"} <= set(d["parts"])
    assert security.fp_digest(fp(token="not-hex"))["token"] == ""
    assert security.fp_digest(fp())["parts"]["fp"] == security.fp_digest(fp())["parts"]["fp"]
    assert security.fp_digest(fp(canvas="other"))["parts"]["fp"] != d["parts"]["fp"]
    # empty components are skipped, so "no value" can never link two accounts
    assert "fp_canvas" not in security.fp_digest(json.dumps({"canvas": "", "webgl": "x"}))["parts"]


def test_username_stems():
    assert security.username_stem("Xx_J0hn_Alt") == security.username_stem("john") == "john"
    assert security.username_stem("emma2") == security.username_stem("Emma")
    assert security.username_stem("emma") != security.username_stem("liam")
    assert security.similar("johnsmith", "jonsmith") > 0.8 and security.similar("abc", "xyz") == 0


def test_parse_ua():
    ios = security.parse_ua("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17.0 Mobile/15E Safari/604")
    assert (ios["os"], ios["device"], ios["browser"], ios["bot"]) == ("iOS", "phone", "Safari", False)
    assert security.parse_ua("python-requests/2.31")["bot"] and security.parse_ua("")["bot"]
    assert security.parse_ua("Mozilla/5.0 HeadlessChrome/120.0 Safari/537")["bot"]


def test_rarity_fades_to_zero():
    assert security.rarity(2) == 1 and security.rarity(security.COMMON_THRESHOLD) == 0
    assert 0 < security.rarity(4) < 1


# ---------------------------------------------------------------- email rules

def test_disposable_email_refused_at_signup_and_when_asking_for_a_code(sent):
    db = _fresh_db()
    c = client_at()
    page = register(c, "temp", "someone@mailinator.com").get_data(as_text=True)
    assert "disposable inboxes" in page and db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
    assert not sent
    signup(c, "real")
    db.execute("UPDATE users SET email = NULL, email_verified = 0, email_canonical = NULL")
    page = c.post("/account/email", data={"csrf_token": csrf(c.get("/account/email")), "action": "send",
                                          "email": "x@YOPMAIL.com"}, follow_redirects=True).get_data(as_text=True)
    assert "disposable inboxes" in page and not sent


def test_one_mailbox_one_account_whatever_the_spelling(sent):
    db = _fresh_db()
    signup(client_at("34.120.1.1"), "first")                      # first@example.com, confirmed
    db.execute("UPDATE users SET email = 'joe.smith@gmail.com' WHERE username = 'first'")
    appmod.backfill_security(db)
    for variant in ("joesmith@gmail.com", "Joe.Smith+alt@GoogleMail.com", "j.o.e.smith+2@gmail.com"):
        page = register(client_at("34.120.1.2"), f"alt{len(sent)}", variant).get_data(as_text=True)
        assert "already used" in page, variant
    assert db.execute("SELECT COUNT(*) FROM users WHERE username LIKE 'alt%'").fetchone()[0] == 0


def test_pending_claims_compare_normalized_addresses(sent):
    db = _fresh_db()
    register(client_at("34.120.1.1"), "first", "me@gmail.com")
    page = register(client_at("34.120.1.2"), "second", "m.e+x@googlemail.com").get_data(as_text=True)
    assert "already used" in page and db.execute("SELECT COUNT(*) FROM users WHERE username='second'").fetchone()[0] == 0
    assert len(sent) == 1


def test_confirming_claims_the_email_in_the_ledger(sent):
    db = _fresh_db()
    c = client_at("34.120.1.1")
    register(c, "first", "Me@Gmail.com")
    code = sent[-1][1]
    c.post("/account/email", data={"csrf_token": csrf(c.get("/account/email")), "action": "verify", "code": code})
    u = db.execute("SELECT * FROM users WHERE username = 'first'").fetchone()
    assert u["email_verified"] == 1 and u["email_canonical"] == "me@gmail.com"
    assert db.execute("SELECT status FROM email_ledger WHERE canonical = 'me@gmail.com'").fetchone()[0] == "active"
    # the same person may re-confirm their own address, nobody else may take it
    assert appmod.email_problem(db, "me@gmail.com", except_id=u["id"], username="first") is None
    assert appmod.email_problem(db, "m.e@gmail.com", username="other") is not None


def test_deleted_accounts_email_stays_blocked_until_an_admin_releases_it():
    db = _fresh_db()
    admin, bob = client_at("34.120.1.1"), client_at("34.120.1.2")
    signup(admin, "boss")
    bobid = _user(db, "bob")
    db.execute("UPDATE users SET email = 'bob.real@gmail.com' WHERE id = ?", (bobid,))
    appmod.backfill_security(db)
    appmod.delete_account(db, bobid)
    assert db.execute("SELECT status FROM email_ledger WHERE canonical = 'bobreal@gmail.com'").fetchone()[0] == "deleted"
    assert appmod.email_problem(db, "bobreal+new@gmail.com", username="bob") == appmod.EMAIL_USED_MSG
    page = _post(admin, "/admin/security/release-email", canonical="bobreal@gmail.com").get_data(as_text=True)
    assert "can be used to sign up again" in page
    assert appmod.email_problem(db, "bobreal@gmail.com", username="newbob") is None
    assert db.execute("SELECT COUNT(*) FROM audit_log WHERE action = 'email.release'").fetchone()[0] == 1


def test_admin_can_extend_the_blocked_domain_list(sent):
    db = _fresh_db()
    admin = client_at("34.120.1.1")
    signup(admin, "boss")
    _post(admin, "/admin/security/lists", blocked="badmail.test\nother.test", shady="", networks="")
    page = register(client_at("34.120.1.2"), "xander", "a@sub.badmail.test").get_data(as_text=True)
    assert "disposable inboxes" in page
    assert "badmail.test" in admin.get("/admin/security").get_data(as_text=True)


# ---------------------------------------------------------------- scoring and the hold

def test_shady_email_provider_adds_points(sent):
    db = _fresh_db()
    seed_owner(db)
    register(client_at("34.120.1.1"), "relay", "me@duck.com", fp())
    r = risk(db, "relay")
    assert any(k == "email" and "duck.com" in t for _, k, t in r["reasons"])
    assert 0 < r["score"] < security.FLAG_THRESHOLD and held(db, "relay") == 0


def test_second_signup_from_the_same_device_and_ip_is_held(sent):
    db = _fresh_db()
    seed_owner(db)
    c = client_at("34.120.1.7")                                    # one browser: same cookie jar, same IP
    register(c, "mainacct", fp_json=fp(token="a" * 32))
    assert held(db, "mainacct") == 0
    register(c, "mainacct2", fp_json=fp(token="a" * 32))
    r = risk(db, "mainacct2")
    kinds = {k for _, k, _ in r["reasons"]}
    assert "device" in kinds and r["score"] >= security.HOLD_THRESHOLD and r["status"] == "held" and held(db, "mainacct2") == 1
    assert uid(db, "mainacct") in {int(k) for k in json.loads(db.execute(
        "SELECT links FROM user_risk WHERE user_id = ?", (uid(db, "mainacct2"),)).fetchone()[0])}
    assert db.execute("SELECT actor_name FROM audit_log WHERE action = 'user.auto_hold'").fetchone()[0] == "system"


def test_a_whole_school_on_one_ip_is_never_held(sent):
    db = _fresh_db()
    seed_owner(db)
    names = ["alice", "bruno", "chloe", "dmitri", "elena", "farid", "greta", "hiro", "imani", "jonas", "katya", "liam"]
    for name in names:
        # same school IP and the same laptop model (identical fingerprint), but a different browser profile each
        register(client_at(SCHOOL_IP), name, fp_json=fp(canvas="school-laptop", webgl="intel-uhd"))
    assert db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 13
    # identical laptops can look like a rare pair at first (cold start), so some may be flagged, but none is ever held
    assert db.execute("SELECT COUNT(*) FROM users WHERE held = 1").fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM user_risk WHERE status = 'held'").fetchone()[0] == 0


def test_marking_the_school_network_common_stops_laptops_matching_each_other(sent):
    db = _fresh_db()
    seed_owner(db)
    appmod.set_setting(db, "common_networks", "34.120.2.0/24")
    for name in ["alice", "bruno", "chloe"]:
        register(client_at(SCHOOL_IP), name, fp_json=fp(canvas="school-laptop", webgl="intel-uhd"))
    assert db.execute("SELECT COUNT(*) FROM user_risk WHERE status IN ('held', 'flagged')").fetchone()[0] == 0
    assert not any(k == "fp" for _, k, _ in risk(db, "chloe")["reasons"])
    # ...but the same laptop fingerprint away from the school network still counts
    register(client_at("34.120.9.9"), "zed", fp_json=fp(canvas="school-laptop", webgl="intel-uhd"))
    assert any(k == "fp" for _, k, _ in risk(db, "zed")["reasons"])


def test_incognito_alt_same_ip_and_fingerprint_is_flagged_but_not_held(sent):
    """Fresh cookie and token, unrelated username and email, but the same IP and the same browser fingerprint."""
    db = _fresh_db()
    seed_owner(db)
    register(client_at("34.120.4.4"), "mainacct", "main.person@gmail.com", fp(token="1" * 32))
    register(client_at("34.120.4.4"), "zebra", "quiet.fox@yahoo.com", fp(token="2" * 32))
    r = risk(db, "zebra")
    kinds = {k for _, k, _ in r["reasons"]}
    assert {"fp", "ip"} <= kinds and "device" not in kinds
    assert r["status"] == "flagged" and r["score"] >= security.FLAG_THRESHOLD and held(db, "zebra") == 0


def test_ip_evidence_alone_never_reaches_the_flag_threshold(sent):
    db = _fresh_db()
    seed_owner(db)
    # two accounts, same IP, signed up minutes apart, different fingerprints: the most IP evidence can ever give
    register(client_at("34.120.1.9"), "one", fp_json=fp(canvas="a", webgl="x"))
    register(client_at("34.120.1.9"), "two", fp_json=fp(canvas="b", webgl="y"))
    r = risk(db, "two")
    assert r["score"] <= security.IP_BUDGET < security.FLAG_THRESHOLD and r["status"] == "clear"


def test_marking_the_school_network_common_removes_ip_links(sent):
    db = _fresh_db()
    seed_owner(db)
    register(client_at("34.120.1.9"), "one", fp_json=fp(canvas="a", webgl="x"))
    register(client_at("34.120.1.9"), "two", fp_json=fp(canvas="b", webgl="y"))
    assert any(k == "ip" for _, k, _ in risk(db, "two")["reasons"])
    appmod.set_setting(db, "common_networks", "34.120.1.0/24")
    appmod.apply_risk(db, uid(db, "two"))
    assert not any(k in ("ip", "net") for _, k, _ in risk(db, "two")["reasons"])


def test_local_and_private_addresses_are_ignored(sent):
    db = _fresh_db()
    seed_owner(db)
    c = appmod.app.test_client()                                     # 127.0.0.1
    register(c, "localone", fp_json=fp(canvas="a"))
    assert db.execute("SELECT COUNT(*) FROM sightings WHERE kind IN ('ip', 'net')").fetchone()[0] == 0


def test_bots_and_missing_fingerprints_add_risk(sent):
    db = _fresh_db()
    seed_owner(db)
    register(client_at("34.120.1.1", ua="python-requests/2.31"), "scripted")
    kinds = {k for _, k, _ in risk(db, "scripted")["reasons"]}
    assert {"bot", "nofp"} <= kinds
    register(client_at("34.120.1.2"), "webdrv", fp_json=json.dumps(
        {"canvas": "c", "webgl": "g", "wd": 1, "platform": "Win32", "tz": "America/New_York"}))
    assert any(k == "bot" for _, k, _ in risk(db, "webdrv")["reasons"])


def test_phone_user_agent_with_desktop_platform_is_inconsistent(sent):
    db = _fresh_db()
    seed_owner(db)
    ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17.0 Mobile/15E Safari/604"
    register(client_at("34.120.1.1", ua=ua), "faker", fp_json=fp(platform="Win32", touch=0))
    assert any(k == "ua_mismatch" for _, k, _ in risk(db, "faker")["reasons"])
    register(client_at("34.120.1.2", ua=ua), "genuine", fp_json=fp(canvas="z", platform="iPhone", touch=5))
    assert not any(k == "ua_mismatch" for _, k, _ in risk(db, "genuine")["reasons"])


def test_similar_usernames_and_email_names_are_clues(sent):
    db = _fresh_db()
    seed_owner(db)
    register(client_at("34.120.1.1"), "emmawilson", "emma.wilson@gmail.com", fp())
    register(client_at("34.120.1.2"), "Emma_Wilson2", "emmawilson@yahoo.com", fp(canvas="z"))
    kinds = [k for _, k, _ in risk(db, "Emma_Wilson2")["reasons"]]
    assert kinds.count("username") == 1 and kinds.count("email") >= 1


def test_loans_between_linked_accounts_raise_the_score():
    db = _fresh_db()
    a, b = _user(db, "linka"), _user(db, "linkb")
    for u, n in ((a, "linka"), (b, "linkb")):
        security.record(db, u, n, "device", "d" * 32)
    before = security.compute_risk(db, b)["score"]
    lid = appmod.offer_loan(db, a, "linkb", 100, 0, 7)
    appmod.accept_loan(db, lid, b)
    after = security.compute_risk(db, b)
    assert after["score"] >= before + 25
    assert any(k == "behaviour" and "loan" in t for _, k, t in after["reasons"])
    # an unrelated pair lending each other money is perfectly normal
    c, d = _user(db, "plainc"), _user(db, "plaind")
    appmod.accept_loan(db, appmod.offer_loan(db, c, "plaind", 50, 5, 7), d)
    assert not any(k == "behaviour" for _, k, _ in security.compute_risk(db, d)["reasons"])


def test_entry_fees_paid_to_a_linked_creators_markets_are_a_clue():
    db = _fresh_db()
    creator, fan = _user(db, "creator"), _user(db, "fan")
    for u, n in ((creator, "creator"), (fan, "fan")):
        security.record(db, u, n, "device", "e" * 32)
    for i in range(3):
        mid, _ = _market(db, b=300 + i)
        db.execute("UPDATE markets SET created_by = ? WHERE id = ?", (creator, mid))
        db.execute("INSERT INTO market_entries (market_id, user_id, creator_id, fee, created_at) VALUES (?, ?, ?, 10, ?)",
                   (mid, fan, creator, appmod.now_str()))
    assert any("entry fees" in t for _, _, t in security.compute_risk(db, fan)["reasons"])
    assert any("entry fees" in t for _, _, t in security.compute_risk(db, creator)["reasons"])


def test_admins_and_the_owner_are_never_scored_or_held():
    db = _fresh_db()
    owner, admin = _user(db, "theowner"), _user(db, "anadmin")
    db.execute("UPDATE users SET is_admin = 1")
    for u, n in ((owner, "theowner"), (admin, "anadmin")):
        security.record(db, u, n, "device", "f" * 32)
    assert appmod.apply_risk(db, owner) is None and appmod.apply_risk(db, admin) is None
    assert db.execute("SELECT COUNT(*) FROM user_risk").fetchone()[0] == 0


def test_established_accounts_are_flagged_not_held(monkeypatch):
    db = _fresh_db()
    seed_owner(db)
    old = _user(db, "oldtimer")
    db.execute("UPDATE users SET created_at = ? WHERE id = ?",
               ((appmod.datetime.now() - appmod.timedelta(days=30)).strftime("%Y-%m-%d %H:%M:%S"), old))
    monkeypatch.setattr(appmod.security, "compute_risk", lambda *a, **k: {
        "score": 90, "level": "high", "reasons": [(90, "device", "x")], "links": {}, "kinds": {"device"}, "qualifies": True})
    assert appmod.apply_risk(db, old) == "flagged"
    assert db.execute("SELECT held FROM users WHERE id = ?", (old,)).fetchone()[0] == 0
    fresh = _user(db, "newcomer")
    with appmod.app.test_request_context():          # the automatic hold writes to the Admin log
        assert appmod.apply_risk(db, fresh) == "held"


def test_weak_evidence_alone_cannot_hold_even_at_a_high_score(monkeypatch):
    db = _fresh_db()
    seed_owner(db)
    u = _user(db, "weak")
    monkeypatch.setattr(appmod.security, "compute_risk", lambda *a, **k: {
        "score": 80, "level": "high", "reasons": [(80, "ip", "x")], "links": {}, "kinds": {"ip"}, "qualifies": False})
    assert appmod.apply_risk(db, u) == "flagged"


def test_approved_accounts_are_only_reflagged_by_a_new_kind_of_signal(monkeypatch):
    db = _fresh_db()
    seed_owner(db)
    u = _user(db, "reviewed")
    db.execute("INSERT INTO user_risk (user_id, status, ack, updated_at) VALUES (?, 'approved', '[\"device\"]', 0)", (u,))
    result = {"score": 70, "level": "high", "reasons": [], "links": {}, "kinds": {"device"}, "qualifies": True}
    monkeypatch.setattr(appmod.security, "compute_risk", lambda *a, **k: result)
    assert appmod.apply_risk(db, u) == "approved"
    result["kinds"] = {"device", "email"}
    assert appmod.apply_risk(db, u) == "flagged"
    # an admin had already reviewed this account, so it's never auto-held afterwards, however many times it's re-scored
    db.execute("UPDATE user_risk SET reviewed_at = 1 WHERE user_id = ?", (u,))
    for _ in range(3):
        assert appmod.apply_risk(db, u) == "flagged"
    assert db.execute("SELECT held FROM users WHERE id = ?", (u,)).fetchone()[0] == 0


def test_hotmail_and_outlook_are_different_mailboxes(sent):
    db = _fresh_db()
    seed_owner(db)
    db.execute("UPDATE users SET email = 'jsmith@outlook.com' WHERE username = 'owner0'")
    appmod.backfill_security(db)
    assert appmod.email_problem(db, "jsmith@hotmail.com", username="jsmith") is None
    assert appmod.email_problem(db, "jsmith+x@outlook.com", username="jsmith") is not None


def test_a_broken_backfill_never_stops_start_up(monkeypatch):
    db = _fresh_db()
    monkeypatch.setattr(appmod.security, "normalize_email", lambda *a: 1 / 0)
    db.execute("INSERT INTO users (username, password_hash, balance, created_at, email, email_verified) "
               "VALUES ('x1', 'x', 1, 'x', 'a@b.com', 1)")
    appmod.backfill_security(db)          # must not raise


def test_held_stays_held_until_an_admin_decides(monkeypatch):
    db = _fresh_db()
    seed_owner(db)
    u = _user(db, "stuck")
    db.execute("UPDATE users SET held = 1 WHERE id = ?", (u,))
    db.execute("INSERT INTO user_risk (user_id, status, updated_at) VALUES (?, 'held', 0)", (u,))
    monkeypatch.setattr(appmod.security, "compute_risk", lambda *a, **k: {
        "score": 0, "level": "low", "reasons": [], "links": {}, "kinds": set(), "qualifies": False})
    assert appmod.apply_risk(db, u) == "held"


# ---------------------------------------------------------------- the read-only hold

def test_held_user_can_browse_but_not_bet_claim_lend_or_comment():
    db = _fresh_db()
    admin, bob = client_at("34.120.1.1"), client_at("34.120.1.2")
    signup(admin, "boss")
    signup(bob, "bob")
    mid, outs = _market(db)
    db.execute("UPDATE users SET held = 1 WHERE username = 'bob'")
    bobid = uid(db, "bob")
    assert bob.get("/").status_code == 200 and bob.get(f"/market/{mid}").status_code == 200
    assert "needs to review your account" in bob.get("/").get_data(as_text=True)
    before = db.execute("SELECT balance FROM users WHERE id = ?", (bobid,)).fetchone()[0]
    for url, data in ((f"/market/{mid}/trade", {"outcome_id": outs[0], "action": "buy", "value": "10"}),
                      ("/bonus", {}), (f"/market/{mid}/comment", {"body": "hello"}),
                      ("/loans/offer", {"amount": "5", "rate": "1", "days": "3"}),
                      ("/propose", {"question": "Will it?"})):
        page = _post(bob, url, **data).get_data(as_text=True)
        assert "waiting for an admin to review" in page, url
    assert db.execute("SELECT balance FROM users WHERE id = ?", (bobid,)).fetchone()[0] == before
    assert db.execute("SELECT COUNT(*) FROM trades").fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM comments").fetchone()[0] == 0
    assert bob.get(f"/api/quote?market={mid}&outcome={outs[0]}&action=buy&value=10").status_code != 500
    assert _post(bob, "/logout").status_code == 200                    # logging out is still allowed


def test_hold_hides_account_from_the_leaderboard_and_approval_releases_it():
    db = _fresh_db()
    admin, bob = client_at("34.120.1.1"), client_at("34.120.1.2")
    signup(admin, "boss")
    signup(bob, "bob")
    bobid = uid(db, "bob")
    _post(admin, f"/admin/users/{bobid}/risk", action="hold")
    assert held(db, "bob") == 1 and "bob" not in client_at().get("/leaderboard").get_data(as_text=True)
    assert db.execute("SELECT actor_name FROM audit_log WHERE action = 'user.hold'").fetchone()[0] == "boss"
    _post(admin, f"/admin/users/{bobid}/risk", action="approve")
    assert held(db, "bob") == 0 and risk(db, "bob")["status"] == "approved"
    assert "bob" in client_at().get("/leaderboard").get_data(as_text=True)
    mid, outs = _market(db)
    _post(bob, f"/market/{mid}/trade", outcome_id=outs[0], action="buy", value="10")
    assert db.execute("SELECT COUNT(*) FROM trades WHERE user_id = ?", (bobid,)).fetchone()[0] == 1


def test_admins_cannot_hold_other_admins_or_the_owner():
    db = _fresh_db()
    owner, admin2 = client_at("34.120.1.1"), client_at("34.120.1.2")
    signup(owner, "boss")
    signup(admin2, "deputy")
    db.execute("UPDATE users SET is_admin = 1 WHERE username = 'deputy'")
    page = _post(admin2, f"/admin/users/{uid(db, 'boss')}/risk", action="hold").get_data(as_text=True)
    assert "Nobody can do that to the owner" in page
    page = _post(owner, f"/admin/users/{uid(db, 'deputy')}/risk", action="hold").get_data(as_text=True)
    assert "scored or held" in page and held(db, "deputy") == 0


# ---------------------------------------------------------------- signals and cookies

def test_device_cookie_is_set_once_and_recorded(sent):
    db = _fresh_db()
    seed_owner(db)
    c = client_at("34.120.1.1")
    resp = c.get("/register")
    cookie = resp.headers.get("Set-Cookie", "")
    assert "mams_did=" in cookie and "HttpOnly" in cookie and "SameSite=Lax" in cookie
    assert "mams_did" not in c.get("/register").headers.get("Set-Cookie", "")     # already has one
    register(c, "dev1", fp_json=fp(token="b" * 32))
    values = {r["value"] for r in db.execute("SELECT value FROM sightings WHERE kind = 'device'")}
    assert "b" * 32 in values and len(values) == 2                                # cookie + localStorage token


def test_clearing_only_the_cookie_still_links_the_device_through_the_stored_token(sent):
    db = _fresh_db()
    seed_owner(db)
    register(client_at("34.120.1.1"), "orig", fp_json=fp(token="c" * 32))
    register(client_at("34.120.1.2"), "again", fp_json=fp(canvas="other", token="c" * 32))   # fresh cookie jar
    assert any(k == "device" for _, k, _ in risk(db, "again")["reasons"])


def test_wrong_passwords_are_logged_but_never_count_as_sightings(sent):
    db = _fresh_db()
    signup(client_at("34.120.1.1"), "victim")
    attacker = client_at("34.120.1.99")
    attacker.post("/login", data={"csrf_token": csrf(attacker.get("/login")), "username": "victim", "password": "nope",
                                  "fp": fp(token="d" * 32)})
    assert db.execute("SELECT COUNT(*) FROM login_events WHERE event = 'login_fail'").fetchone()[0] == 1
    assert db.execute("SELECT COUNT(*) FROM sightings WHERE value IN ('34.120.1.99', ?)", ("d" * 32,)).fetchone()[0] == 0


def test_login_records_a_sighting_and_event():
    db = _fresh_db()
    c = client_at("34.120.1.1")
    signup(client_at("34.120.1.5"), "someone")
    db.execute("UPDATE users SET password_hash = ? WHERE username = 'someone'", (appmod.generate_password_hash("secret1"),))
    c.post("/login", data={"csrf_token": csrf(c.get("/login")), "username": "someone", "password": "secret1",
                           "fp": fp(token="e" * 32)})
    ev = db.execute("SELECT * FROM login_events WHERE event = 'login'").fetchone()
    assert ev["ip"] == "34.120.1.1" and ev["fp_hash"]
    assert db.execute("SELECT COUNT(*) FROM sightings WHERE value = '34.120.1.1'").fetchone()[0] == 1


def test_returning_visitors_are_rechecked_at_most_every_half_hour():
    db = _fresh_db()
    c = client_at("34.120.1.1")
    signup(c, "regular")
    c.get("/")
    first = db.execute("SELECT hits FROM sightings WHERE kind = 'ip'").fetchone()[0]
    c.get("/")
    c.get("/leaderboard")
    assert db.execute("SELECT hits FROM sightings WHERE kind = 'ip'").fetchone()[0] == first


def test_old_signals_are_pruned():
    db = _fresh_db()
    old = time.time() - (security.SIGNAL_RETENTION_DAYS + 1) * 86400
    security.record(db, 1, "gone", "ip", "34.120.1.1", old)
    db.execute("INSERT INTO login_events (user_id, username, event, created_at) VALUES (1, 'gone', 'login', ?)", (old,))
    security.record(db, 2, "kept", "ip", "34.120.1.2")
    security.prune(db)
    assert db.execute("SELECT COUNT(*) FROM sightings").fetchone()[0] == 1
    assert db.execute("SELECT COUNT(*) FROM login_events").fetchone()[0] == 0


def test_deleted_accounts_leave_their_evidence_behind():
    db = _fresh_db()
    alt, newer = _user(db, "oldalt"), _user(db, "newalt")
    security.record(db, alt, "oldalt", "device", "9" * 32)
    appmod.delete_account(db, alt)
    assert db.execute("SELECT COUNT(*) FROM sightings WHERE user_id = ?", (alt,)).fetchone()[0] == 1
    security.record(db, newer, "newalt", "device", "9" * 32)
    r = security.compute_risk(db, newer)
    assert any(k == "device" and "oldalt (deleted)" in t for _, k, t in r["reasons"])
    assert r["links"][alt]["deleted"] is True


# ---------------------------------------------------------------- migration

def test_migration_flags_accounts_whose_emails_are_the_same_mailbox_without_crashing():
    db = _fresh_db()
    one = db.execute("INSERT INTO users (username, password_hash, balance, created_at, email, email_verified) "
                     "VALUES ('dupone', 'x', 1000, ?, 'a.b@gmail.com', 1)", (appmod.now_str(),)).lastrowid
    two = db.execute("INSERT INTO users (username, password_hash, balance, created_at, email, email_verified) "
                     "VALUES ('duptwo', 'x', 1000, ?, 'ab+spam@googlemail.com', 1)", (appmod.now_str(),)).lastrowid
    appmod.backfill_security(db)
    appmod.backfill_security(db)                                    # safe to run repeatedly
    appmod.init_db()                                                # and the whole start-up path
    rows = {r["user_id"]: r for r in db.execute("SELECT * FROM user_risk")}
    assert rows[one]["status"] == "flagged" and rows[two]["status"] == "flagged"
    assert "duptwo" in rows[one]["reasons"] and "dupone" in rows[two]["reasons"]
    assert db.execute("SELECT COUNT(*) FROM users WHERE email_canonical = 'ab@gmail.com'").fetchone()[0] == 2
    assert db.execute("SELECT COUNT(*) FROM email_ledger").fetchone()[0] == 1


def test_migration_runs_on_a_copy_of_an_old_database(tmp_path):
    """A database from before this feature (no new columns or tables) still starts."""
    import sqlite3
    path = str(tmp_path / "old.db")
    raw = sqlite3.connect(path)
    raw.executescript("""
        CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL, email TEXT, email_verified INTEGER NOT NULL DEFAULT 0, balance REAL NOT NULL,
            is_admin INTEGER NOT NULL DEFAULT 0, last_bonus TEXT, created_at TEXT NOT NULL,
            session_gen INTEGER NOT NULL DEFAULT 0);
        INSERT INTO users (username, password_hash, email, email_verified, balance, created_at)
            VALUES ('legacy', 'x', 'Legacy.User@Gmail.com', 1, 1000, '2025-01-01 00:00:00');
    """)
    raw.commit()
    raw.close()
    appmod.DB_PATH = path
    appmod.init_db()
    db = appmod.connect()
    assert db.execute("SELECT email_canonical, held FROM users").fetchone()[:] == ("legacyuser@gmail.com", 0)
    assert db.execute("SELECT status FROM email_ledger").fetchone()[0] == "active"


# ---------------------------------------------------------------- admin tools

def _admin_with_users(db, names=("u1", "u2", "u3")):
    owner = client_at("34.120.1.1")
    signup(owner, "boss")
    ids = {}
    for n in names:
        ids[n] = _user(db, n)
    return owner, ids


def test_bulk_delete_skips_self_owner_and_admins_and_logs_each_one():
    db = _fresh_db()
    owner, ids = _admin_with_users(db)
    deputy = _user(db, "deputy")
    db.execute("UPDATE users SET is_admin = 1 WHERE id = ?", (deputy,))
    boss = uid(db, "boss")
    page = _post(owner, "/admin/users/bulk", action="delete",
                 uids=[str(boss), str(deputy), str(ids["u1"]), str(ids["u2"]), "999999"]).get_data(as_text=True)
    assert "2 done" in page and "3 skipped" in page
    assert "Remove their admin role" in page and "delete your own account" in page
    names = {r[0] for r in db.execute("SELECT username FROM users")}
    assert names == {"boss", "deputy", "u3"}
    assert db.execute("SELECT COUNT(*) FROM audit_log WHERE action = 'user.delete'").fetchone()[0] == 2
    assert db.execute("SELECT COUNT(*) FROM audit_log WHERE action = 'user.bulk'").fetchone()[0] == 1
    assert db.execute("SELECT COUNT(*) FROM email_ledger WHERE status = 'deleted'").fetchone()[0] == 0   # backfill not run in tests


def test_non_owner_admin_cannot_bulk_touch_admins():
    db = _fresh_db()
    owner, ids = _admin_with_users(db)
    deputy = client_at("34.120.1.3")
    signup(deputy, "deputy")
    db.execute("UPDATE users SET is_admin = 1 WHERE username = 'deputy'")
    other_admin = _user(db, "otheradmin")
    db.execute("UPDATE users SET is_admin = 1 WHERE id = ?", (other_admin,))
    page = _post(deputy, "/admin/users/bulk", action="ban", uids=[str(other_admin), str(ids["u1"])]).get_data(as_text=True)
    assert "Only the site owner" in page and "1 done" in page
    assert db.execute("SELECT COUNT(*) FROM trade_bans").fetchone()[0] == 1


@pytest.mark.parametrize("action, check", [
    ("ban", "SELECT COUNT(*) FROM trade_bans"), ("mute", "SELECT COUNT(*) FROM comment_mutes"),
    ("hold", "SELECT COUNT(*) FROM users WHERE held = 1"),
    ("approve", "SELECT COUNT(*) FROM user_risk WHERE status = 'approved'")])
def test_bulk_actions_apply_to_every_ticked_account(action, check):
    db = _fresh_db()
    owner, ids = _admin_with_users(db)
    _post(owner, "/admin/users/bulk", action=action, uids=[str(ids["u1"]), str(ids["u2"])])
    assert db.execute(check).fetchone()[0] == 2
    undo = {"ban": "allow", "mute": "unmute"}.get(action)
    if undo:
        _post(owner, "/admin/users/bulk", action=undo, uids=[str(ids["u1"]), str(ids["u2"])])
        assert db.execute(check).fetchone()[0] == 0


def test_bulk_rejects_bad_requests():
    db = _fresh_db()
    owner, ids = _admin_with_users(db)
    assert "Pick an action" in _post(owner, "/admin/users/bulk", action="explode", uids=[str(ids["u1"])]).get_data(as_text=True)
    assert "Tick at least one" in _post(owner, "/admin/users/bulk", action="delete").get_data(as_text=True)
    assert "Tick at least one" in _post(owner, "/admin/users/bulk", action="delete", uids=["abc", "-1"]).get_data(as_text=True)
    assert db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 4


def test_bulk_and_security_pages_are_for_admins_only():
    db = _fresh_db()
    owner, ids = _admin_with_users(db)
    bob = client_at("34.120.1.8")
    signup(bob, "bob")
    anon = client_at("34.120.1.9")
    for c in (bob, anon):
        assert c.get("/admin/security").status_code in (302, 403)
        assert c.post("/admin/users/bulk", data={"csrf_token": csrf(c.get("/login")), "action": "delete",
                                                  "uids": [str(ids["u1"])]}).status_code in (302, 403)
        assert c.post(f"/admin/users/{ids['u1']}/risk", data={"csrf_token": csrf(c.get("/login")),
                                                              "action": "approve"}).status_code in (302, 403)
    assert bob.get(f"/admin/users/{ids['u1']}").status_code == 403
    assert db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 5


def test_admin_user_page_shows_email_ip_and_devices(sent):
    db = _fresh_db()
    owner = client_at("34.120.1.1")
    signup(owner, "boss")
    register(client_at("34.120.2.77"), "target", "target.person@gmail.com", fp(token="1" * 32))
    page = owner.get(f"/admin/users/{uid(db, 'target')}").get_data(as_text=True)
    assert "Identity &amp; risk" in page and "target.person@gmail.com" in page and "34.120.2.77" in page
    assert "Signed up" in page and "Chrome 126 on Windows" in page and "Devices" in page


def test_admin_user_page_shows_linked_accounts_and_reasons(sent):
    db = _fresh_db()
    owner = client_at("34.120.1.1")
    signup(owner, "boss")
    c = client_at("34.120.2.8")
    register(c, "mainacct", fp_json=fp(token="2" * 32))
    register(c, "mainacct2", fp_json=fp(token="2" * 32))
    page = owner.get(f"/admin/users/{uid(db, 'mainacct2')}").get_data(as_text=True)
    assert "Why this score" in page and "Same device as mainacct" in page and "Linked accounts" in page
    assert "Held for review" in page


def test_admins_own_page_has_no_risk_card_for_non_owner_viewers():
    db = _fresh_db()
    owner = client_at("34.120.1.1")
    signup(owner, "boss")
    deputy = client_at("34.120.1.3")
    signup(deputy, "deputy")
    db.execute("UPDATE users SET is_admin = 1 WHERE username = 'deputy'")
    page = deputy.get(f"/admin/users/{uid(db, 'boss')}").get_data(as_text=True)
    assert "Identity &amp; risk" not in page and "boss@example.com" not in page


def test_users_table_shows_email_ip_and_risk_and_can_search_them(sent):
    db = _fresh_db()
    owner = client_at("34.120.1.1")
    signup(owner, "boss")
    register(client_at("34.120.2.77"), "target", "target.person@gmail.com", fp())
    page = owner.get("/admin").get_data(as_text=True)
    assert "target.person@gmail.com" in page and "34.120.2.77" in page and 'data-bulk-all' in page
    by_email = owner.get("/admin?q=person%40gmail").get_data(as_text=True)
    assert "target" in by_email and "student" not in by_email
    assert "target" in owner.get("/admin?q=34.120.2").get_data(as_text=True)
    assert "No users match" in owner.get("/admin?q=nobody-at-all").get_data(as_text=True)


def test_searching_by_email_does_not_reveal_admins_to_non_owner_admins():
    db = _fresh_db()
    owner = client_at("34.120.1.1")
    signup(owner, "boss")
    deputy = client_at("34.120.1.3")
    signup(deputy, "deputy")
    db.execute("UPDATE users SET is_admin = 1 WHERE username = 'deputy'")
    page = deputy.get("/admin?q=boss%40example").get_data(as_text=True)
    assert "No users match" in page
    assert "boss@example.com" in owner.get("/admin").get_data(as_text=True)


def test_users_filters_for_held_flagged_and_high_risk():
    db = _fresh_db()
    owner, ids = _admin_with_users(db, ("a1", "b1", "c1"))
    db.execute("INSERT INTO user_risk (user_id, score, level, status, updated_at) VALUES (?, 70, 'high', 'held', 0)", (ids["a1"],))
    db.execute("INSERT INTO user_risk (user_id, score, level, status, updated_at) VALUES (?, 35, 'medium', 'flagged', 0)", (ids["b1"],))
    db.execute("UPDATE users SET held = 1 WHERE id = ?", (ids["a1"],))
    held_page = owner.get("/admin?filter=held").get_data(as_text=True)
    assert "a1" in held_page and ">b1<" not in held_page and ">c1<" not in held_page
    assert ">b1<" in owner.get("/admin?filter=flagged").get_data(as_text=True)
    high = owner.get("/admin?filter=high").get_data(as_text=True)
    assert ">a1<" in high and ">b1<" not in high


def test_security_page_lists_the_queue_clusters_and_blocked_emails():
    db = _fresh_db()
    owner, ids = _admin_with_users(db)
    links = json.dumps({str(ids["u2"]): {"username": "u2", "deleted": False, "why": ["same device"]}})
    db.execute("INSERT INTO user_risk (user_id, score, level, reasons, links, status, updated_at) "
               "VALUES (?, 75, 'high', ?, ?, 'held', 0)", (ids["u1"], json.dumps([[45, "device", "Same device as u2"]]), links))
    db.execute("INSERT INTO user_risk (user_id, score, level, reasons, links, status, updated_at) "
               "VALUES (?, 40, 'medium', '[]', '{}', 'flagged', 0)", (ids["u2"],))
    db.execute("INSERT INTO email_ledger (canonical, first_username, status, created_at) VALUES ('gone@x.com', 'ghost', 'deleted', 0)")
    page = owner.get("/admin/security").get_data(as_text=True)
    assert "Same device as u2" in page and "Suspicious groups" in page and "gone@x.com" in page
    assert page.index(">u1<") < page.index(">u2<")                      # held before flagged
    assert 'name="uids"' in page and "Re-scan all" in page


def test_rescan_all_applies_new_lists_to_existing_accounts(sent):
    db = _fresh_db()
    owner = client_at("34.120.1.1")
    signup(owner, "boss")
    register(client_at("34.120.1.2"), "viaother", "me@sketchy-mail.example", fp())
    assert not any("sketchy-mail" in t for _, _, t in risk(db, "viaother")["reasons"])
    _post(owner, "/admin/security/lists", blocked="", shady="sketchy-mail.example", networks="")
    page = _post(owner, "/admin/security/rescan").get_data(as_text=True)
    assert "Scanned" in page
    assert any("sketchy-mail" in t for _, _, t in risk(db, "viaother")["reasons"])
    assert db.execute("SELECT COUNT(*) FROM audit_log WHERE action = 'security.rescan'").fetchone()[0] == 1


def test_register_and_login_pages_load_the_fingerprint_script():
    _fresh_db()
    for url in ("/register", "/login"):
        html = appmod.app.test_client().get(url).get_data(as_text=True)
        assert "data-fp" in html and "fp.js" in html
    assert "one account" in appmod.app.test_client().get("/register").get_data(as_text=True)
    assert appmod.app.test_client().get("/static/fp.js").status_code == 200


def test_risk_engine_failure_never_breaks_a_loan(monkeypatch):
    db = _fresh_db()
    admin = client_at("34.120.1.1")
    signup(admin, "boss")
    other = _user(db, "other")
    monkeypatch.setattr(appmod, "apply_risk", lambda *a, **k: 1 / 0)
    page = _post(admin, "/loans/offer", borrower="other", amount="10", rate="5", days="3").get_data(as_text=True)
    assert "Offer posted" in page


def test_alt_detection_failure_never_blocks_signup_or_login(monkeypatch, sent):
    db = _fresh_db()
    seed_owner(db)
    monkeypatch.setattr(appmod, "apply_risk", lambda *a, **k: 1 / 0)
    c = client_at("34.120.1.1")
    page = register(c, "resilient").get_data(as_text=True)
    assert db.execute("SELECT COUNT(*) FROM users WHERE username = 'resilient'").fetchone()[0] == 1
    assert "Enter the 6-digit code" in page
    code = sent[-1][1]
    page = c.post("/account/email", data={"csrf_token": csrf(c.get("/account/email")), "action": "verify", "code": code},
                  follow_redirects=True).get_data(as_text=True)
    assert "Email confirmed" in page
    c2 = client_at("34.120.1.1")
    c2.post("/login", data={"csrf_token": csrf(c2.get("/login")), "username": "resilient", "password": "secret1"})
    assert c2.get("/portfolio").status_code == 200
