"""Alt-account detection, email normalization and risk scoring.

Everything here is independent of Flask: functions take a sqlite connection (rows by name) and plain values, so they
are easy to test. `app.py` records signals (IP, device cookie, fingerprint...) and calls `compute_risk`.

How the score works, in short: each signal adds points (see `compute_risk`). Values shared by many accounts (a school
network, identical school laptops) count for less and less, reaching zero at COMMON_THRESHOLD accounts, so a whole
school behind one IP is never flagged for that alone. Holding a new sign-up also needs evidence that isn't just IP or
fingerprint (a shared device, a related email or username, a bot, or suspicious behaviour).
"""
import hashlib
import ipaddress
import json
import os
import re
import time
import unicodedata
from datetime import datetime

# ---------------------------------------------------------------- tunables

IP_BUDGET = 25               # IP and network evidence together are capped here, just under FLAG_THRESHOLD: a school shares
                             # one public IP, so that alone can never flag anyone
HOLD_THRESHOLD = 60          # new accounts at or above this are held for admin approval
FLAG_THRESHOLD = 30          # accounts at or above this are flagged for review
NEW_ACCOUNT_DAYS = 7         # "new" = younger than this; only new accounts are ever held automatically
COMMON_THRESHOLD = 8         # a value shared by this many accounts or more counts for nothing
SIGNAL_RETENTION_DAYS = 180  # sightings and login events older than this are deleted
VELOCITY_LIMIT = 3           # this many sign-ups from one device/IP in 24 hours is suspicious

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "security_data")

# Signal kinds that are NOT enough, alone, to hold someone (a school shares IPs and laptop models).
WEAK_KINDS = {"ip", "net", "fp", "fp_parts", "tz", "nofp", "ua_mismatch"}


# ---------------------------------------------------------------- email

# Domains that are the same mailbox (not just the same company): googlemail.com is gmail.com, a me.com address is the
# same iCloud mailbox as the icloud.com one, and so on. Deliberately NOT folded: hotmail.com / outlook.com / live.com are
# separate mailboxes, so folding them would refuse a real student because someone else has the same name at outlook.com.
# A missed fold only loses a signal; a wrong fold locks out a real person.
DOMAIN_ALIASES = {
    "googlemail.com": "gmail.com",
    "me.com": "icloud.com", "mac.com": "icloud.com",
    "pm.me": "proton.me", "protonmail.com": "proton.me", "protonmail.ch": "proton.me",
}
YAHOO_DOMAINS = {"yahoo.com", "yahoo.co.uk", "yahoo.ca", "yahoo.fr", "yahoo.de", "yahoo.co.jp", "yahoo.in"}
DOT_INSENSITIVE = {"gmail.com"}  # Gmail ignores dots in the part before the @
EMAIL_SYNTAX = re.compile(r"^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$")


def normalize_email(addr):
    """Returns (display, canonical). `display` is the tidied address to send to; `canonical` is what identifies the
    mailbox, so a.b+x@googlemail.com and ab@gmail.com are the same. Both are None if the address is unusable."""
    addr = unicodedata.normalize("NFKC", (addr or "")).strip()
    if addr.count("@") != 1 or len(addr) > 254 or any(c.isspace() or ord(c) < 32 for c in addr):
        return None, None
    local, domain = addr.rsplit("@", 1)
    domain = domain.lower().rstrip(".")
    try:
        domain = domain.encode("idna").decode("ascii")
    except UnicodeError:
        return None, None
    shown_local = local   # what we send to: exactly what they typed (only the domain is lowercased)
    local = local.lower()
    if (not local or not domain or "." not in domain or len(local) > 64 or ".." in local
            or local.startswith(".") or local.endswith(".") or not EMAIL_SYNTAX.match(local)
            or not re.match(r"^[a-z0-9.-]+$", domain) or domain.startswith((".", "-"))):
        return None, None
    display = f"{shown_local}@{domain}"
    domain = DOMAIN_ALIASES.get(domain, domain)
    local = local.split("+", 1)[0]  # +tag: delivered to the same inbox almost everywhere
    if domain in YAHOO_DOMAINS and "-" in local:
        local = local.split("-", 1)[0]  # Yahoo's disposable addresses are name-keyword
    if domain in DOT_INSENSITIVE:
        local = local.replace(".", "")
    if not local:
        return None, None
    return display, f"{local}@{domain}"


