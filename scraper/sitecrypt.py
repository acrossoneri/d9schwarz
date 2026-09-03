#!/usr/bin/env python3
"""
Password-based encryption for the site's data files.

The site is static (GitHub Pages) — there is no server that could check a
password, so a login form alone would be decoration: anyone could just open
data/matches.json directly. Instead the data files ARE the secret: they are
stored as AES-256-GCM ciphertext and the browser decrypts them after login.

Several accounts share one set of files, so the files are encrypted with a
random MASTER key, and every account stores that master key wrapped under a key
derived from its own password (PBKDF2-HMAC-SHA256). Logging in = unwrapping the
master key. Adding or removing an account never re-encrypts the data.

  data/auth.json          public, but leaks nothing:
                            users: { <sha256(name)>: {
                              salt,          # for this account's PBKDF2
                              iv, ct,        # master key wrapped under the account key
                              meta: {iv,ct}  # {user, role} encrypted under the MASTER key
                            }}
                          The name and role sit in `meta` rather than in the
                          account's own blob, so an admin (who holds the master
                          key) can list accounts and change a role without
                          knowing anyone's password.
  data/<name>.enc.json    {"v":1,"updated":"...","iv":"...","ct":"..."}

Credentials come from $SITE_USER / $SITE_PASSWORD, otherwise it prompts.

Usage:
  python scraper/sitecrypt.py init                 # first account + encrypt data/*.json
  ROLE=viewer ... init                             # role of that first account
  NEW_USER=admin NEW_PASSWORD=... NEW_ROLE=admin \
      python scraper/sitecrypt.py adduser          # needs an existing admin
  python scraper/sitecrypt.py passwd <name>        # NEW_PASSWORD=... reset a password
  python scraper/sitecrypt.py role <name> <role>   # admin | viewer
  python scraper/sitecrypt.py deluser <name>
  python scraper/sitecrypt.py users                # list accounts and roles
  python scraper/sitecrypt.py show matches         # print the decrypted payload
  python scraper/sitecrypt.py put config x.json    # encrypt x.json -> config.enc.json
"""
import base64
import getpass
import hashlib
import hmac
import json
import os
import secrets
import sys
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
AUTH_FILE = DATA / "auth.json"

AUTH_VERSION = 3
ITERATIONS = 310_000          # OWASP-recommended floor for PBKDF2-HMAC-SHA256
KEY_LEN = 32                  # AES-256
IV_LEN = 12                   # GCM standard nonce
SALT_LEN = 16
ROLES = ("admin", "viewer")

# scorers.enc.json holds manually entered goal scorers, lineups.enc.json our own
# Aufstellung per game. The scraper never writes either, so a scrape can never wipe
# hand-entered data.
# admin.enc.json holds the GitHub token the Einstellungen page publishes with, so
# admins don't have to paste it on every device. Encrypted, because a plaintext
# token in a public repo gets revoked by GitHub's secret scanning within minutes.
ENCRYPTED = ("config", "matches", "standings", "scorers", "players", "lineups",
             "friendlies", "admin")

BAD_CREDS = "ERROR: unknown username or wrong password."


def b64e(b):
    return base64.b64encode(b).decode()


def b64d(s):
    return base64.b64decode(s)


def enc_path(name):
    return DATA / f"{name}.enc.json"


# ---------- accounts ----------

def user_id(username):
    """Public index for an account. A hash, so auth.json does not leak who has
    access — while still letting the browser find its own entry."""
    return hashlib.sha256(username.strip().lower().encode("utf-8")).hexdigest()[:32]


def derive_user_key(username, password, salt, iterations=ITERATIONS):
    """Both the username and the password go into the KDF, so both must match."""
    material = f"{username.strip().lower()}:{password}".encode("utf-8")
    return hashlib.pbkdf2_hmac("sha256", material, salt, iterations, KEY_LEN)


def _seal(key, plaintext):
    iv = secrets.token_bytes(IV_LEN)
    return {"iv": b64e(iv), "ct": b64e(AESGCM(key).encrypt(iv, plaintext, None))}


def _open(key, blob):
    return decrypt_bytes(key, b64d(blob["iv"]), b64d(blob["ct"]))


def wrap_master(user_key, master):
    return _seal(user_key, master)


def unwrap_master(user_key, entry):
    return _open(user_key, entry)


def seal_meta(master, username, role):
    """Name and role, readable by anyone holding the master key — i.e. by an
    admin managing accounts, but not by the public."""
    return _seal(master, json.dumps({"user": username, "role": role},
                                    separators=(",", ":")).encode())


def open_meta(master, entry):
    try:
        m = json.loads(_open(master, entry["meta"]))
        return m.get("user", "?"), (m.get("role") if m.get("role") in ROLES else "viewer")
    except Exception:
        return "?", "viewer"


