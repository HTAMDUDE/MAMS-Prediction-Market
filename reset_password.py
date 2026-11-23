"""Give a user a temporary password: python reset_password.py <username>

Use this if the owner (or anyone) is locked out. Prints the new password; the user can change it on their
Portfolio page. Run it with the same MAMS_DB as the site, and restart nothing: it takes effect immediately.
"""
import sys

import app as appmod


def main(argv):
    if len(argv) != 2:
        print("usage: python reset_password.py <username>")
        return 2
    db = appmod.connect()
    u = db.execute("SELECT id, username FROM users WHERE username = ?", (argv[1],)).fetchone()
    if u is None:
        print(f"No user named {argv[1]!r}.")
        return 1
    pw = appmod.set_temporary_password(db, u["id"])
    print(f"Temporary password for {u['username']}: {pw}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