def email_parts(canonical):
    local, _, domain = (canonical or "").partition("@")
    return local, domain


_lists = {}


def _read_list(name, with_points=False):
    items = {}
    try:
        with open(os.path.join(DATA_DIR, name), encoding="utf-8") as f:
            for line in f:
                line = line.split("#", 1)[0].strip().lower()
                if not line:
                    continue
                if with_points:
                    dom, _, pts = line.partition(",")
                    try:
                        items[dom.strip()] = int(pts) if pts.strip() else 15
                    except ValueError:
                        items[dom.strip()] = 15
                else:
                    items[line] = 0
    except OSError:
        pass
    return items


def bundled_lists():
    if not _lists:
        _lists["blocked"] = _read_list("disposable_domains.txt")
        _lists["shady"] = _read_list("shady_domains.txt", with_points=True)
    return _lists["blocked"], _lists["shady"]


def domain_matches(domain, pattern):
    """`pattern` matches `domain` itself or any subdomain; `name.*` matches name on any top-level domain."""
    if pattern.endswith(".*"):
        base = pattern[:-2]
        return re.search(r"(^|\.)" + re.escape(base) + r"\.[a-z.]+$", domain) is not None
    return domain == pattern or domain.endswith("." + pattern)


def school_domains():
    return {d.strip().lower() for d in os.environ.get("MAMS_SCHOOL_DOMAINS", "").split(",") if d.strip()}


def parse_domain_list(text):
    """Admin-edited list: one domain per line (or comma separated). Returns a clean, de-duplicated list."""
    out = []
    for raw in re.split(r"[\s,;]+", (text or "").lower()):
        raw = raw.strip().lstrip("@").rstrip(".")
        if raw and re.match(r"^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(\.\*)?$", raw) and raw not in out:
            out.append(raw.removeprefix("*."))
    return out[:500]


def email_provider_class(canonical_or_domain, extra_blocked=(), extra_shady=(), school=None):
    """Returns (class, points, label). class is 'blocked' (disposable, refused), 'shady' (adds risk points),
    'school' (the school's own domain, lowers risk) or 'normal'. Subdomains and any-TLD patterns are matched."""
    domain = canonical_or_domain.rsplit("@", 1)[-1].lower()
    blocked, shady = bundled_lists()
    for pat in list(blocked) + list(extra_blocked):
        if domain_matches(domain, pat):
            return "blocked", 0, "disposable / temporary email service"
    for pat in (school_domains() if school is None else school):
        if domain_matches(domain, pat):
            return "school", -15, "school email domain"
    best = 0
    for pat, pts in list(shady.items()) + [(p, 15) for p in extra_shady]:
        if domain_matches(domain, pat):
            best = max(best, pts)
    if best:
        return "shady", best, "forwarding / anonymous email service"
    return "normal", 0, ""


# ---------------------------------------------------------------- network

def usable_ip(ip):
    """False for loopback, private and unparseable addresses: they say nothing about who someone is (local development
    and tests, or a proxy's own address)."""
    try:
        a = ipaddress.ip_address((ip or "").strip())
    except ValueError:
        return False
    return not (a.is_loopback or a.is_private or a.is_link_local or a.is_unspecified or a.is_multicast or a.is_reserved)


def net_of(ip):
    """The IPv4 /24 or IPv6 /64 an address sits in, as text."""
    a = ipaddress.ip_address(ip.strip())
    prefix = 24 if a.version == 4 else 64
    return str(ipaddress.ip_network(f"{a}/{prefix}", strict=False))


def ip_in_list(ip, entries):
    """True if `ip` equals, or is inside, any entry (single address or CIDR block) of the admin's 'common networks'."""
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    for e in entries:
        try:
            if a in ipaddress.ip_network(e, strict=False):
                return True
        except ValueError:
            continue
    return False


def parse_network_list(text):
    out = []
    for raw in re.split(r"[\s,;]+", text or ""):
        if not raw:
            continue
        try:
            n = str(ipaddress.ip_network(raw, strict=False))
        except ValueError:
            continue
        if n not in out:
            out.append(n)
    return out[:200]


# ---------------------------------------------------------------- user agent and fingerprint