def add_account(cfg, username, password, role, master):
    if role not in ROLES:
        sys.exit(f"ERROR: role must be one of {', '.join(ROLES)}.")
    username = username.strip()
    if not username:
        sys.exit("ERROR: username must not be empty.")
    salt = secrets.token_bytes(SALT_LEN)
    key = derive_user_key(username, password, salt, cfg["iterations"])
    cfg["users"][user_id(username)] = {
        "salt": b64e(salt),
        **wrap_master(key, master),
        "meta": seal_meta(master, username, role),
    }


def admin_count(cfg, master):
    return sum(1 for e in cfg["users"].values() if open_meta(master, e)[1] == "admin")


def credentials():
    user = os.environ.get("SITE_USER")
    pw = os.environ.get("SITE_PASSWORD")
    if not (user and pw) and not sys.stdin.isatty():
        # e.g. GitHub Actions with the secrets unset — say so instead of
        # dying on an EOF from a prompt nobody can answer.
        sys.exit("ERROR: SITE_USER / SITE_PASSWORD are not set (repository secrets?).")
    user = user or input("Benutzername: ")
    pw = pw or getpass.getpass("Passwort: ")
    if not (user and pw):
        sys.exit("ERROR: SITE_USER / SITE_PASSWORD missing.")
    return user, pw


def load_auth():
    if not AUTH_FILE.exists():
        sys.exit("ERROR: data/auth.json missing — run `python scraper/sitecrypt.py init` first.")
    cfg = json.loads(AUTH_FILE.read_text(encoding="utf-8"))
    if cfg.get("v") != AUTH_VERSION:
        sys.exit(f"ERROR: data/auth.json is v{cfg.get('v')}, this tool expects "
                 f"v{AUTH_VERSION}.")
    return cfg


def save_auth(cfg):
    AUTH_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n",
                         encoding="utf-8")


def unlock():
    """Log in and return (master_key, role)."""
    cfg = load_auth()
    user, pw = credentials()
    entry = cfg["users"].get(user_id(user))
    if not entry:
        sys.exit(BAD_CREDS)
    key = derive_user_key(user, pw, b64d(entry["salt"]), cfg["iterations"])
    try:
        master = unwrap_master(key, entry)
    except Exception:
        sys.exit(BAD_CREDS)
    return master, open_meta(master, entry)[1]


def unlock_admin():
    master, role = unlock()
    if role != "admin":
        sys.exit("ERROR: this account is not an admin.")
    return master


# ---------- encryption ----------

def _iv_for(key, plaintext):
    """Deterministic nonce (SIV-style): identical content always encrypts to
    identical bytes, so an unchanged hourly scrape produces no git diff and no
    commit. It is keyed, so nobody without the key can recompute the nonce to
    confirm a guessed plaintext. Distinct content gives a distinct nonce, which
    is what GCM requires."""
    return hmac.new(key, plaintext, hashlib.sha256).digest()[:IV_LEN]


def encrypt_bytes(key, plaintext):
    iv = _iv_for(key, plaintext)
    return iv, AESGCM(key).encrypt(iv, plaintext, None)


def decrypt_bytes(key, iv, ct):
    return AESGCM(key).decrypt(iv, ct, None)


