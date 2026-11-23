import json
import os
import sqlite3
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import make_roster  # noqa: E402


def _db(path, names):
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE)")
    db.executemany("INSERT INTO users (username) VALUES (?)", [(n,) for n in names])
    db.commit()
    db.close()


def test_roster_from_db_and_csv(tmp_path):
    _db(tmp_path / "m.db", ["Kaushik", "kp123", "Dana Smith"])
    (tmp_path / "p.csv").write_text("Name,Email\nkaushik,k@example.com\nNew Kid,new@example.com\n"
                                    "No Mail,\nDana Smith,dana@example.com\n")
    entries, r = make_roster.build(str(tmp_path / "m.db"), str(tmp_path / "p.csv"))
    by = {e["name"]: e["email"] for e in entries}
    assert set(by) == {"Kaushik", "kp123", "Dana Smith", "New Kid", "No Mail"}   # existing usernames kept exactly
    assert by["Kaushik"] == "k@example.com" and by["Dana Smith"] == "dana@example.com"
    assert by["kp123"].endswith("@no-email.invalid")
    assert r["placeholder"] == ["kp123"] and r["no_way_in"] == ["No Mail"] and r["has_owner"]
    assert len({e["email"].casefold() for e in entries}) == len(entries)


def test_script_output_loads_in_the_site(tmp_path):
    _db(tmp_path / "m.db", ["Kaushik", "kp123"])
    out = tmp_path / "roster.json"
    run = lambda *a: subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "make_roster.py"),
                                     "--db", str(tmp_path / "m.db"), "--out", str(out), *a],
                                    capture_output=True, text=True)
    assert run().returncode == 0
    assert run().returncode != 0 and "--force" in run().stderr   # won't overwrite by accident
    env = dict(os.environ, MAMS_USER_DIRECTORY_FILE=str(out), MAMS_DB=str(tmp_path / "site.db"))
    check = subprocess.run([sys.executable, "-c", "import app; print(len(app.load_login_directory()))"],
                           cwd=ROOT, env=env, capture_output=True, text=True)
    assert check.stdout.strip() == "2", check.stderr
    assert {e["name"] for e in json.loads(out.read_text())} == {"Kaushik", "kp123"}


def test_export_csv_then_build(tmp_path):
    _db(tmp_path / "m.db", ["kp123", "Kaushik", "Zoë Ng"])
    csv_path = tmp_path / "people.csv"
    script = os.path.join(ROOT, "scripts", "make_roster.py")
    out = subprocess.run([sys.executable, script, "--db", str(tmp_path / "m.db"), "--export-csv", str(csv_path)],
                         capture_output=True, text=True)
    assert out.returncode == 0 and "Wrote 3 usernames" in out.stdout
    text = csv_path.read_text(encoding="utf-8-sig")
    assert text.splitlines() == ["name,email", "Kaushik,", "kp123,", "Zoë Ng,"]
    # fill it in like a person would, add someone new, and build the roster from it
    csv_path.write_text(text.replace("Kaushik,", "Kaushik,k@example.com") + "New Kid,new@example.com\n",
                        encoding="utf-8-sig")
    entries, r = make_roster.build(str(tmp_path / "m.db"), str(csv_path))
    by = {e["name"]: e["email"] for e in entries}
    assert by["Kaushik"] == "k@example.com" and by["New Kid"] == "new@example.com" and len(by) == 4
    assert r["from_csv"] == 1 and not r["no_way_in"]