BOT_MARKERS = ("headlesschrome", "phantomjs", "python-requests", "python-urllib", "curl/", "wget/", "selenium",
               "puppeteer", "playwright", "httpclient", "go-http-client", "okhttp", "scrapy", "node-fetch",
               "axios/", "libwww", "aiohttp", "httpx", "java/", "ghost")


def parse_ua(ua):
    """A small, dependency-free user-agent summary: browser, version, os, device and whether it looks automated."""
    ua = (ua or "")[:400]
    low = ua.lower()
    browser, version = "Unknown", ""
    for name, rx in (("Edge", r"edg(?:e|a|ios)?/([\d.]+)"), ("Opera", r"(?:opr|opera)/([\d.]+)"),
                     ("Samsung Internet", r"samsungbrowser/([\d.]+)"), ("Firefox", r"(?:firefox|fxios)/([\d.]+)"),
                     ("Chrome", r"(?:chrome|crios)/([\d.]+)"), ("Safari", r"version/([\d.]+).*safari")):
        m = re.search(rx, low)
        if m:
            browser, version = name, m.group(1).split(".")[0]
            break
    if "iphone" in low or "ipad" in low or "ipod" in low:
        os_name, device = "iOS", "tablet" if "ipad" in low else "phone"
    elif "android" in low:
        os_name, device = "Android", "phone" if "mobile" in low else "tablet"
    elif "windows" in low:
        os_name, device = "Windows", "desktop"
    elif "cros" in low:
        os_name, device = "ChromeOS", "desktop"
    elif "mac os x" in low or "macintosh" in low:
        os_name, device = "macOS", "desktop"
    elif "linux" in low or "x11" in low:
        os_name, device = "Linux", "desktop"
    else:
        os_name, device = "Unknown", "unknown"
    bot = (not ua) or any(m in low for m in BOT_MARKERS)
    return {"browser": browser, "version": version, "os": os_name, "device": device, "bot": bot,
            "text": f"{browser} {version} on {os_name}".replace("  ", " ") if browser != "Unknown" or os_name != "Unknown"
            else (ua[:60] or "no user agent")}


def _clip(v, n=200):
    return str(v if v is not None else "")[:n]


def _h(*parts):
    return hashlib.sha256("\x1f".join(parts).encode("utf-8", "replace")).hexdigest()[:20]


def fp_digest(raw):
    """Validate the browser fingerprint sent by static/fp.js and reduce it to hashes. Returns None if absent or junk.
    Everything the browser sends can be forged, so it only ever raises or lowers suspicion; it never grants anything."""
    if not raw or len(raw) > 6000:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    canvas, webgl, audio = _clip(data.get("canvas")), _clip(data.get("webgl")), _clip(data.get("audio"))
    fonts = _clip(data.get("fonts"), 400)
    screen, tz, langs = _clip(data.get("screen"), 60), _clip(data.get("tz"), 60), _clip(data.get("langs"), 120)
    platform = _clip(data.get("platform"), 60)
    try:
        touch = max(0, min(int(data.get("touch") or 0), 20))
    except (TypeError, ValueError):
        touch = 0
    hc, dm = _clip(data.get("hc"), 6), _clip(data.get("dm"), 6)
    token = _clip(data.get("token"), 40)
    if not re.fullmatch(r"[0-9a-f]{32}", token):
        token = ""
    parts = {}
    # Empty or absent components are skipped, so "no value" can never link two accounts together.
    if canvas:
        parts["fp_canvas"] = _h("c", canvas)
    if webgl:
        parts["fp_webgl"] = _h("w", webgl)
    if audio:
        parts["fp_audio"] = _h("a", audio)
    if fonts:
        parts["fp_fonts"] = _h("f", fonts)
    combo = [parts.get(k, "") for k in ("fp_canvas", "fp_webgl", "fp_fonts")]
    if all(combo):
        parts["fp_parts"] = _h("p", *combo)
    if canvas and webgl:
        parts["fp"] = _h("full", canvas, webgl, audio, fonts, screen, tz, platform, hc, dm, langs)
    meta = {"tz": tz, "langs": langs, "screen": screen, "platform": platform, "touch": touch,
            "webdriver": bool(data.get("wd")), "hc": hc, "dm": dm}
    return {"parts": parts, "token": token, "meta": meta}


# ---------------------------------------------------------------- usernames

LEET = str.maketrans({"0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i"})
SUFFIXES = ("alt", "alts", "main", "official", "real", "backup", "second", "new", "xx", "xd", "yt", "tv", "gaming")