def canonical(payload):
    return json.dumps(payload, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


def write_encrypted(name, key, payload, updated):
    """Encrypt `payload` (a dict WITHOUT 'updated') into data/<name>.enc.json.

    'updated' stays in the clear next to the ciphertext: it is just a scrape
    timestamp, and keeping it outside means we can tell an unchanged run from a
    changed one without holding the key — same no-churn behaviour as before."""
    path = enc_path(name)
    iv, ct = encrypt_bytes(key, canonical(payload))
    env = {"v": 1, "updated": updated, "iv": b64e(iv), "ct": b64e(ct)}
    if path.exists():
        try:
            old = json.loads(path.read_text(encoding="utf-8"))
            if old.get("ct") == env["ct"]:
                env["updated"] = old.get("updated", updated)
        except Exception:
            pass
    path.write_text(json.dumps(env, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return env


def read_encrypted(name, key):
    env = json.loads(enc_path(name).read_text(encoding="utf-8"))
    payload = json.loads(decrypt_bytes(key, b64d(env["iv"]), b64d(env["ct"])))
    if env.get("updated"):
        payload["updated"] = env["updated"]
    return payload


# ---------- CLI ----------

def cmd_init():
    if AUTH_FILE.exists():
        sys.exit("ERROR: data/auth.json already exists — use `adduser`, or delete "
                 "it to start over (that re-encrypts everything).")
    user, pw = credentials()
    role = os.environ.get("ROLE", "admin")
    master = secrets.token_bytes(KEY_LEN)
    cfg = {"v": AUTH_VERSION, "kdf": "PBKDF2", "hash": "SHA-256",
           "iterations": ITERATIONS, "users": {}}
    add_account(cfg, user, pw, role, master)
    save_auth(cfg)
    print(f"created {AUTH_FILE.relative_to(ROOT)} with '{user}' as {role}")

    for name in ENCRYPTED:
        plain = DATA / f"{name}.json"
        if plain.exists():
            payload = json.loads(plain.read_text(encoding="utf-8"))
            updated = payload.pop("updated", None)
            write_encrypted(name, master, payload, updated)
            print(f"{name}: encrypted -> {enc_path(name).name}  "
                  f"(now delete/untrack data/{name}.json)")
        elif not enc_path(name).exists():
            write_encrypted(name, master, {}, None)
            print(f"{name}: created empty {enc_path(name).name}")


def cmd_adduser():
    master = unlock_admin()
    cfg = load_auth()
    user = os.environ.get("NEW_USER")
    pw = os.environ.get("NEW_PASSWORD")
    role = os.environ.get("NEW_ROLE", "viewer")
    if not (user and pw):
        sys.exit("ERROR: set NEW_USER and NEW_PASSWORD.")
    if user_id(user) in cfg["users"]:
        sys.exit(f"ERROR: '{user}' already exists — deluser first to change the password.")
    add_account(cfg, user, pw, role, master)
    save_auth(cfg)
    print(f"added '{user}' as {role} ({len(cfg['users'])} accounts)")


def cmd_passwd(user):
    master = unlock_admin()
    cfg = load_auth()
    entry = cfg["users"].get(user_id(user))
    if not entry:
        sys.exit(f"ERROR: no account '{user}'.")
    pw = os.environ.get("NEW_PASSWORD") or getpass.getpass(f"Neues Passwort für {user}: ")
    if not pw:
        sys.exit("ERROR: empty password.")
    role = open_meta(master, entry)[1]
    add_account(cfg, user, pw, role, master)   # same id, fresh salt and wrapping
    save_auth(cfg)
    print(f"password for '{user}' reset (role stays {role}). Their open sessions "
          "keep working until they expire.")


def cmd_role(user, role):
    master = unlock_admin()
    cfg = load_auth()
    entry = cfg["users"].get(user_id(user))
    if not entry:
        sys.exit(f"ERROR: no account '{user}'.")
    if role not in ROLES:
        sys.exit(f"ERROR: role must be one of {', '.join(ROLES)}.")
    was = open_meta(master, entry)[1]
    if was == "admin" and role != "admin" and admin_count(cfg, master) == 1:
        sys.exit("ERROR: that is the only admin — promote someone else first.")
    # Only `meta` changes: the account's own wrapped key is untouched, so this
    # works without knowing their password.
    entry["meta"] = seal_meta(master, user, role)
    save_auth(cfg)
    print(f"'{user}': {was} -> {role}")


def cmd_deluser(user):
    master = unlock_admin()
    cfg = load_auth()
    entry = cfg["users"].get(user_id(user))
    if not entry:
        sys.exit(f"ERROR: no account '{user}'.")
    if len(cfg["users"]) == 1:
        sys.exit("ERROR: refusing to remove the last account.")
    if open_meta(master, entry)[1] == "admin" and admin_count(cfg, master) == 1:
        sys.exit("ERROR: that is the only admin — promote someone else first.")
    del cfg["users"][user_id(user)]
    save_auth(cfg)
    print(f"removed '{user}' ({len(cfg['users'])} accounts left).\n"
          "NOTE: their old password still opens the ciphertext in git history. To cut "
          "them off completely, delete data/auth.json and re-init (new master key).")


def cmd_users():
    master, role = unlock()
    cfg = load_auth()
    print(f"you are: {role}")
    for uid, entry in cfg["users"].items():
        name, r = open_meta(master, entry)
        print(f"  {name:<20} {r:<7} {uid}")


def cmd_show(name):
    master, _ = unlock()
    print(json.dumps(read_encrypted(name, master), ensure_ascii=False, indent=2))


def cmd_put(name, src):
    master = unlock_admin()
    payload = json.loads(Path(src).read_text(encoding="utf-8"))
    updated = payload.pop("updated", None)
    write_encrypted(name, master, payload, updated)
    print(f"{name}: encrypted -> {enc_path(name).name}")


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    cmd = args[0]
    if cmd == "init" and len(args) == 1:
        cmd_init()
    elif cmd == "adduser" and len(args) == 1:
        cmd_adduser()
    elif cmd == "passwd" and len(args) == 2:
        cmd_passwd(args[1])
    elif cmd == "role" and len(args) == 3:
        cmd_role(args[1], args[2])
    elif cmd == "deluser" and len(args) == 2:
        cmd_deluser(args[1])
    elif cmd == "users" and len(args) == 1:
        cmd_users()
    elif cmd == "show" and len(args) == 2:
        cmd_show(args[1])
    elif cmd == "put" and len(args) == 3:
        cmd_put(args[1], args[2])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
