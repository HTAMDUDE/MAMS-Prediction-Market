"""Build instance/login_roster.json (the private login list) from the existing accounts.

Every username already in the database goes on the roster, so nobody is locked out of their account. Optionally
merge a CSV of real names and emails (columns: name,email) for people who haven't signed up yet and to give existing
users their email addresses.

Existing users without an email get a placeholder address ending in .invalid, which can never receive mail. That's
fine: people who already have an account log in with their password and are never sent a code.

Usage (from the project folder):
    python scripts/make_roster.py --export-csv people.csv  # 1. write every username to a CSV, emails blank
    (fill in the emails and add rows for people without an account, e.g. in Google Sheets or Excel)
    python scripts/make_roster.py --emails people.csv      # 2. build the roster from the database + that CSV
    python scripts/make_roster.py                          # or: usernames from the database only
Add --force to replace an existing roster file. The roster holds names and emails: never commit it.
"""

import argparse
import csv
import json
import os
import re
import sqlite3
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EMAIL_RE = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
OWNER = "Kaushik"


def placeholder(name, taken):
    slug = re.sub(r"[^a-z0-9]+", ".", name.casefold()).strip(".") or "user"
    email, n = f"{slug}@no-email.invalid", 2
    while email.casefold() in taken:
        email, n = f"{slug}.{n}@no-email.invalid", n + 1
    return email


def build(db_path, csv_path=None):
    """Returns (entries, report). entries is the JSON list the site expects."""
    db = sqlite3.connect(db_path)
    usernames = [r[0] for r in db.execute("SELECT username FROM users ORDER BY id")]
    cols = {r[1] for r in db.execute("PRAGMA table_info(users)")}
    db_emails = {}
    if "email" in cols:
        db_emails = {r[0].casefold(): r[1].strip() for r in db.execute("SELECT username, email FROM users")
                     if r[1] and EMAIL_RE.fullmatch(r[1].strip())}
    db.close()

    csv_rows = []
    if csv_path:
        with open(csv_path, newline="", encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                row = {k.strip().lower(): (v or "").strip() for k, v in row.items() if k}
                if row.get("name"):
                    csv_rows.append((row["name"], row.get("email", "")))

    report = {"from_db": 0, "from_csv": 0, "placeholder": [], "no_way_in": [], "bad_csv_email": [],
              "duplicate_email": []}
    has_account = {u.casefold() for u in usernames}
    entries, by_key, emails = [], {}, set()

    def add(name, email):
        key = name.casefold()
        if key in by_key:                       # already listed: fill in a real email if we didn't have one
            entry = by_key[key]
            if email and (not entry["email"] or entry["email"].endswith(".invalid")) and email.casefold() not in emails:
                emails.discard(entry["email"].casefold())
                entry["email"] = email
                emails.add(email.casefold())
            return False
        entry = {"name": name, "email": email}
        entries.append(entry)
        by_key[key] = entry
        if email:
            emails.add(email.casefold())
        return True

    for u in usernames:                         # existing accounts keep their exact username
        add(u, db_emails.get(u.casefold(), ""))
        report["from_db"] += 1
    for name, email in csv_rows:
        if email and not EMAIL_RE.fullmatch(email):
            report["bad_csv_email"].append(name)
            email = ""
        if email and email.casefold() in emails and by_key.get(name.casefold(), {}).get("email", "").casefold() != email.casefold():
            report["duplicate_email"].append(name)
            email = ""
        if add(name, email):
            report["from_csv"] += 1
    for entry in entries:                       # anyone still without an email gets a placeholder
        if not entry["email"]:
            entry["email"] = placeholder(entry["name"], emails)
            emails.add(entry["email"].casefold())
            # with an account they log in by password; without one the code can't reach them
            report["placeholder" if entry["name"].casefold() in has_account else "no_way_in"].append(entry["name"])
    report["has_owner"] = OWNER.casefold() in by_key
    return entries, report


def export_csv(db_path, csv_path):
    """Write every existing username (and email, if the database has one) to a name,email CSV. Returns the count."""
    db = sqlite3.connect(db_path)
    cols = {r[1] for r in db.execute("PRAGMA table_info(users)")}
    query = "SELECT username, email FROM users ORDER BY username COLLATE NOCASE" if "email" in cols \
        else "SELECT username, '' FROM users ORDER BY username COLLATE NOCASE"
    rows = [(name, (email or "").strip()) for name, email in db.execute(query)]
    db.close()
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:  # utf-8-sig so Excel shows accents correctly
        w = csv.writer(f)
        w.writerow(["name", "email"])
        w.writerows(rows)
    return len(rows)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=os.environ.get("MAMS_DB", os.path.join(BASE_DIR, "instance", "mams.db")))
    ap.add_argument("--emails", help="CSV with columns name,email")
    ap.add_argument("--out", default=os.path.join(BASE_DIR, "instance", "login_roster.json"))
    ap.add_argument("--force", action="store_true", help="replace an existing roster or CSV file")
    ap.add_argument("--export-csv", metavar="CSV", help="write existing usernames to a name,email CSV and stop")
    args = ap.parse_args()
    if not os.path.exists(args.db):
        sys.exit(f"No database at {args.db}")
    if args.export_csv:
        if os.path.exists(args.export_csv) and not args.force:
            sys.exit(f"{args.export_csv} already exists. Add --force to replace it.")
        n = export_csv(args.db, args.export_csv)
        print(f"Wrote {n} usernames to {args.export_csv}. Fill in the email column (keep each name exactly as it is),")
        print("add a row for anyone who doesn't have an account yet, then run:")
        print(f"    python3 scripts/make_roster.py --emails {args.export_csv}")
        return
    if os.path.exists(args.out) and not args.force:
        sys.exit(f"{args.out} already exists. Add --force to replace it.")
    entries, r = build(args.db, args.emails)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(entries, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"Wrote {len(entries)} names to {args.out}")
    print(f"  {r['from_db']} existing accounts, {r['from_csv']} new names from the CSV")
    if r["placeholder"]:
        print(f"  {len(r['placeholder'])} existing accounts without an email (fine: they log in with their password): "
              + ", ".join(r["placeholder"]))
    if r["no_way_in"]:
        print(f"  WARNING: {len(r['no_way_in'])} new names have no valid email, so they can't get a login code. "
              "Fix their emails in the CSV and run again: " + ", ".join(r["no_way_in"]))
    for key, label in (("bad_csv_email", "invalid email in CSV"), ("duplicate_email", "email already used")):
        if r[key]:
            print(f"  Skipped email ({label}): " + ", ".join(r[key]))
    if not r["has_owner"]:
        print(f"  WARNING: nobody named '{OWNER}' is on the roster, so the owner account can't log in.")


if __name__ == "__main__":
    main()