def username_stem(name):
    s = unicodedata.normalize("NFKC", name or "").lower().translate(LEET)
    s = re.sub(r"[^a-z]", "", s)
    for pre in ("xx", "the", "its", "real", "im"):
        if s.startswith(pre) and len(s) - len(pre) >= 4:
            s = s[len(pre):]
    changed = True
    while changed:
        changed = False
        for suf in SUFFIXES:
            if s.endswith(suf) and len(s) - len(suf) >= 3:
                s, changed = s[:-len(suf)], True
    return s


def levenshtein(a, b):
    if a == b:
        return 0
    if abs(len(a) - len(b)) > 6:
        return max(len(a), len(b))
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def similar(a, b):
    """Similarity from 0 to 1 between two strings."""
    if not a or not b:
        return 0.0
    return 1 - levenshtein(a, b) / max(len(a), len(b))


# ---------------------------------------------------------------- scoring

def level_for(score):
    return "high" if score >= HOLD_THRESHOLD else "medium" if score >= FLAG_THRESHOLD else "low"


def rarity(n):
    """1.0 for a value shared by two accounts, fading to 0 at COMMON_THRESHOLD accounts."""
    if n <= 2:
        return 1.0
    return max(0.0, (COMMON_THRESHOLD - n) / (COMMON_THRESHOLD - 2))


def now():
    return time.time()


def record(db, user_id, username, kind, value, ts=None):
    """Remember that this account was seen with this IP/device/fingerprint value. True if it is a new value for them."""
    if not value:
        return False
    ts = ts or now()
    fresh = db.execute("SELECT 1 FROM sightings WHERE user_id = ? AND kind = ? AND value = ?",
                       (user_id, kind, value)).fetchone() is None
    db.execute(
        "INSERT INTO sightings (user_id, username, kind, value, first_seen, last_seen, hits) VALUES (?, ?, ?, ?, ?, ?, 1) "
        "ON CONFLICT(user_id, kind, value) DO UPDATE SET last_seen = excluded.last_seen, hits = hits + 1, "
        "username = excluded.username", (user_id, username, kind, value, ts, ts))
    return fresh


def prune(db):
    cutoff = now() - SIGNAL_RETENTION_DAYS * 86400
    db.execute("DELETE FROM sightings WHERE last_seen < ?", (cutoff,))
    db.execute("DELETE FROM login_events WHERE created_at < ?", (cutoff,))
    db.execute("DELETE FROM security_events WHERE created_at < ?", (cutoff,))


def email_pool(db):
    """Every account with the mailbox it uses (canonical): the confirmed email, else the one it is still confirming at
    sign-up. Rows are dicts with id, username and email_canonical (None if unknown)."""
    pool = []
    for r in db.execute("SELECT u.id, u.username, u.email_canonical, u.email, u.email_verified, "
                        "(SELECT c.email FROM login_challenges c WHERE c.username = u.username COLLATE NOCASE) AS pending "
                        "FROM users u"):
        canon = r["email_canonical"]
        if not canon and r["email_verified"] and r["email"]:
            canon = normalize_email(r["email"])[1]
        if not canon and r["pending"]:
            canon = normalize_email(r["pending"])[1]
        pool.append({"id": r["id"], "username": r["username"], "email_canonical": canon})
    return pool


def _met_on_common_net(db, a, b, common_nets):
    """True if both accounts were seen from an IP the admins marked as a common network (the school's)."""
    if not common_nets:
        return False
    for r in db.execute("SELECT x.value FROM sightings x JOIN sightings y ON y.kind = 'ip' AND y.value = x.value "
                        "AND y.user_id = ? WHERE x.kind = 'ip' AND x.user_id = ?", (b, a)):
        if ip_in_list(r["value"], common_nets):
            return True
    return False


def _sharers(db, kind, value, user_id):
    return db.execute("SELECT DISTINCT user_id, username FROM sightings WHERE kind = ? AND value = ? AND user_id != ?",
                      (kind, value, user_id)).fetchall()


def _email_of(db, u):
    """The email that counts for scoring: the confirmed one, else the one being confirmed (sign-up)."""
    if u["email_verified"] and u["email"]:
        return u["email"]
    row = db.execute("SELECT email FROM login_challenges WHERE username = ? COLLATE NOCASE", (u["username"],)).fetchone()
    return (row["email"] if row else None) or u["email"]


def compute_risk(db, user_id, users=None, common_nets=(), extra_blocked=(), extra_shady=(), tz_name="America/New_York"):
    """Score one account. Returns a dict:
      score 0-100, level, reasons [(points, kind, text)], links {other_id: {username, deleted, why[]}},
      qualifies (True if there is evidence beyond IP/fingerprint, which holding requires), kinds (set).
    `users` is an optional preloaded `email_pool(db)`, to make a full rescan cheap."""
    u = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if u is None:
        return None
    reasons, links = [], {}
    users = email_pool(db) if users is None else users
    live = {r["id"] for r in users}

    def link(other, name, why):
        e = links.setdefault(other, {"username": name, "deleted": other not in live, "why": []})
        if why not in e["why"]:
            e["why"].append(why)

    ip_left = [IP_BUDGET]

    def add(points, kind, text):
        points = int(round(points))
        if kind in ("ip", "net") and points > 0:  # a shared IP alone must never add up to a flag
            points = min(points, ip_left[0])
            ip_left[0] -= points
            if points <= 0:
                return
        reasons.append((points, kind, text))

    def names(rows, limit=3):
        out = [r["username"] + ("" if r["user_id"] in live else " (deleted)") for r in rows[:limit]]
        return ", ".join(out) + (f" and {len(rows) - limit} more" if len(rows) > limit else "")

    # ---- shared device cookie / localStorage token: the strongest signal
    for sight in db.execute("SELECT value FROM sightings WHERE user_id = ? AND kind = 'device'", (user_id,)).fetchall():
        others = _sharers(db, "device", sight["value"], user_id)
        if others:
            add(min(60, 45 + 10 * (len(others) - 1)), "device", f"Same device as {names(others)}")
            for o in others:
                link(o["user_id"], o["username"], "same device")
            break  # one device signal is enough; the strongest is the first found

    # ---- fingerprint parts (identical laptops on the school's own network don't match each other: see common_nets)
    for kind, max_pts, label in (("fp", 30, "Identical browser fingerprint"),
                                 ("fp_parts", 15, "Same canvas, graphics and fonts")):
        best = None
        for sight in db.execute("SELECT value FROM sightings WHERE user_id = ? AND kind = ?", (user_id, kind)).fetchall():
            others = [o for o in _sharers(db, kind, sight["value"], user_id)
                      if not _met_on_common_net(db, user_id, o["user_id"], common_nets)]
            n = len(others) + 1
            if others and rarity(n) > 0 and (best is None or rarity(n) > best[0]):
                best = (rarity(n), others, n)
        if best:
            add(max_pts * best[0], kind, f"{label} as {names(best[1])}" + (f" ({best[2]} accounts share it)" if best[2] > 2 else ""))
            if best[2] <= 2:
                for o in best[1]:
                    link(o["user_id"], o["username"], "same fingerprint" if kind == "fp" else "same graphics/fonts")

    # ---- IP and network (rarity-weighted, and not on admin's "common networks" list)
    for kind, max_pts, label in (("ip", 15, "Same IP address as"), ("net", 5, "Same network as")):
        best = None
        for sight in db.execute("SELECT value FROM sightings WHERE user_id = ? AND kind = ?", (user_id, kind)).fetchall():
            if ip_in_list(sight["value"].split("/")[0], common_nets):
                continue
            others = _sharers(db, kind, sight["value"], user_id)
            n = len(others) + 1
            if others and rarity(n) > 0 and (best is None or rarity(n) > best[0]):
                best = (rarity(n), others, n)
        if best:
            add(max_pts * best[0], kind, f"{label} {names(best[1])}" + (f" ({best[2]} accounts)" if best[2] > 2 else ""))
            if kind == "ip" and best[2] <= 2:
                for o in best[1]:
                    link(o["user_id"], o["username"], "same IP")

    # ---- sign-up timing and velocity
    signup = db.execute("SELECT * FROM login_events WHERE user_id = ? AND event = 'signup' ORDER BY id LIMIT 1",
                        (user_id,)).fetchone()
    if signup:
        t = signup["created_at"]
        if signup["ip"] and usable_ip(signup["ip"]) and not ip_in_list(signup["ip"], common_nets):
            close = db.execute("SELECT DISTINCT username FROM login_events WHERE event = 'signup' AND ip = ? AND user_id != ? "
                               "AND ABS(created_at - ?) < 1800", (signup["ip"], user_id, t)).fetchall()
            if close:
                add(10 * rarity(len(close) + 1), "ip",
                    f"Signed up within 30 minutes of {', '.join(r['username'] for r in close[:3])} from the same IP")
            ipn = db.execute("SELECT COUNT(DISTINCT COALESCE(user_id, username)) FROM login_events WHERE event = 'signup' "
                             "AND ip = ? AND ABS(created_at - ?) < 86400", (signup["ip"], t)).fetchone()[0]
            if ipn >= VELOCITY_LIMIT:  # fades as the IP gets crowded: a busy school network isn't an alt farm
                add(20 * rarity(ipn), "ip", f"{ipn} accounts created from this IP within a day")
        if signup["device_id"]:
            dn = db.execute("SELECT COUNT(DISTINCT COALESCE(user_id, username)) FROM login_events WHERE event = 'signup' "
                            "AND device_id = ? AND ABS(created_at - ?) < 86400", (signup["device_id"], t)).fetchone()[0]
            if dn >= VELOCITY_LIMIT:
                add(20, "velocity", f"{dn} accounts created on this device within a day")

    # ---- user agent / fingerprint sanity
    fp_meta = {}
    if signup is not None:
        try:
            fp_meta = json.loads(signup["fp_json"] or "{}")
        except ValueError:
            fp_meta = {}
    ua = parse_ua(signup["ua"] if signup is not None else "")
    if signup is not None:
        if ua["bot"] or fp_meta.get("webdriver"):
            add(35, "bot", "Automated browser (" + ("webdriver flag" if fp_meta.get("webdriver") else ua["text"]) + ")")
        if fp_meta.get("captcha") == "unreachable":
            add(10, "captcha", "Human check (Cloudflare Turnstile) couldn't run at sign-up, so the sign-up wasn't verified")
        if not signup["fp_hash"]:
            add(10, "nofp", "No browser fingerprint at sign-up (JavaScript off or scripted)")
        elif fp_meta:
            plat, touch = (fp_meta.get("platform") or "").lower(), fp_meta.get("touch") or 0
            mismatch = ((ua["os"] in ("iOS", "Android") and (plat.startswith(("win", "mac", "linux x86")) or touch == 0))
                        or (ua["os"] == "Windows" and plat and not plat.startswith("win"))
                        or (ua["os"] == "macOS" and plat and not plat.startswith(("mac", "iphone", "ipad")))
                        or (ua["os"] == "Linux" and plat.startswith(("win", "mac"))))
            if mismatch:
                add(15, "ua_mismatch", f"Browser claims {ua['os']} but reports platform “{fp_meta.get('platform')}”")
            tz = fp_meta.get("tz")
            if tz and _tz_far(tz, tz_name):
                add(5, "tz", f"Timezone {tz} is far from the school's")

    # ---- email
    email = _email_of(db, u)
    _, canon = normalize_email(email) if email else (None, None)
    if canon:
        local, domain = email_parts(canon)
        cls, pts, label = email_provider_class(domain, extra_blocked, extra_shady)
        if cls == "blocked":
            add(40, "email", f"Email domain {domain}: {label}")
        elif cls == "shady":
            add(pts, "email", f"Email domain {domain}: {label}")
        elif cls == "school":
            add(pts, "email", f"Email is on the school domain {domain}")
        pool = users if users is not None else email_pool(db)
        flagged_email = False
        for o in pool:
            if o["id"] == user_id or not o["email_canonical"]:
                continue
            olocal, odomain = email_parts(o["email_canonical"])
            if o["email_canonical"] == canon:
                add(60, "email", f"Shares an email with {o['username']}")
                link(o["id"], o["username"], "same email")
                flagged_email = True
            elif olocal == local and len(local) >= 4 and not flagged_email:
                add(20, "email", f"Same email name as {o['username']} ({olocal}@…)")
                link(o["id"], o["username"], "same email name")
                flagged_email = True
            elif (len(local) >= 5 and re.sub(r"\d+", "", olocal) == re.sub(r"\d+", "", local) != ""
                  and olocal != local and not flagged_email):
                add(10, "email", f"Email name only differs by digits from {o['username']}'s")
                link(o["id"], o["username"], "similar email")
                flagged_email = True

    # ---- username similarity
    stem = username_stem(u["username"])
    if len(stem) >= 3:
        pool = users if users is not None else email_pool(db)
        hit = None
        for o in pool:
            if o["id"] == user_id:
                continue
            ostem = username_stem(o["username"])
            if len(ostem) < 3:
                continue
            if ostem == stem:
                pts = 15 if o["id"] in links else 5
                if hit is None or pts > hit[0]:
                    hit = (pts, o, "same name apart from digits or a suffix")
            elif len(stem) >= 5 and abs(len(stem) - len(ostem)) <= 2 and similar(stem, ostem) >= 0.8:
                pts = 10 if o["id"] in links else 3
                if hit is None or pts > hit[0]:
                    hit = (pts, o, "very similar name")
        if hit:
            add(hit[0], "username", f"Username {hit[2]} to {hit[1]['username']}")
            if hit[0] >= 10:
                link(hit[1]["id"], hit[1]["username"], "similar username")

    # ---- behaviour with linked accounts
    ids = [i for i in links if i in live]
    if ids:
        marks = ",".join("?" * len(ids))
        loans = db.execute(
            f"SELECT l.*, a.username AS lname, b.username AS bname FROM loans l "
            f"LEFT JOIN users a ON a.id = l.lender_id LEFT JOIN users b ON b.id = l.borrower_id "
            f"WHERE l.status != 'cancelled' AND l.status != 'declined' AND "
            f"((l.lender_id = ? AND l.borrower_id IN ({marks})) OR (l.borrower_id = ? AND l.lender_id IN ({marks})))",
            [user_id, *ids, user_id, *ids]).fetchall()
        if loans:
            odd = sum(1 for l in loans if l["rate"] == 0 or l["status"] == "active")
            other = loans[0]["bname"] if loans[0]["lender_id"] == user_id else loans[0]["lname"]
            add(25, "behaviour", f"{len(loans)} loan{'s' if len(loans) != 1 else ''} with linked account {other}"
                + (" (0% or unpaid)" if odd else ""))
            link(next(i for i in ids if i in (loans[0]["lender_id"], loans[0]["borrower_id"])), other, "loans between them")
        paid = db.execute(f"SELECT creator_id, COUNT(*) AS n FROM market_entries WHERE user_id = ? GROUP BY creator_id",
                          (user_id,)).fetchall()
        total = sum(r["n"] for r in paid)
        to_linked = sum(r["n"] for r in paid if r["creator_id"] in ids)
        if total >= 2 and to_linked * 2 >= total:
            add(15, "behaviour", f"{to_linked} of {total} entry fees went to linked accounts' markets")
        recv = db.execute(f"SELECT user_id, COUNT(*) AS n FROM market_entries WHERE creator_id = ? AND user_id != ? "
                          f"GROUP BY user_id", (user_id, user_id)).fetchall()
        rtotal = sum(r["n"] for r in recv)
        rlinked = sum(r["n"] for r in recv if r["user_id"] in ids)
        if rtotal >= 2 and rlinked * 2 >= rtotal:
            add(15, "behaviour", f"{rlinked} of {rtotal} entry fees on their markets came from linked accounts")
    lent = db.execute("SELECT COUNT(*) FROM loans WHERE lender_id = ? AND status IN ('active', 'repaid')", (user_id,)).fetchone()[0]
    if lent and not db.execute("SELECT 1 FROM trades WHERE user_id = ? LIMIT 1", (user_id,)).fetchone() and ids:
        add(10, "behaviour", "Never traded, but lends money to a linked account")

    score = max(0, min(100, sum(p for p, _, _ in reasons)))
    kinds = {k for p, k, _ in reasons if p > 0}
    return {"score": score, "level": level_for(score), "reasons": sorted(reasons, key=lambda r: -r[0]),
            "links": links, "kinds": kinds, "qualifies": bool(kinds - WEAK_KINDS)}


def _tz_far(client_tz, home_tz):
    try:
        from zoneinfo import ZoneInfo
        n = datetime.now()
        a = ZoneInfo(client_tz).utcoffset(n.replace(tzinfo=ZoneInfo(client_tz)))
        b = ZoneInfo(home_tz).utcoffset(n.replace(tzinfo=ZoneInfo(home_tz)))
        return abs((a - b).total_seconds()) > 3 * 3600
    except Exception:
        return False
