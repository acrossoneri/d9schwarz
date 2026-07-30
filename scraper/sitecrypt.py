#!/usr/bin/env python3
"""
Password-based encryption for the site's data files.

The site is static (GitHub Pages) — there is no server that could check a
password, so a login form alone would be decoration: anyone could just open
data/matches.json directly. Instead the data files ARE the secret: they are
stored as AES-256-GCM ciphertext and the browser decrypts them after login
with a key derived from the password. No password, no readable data.

  data/auth.json          public: KDF salt/iterations + a check blob
  data/<name>.enc.json    {"v":1,"updated":"...","iv":"...","ct":"..."}

Credentials come from $SITE_USER / $SITE_PASSWORD, otherwise it prompts.

Usage:
  python scraper/sitecrypt.py init            # create auth.json, encrypt data/*.json
  python scraper/sitecrypt.py show matches    # print the decrypted payload
  python scraper/sitecrypt.py put config x.json   # encrypt x.json -> data/config.enc.json
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

ITERATIONS = 310_000          # OWASP-recommended floor for PBKDF2-HMAC-SHA256
KEY_LEN = 32                  # AES-256
IV_LEN = 12                   # GCM standard nonce
SALT_LEN = 16
CHECK_TOKEN = b"acrossoneri-d9"

ENCRYPTED = ("config", "matches", "standings")


def b64e(b):
    return base64.b64encode(b).decode()


def b64d(s):
    return base64.b64decode(s)


def enc_path(name):
    return DATA / f"{name}.enc.json"


# ---------- key derivation ----------

def derive_key(username, password, salt, iterations=ITERATIONS):
    """Both the username and the password go into the KDF, so both must match."""
    material = f"{username.strip().lower()}:{password}".encode("utf-8")
    return hashlib.pbkdf2_hmac("sha256", material, salt, iterations, KEY_LEN)


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


def _canonical(payload):
    return json.dumps(payload, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


def write_encrypted(name, key, payload, updated):
    """Encrypt `payload` (a dict WITHOUT 'updated') into data/<name>.enc.json.

    'updated' stays in the clear next to the ciphertext: it is just a scrape
    timestamp, and keeping it outside means we can tell an unchanged run from a
    changed one without holding the key — same no-churn behaviour as before."""
    path = enc_path(name)
    iv, ct = encrypt_bytes(key, _canonical(payload))
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


# ---------- auth.json ----------

def load_or_create_auth(username, password):
    """Return (config, key). The salt is created once and then reused, so
    re-encrypting the same content stays byte-identical."""
    if AUTH_FILE.exists():
        cfg = json.loads(AUTH_FILE.read_text(encoding="utf-8"))
        key = derive_key(username, password, b64d(cfg["salt"]), cfg["iterations"])
        try:
            if decrypt_bytes(key, b64d(cfg["check"]["iv"]), b64d(cfg["check"]["ct"])) != CHECK_TOKEN:
                raise ValueError
        except Exception:
            sys.exit("ERROR: wrong username/password for the existing data/auth.json.\n"
                     "       Delete it and re-run `init` to rotate the credentials "
                     "(all data files are then re-encrypted).")
        return cfg, key

    salt = secrets.token_bytes(SALT_LEN)
    key = derive_key(username, password, salt)
    iv = secrets.token_bytes(IV_LEN)
    cfg = {
        "v": 1,
        "kdf": "PBKDF2",
        "hash": "SHA-256",
        "iterations": ITERATIONS,
        "salt": b64e(salt),
        "check": {"iv": b64e(iv), "ct": b64e(AESGCM(key).encrypt(iv, CHECK_TOKEN, None))},
    }
    AUTH_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"created {AUTH_FILE.relative_to(ROOT)}")
    return cfg, key


def unlock():
    """Load auth.json and return the AES key. Fails if auth.json is missing."""
    if not AUTH_FILE.exists():
        sys.exit("ERROR: data/auth.json missing — run `python scraper/sitecrypt.py init` first.")
    user, pw = credentials()
    _, key = load_or_create_auth(user, pw)
    return key


# ---------- CLI ----------

def cmd_init():
    user, pw = credentials()
    _, key = load_or_create_auth(user, pw)
    for name in ENCRYPTED:
        plain = DATA / f"{name}.json"
        if not plain.exists():
            if enc_path(name).exists():
                print(f"{name}: already encrypted")
            else:
                print(f"{name}: no source file, skipped")
            continue
        payload = json.loads(plain.read_text(encoding="utf-8"))
        updated = payload.pop("updated", None)
        write_encrypted(name, key, payload, updated)
        print(f"{name}: encrypted -> {enc_path(name).name}  "
              f"(now delete/untrack data/{name}.json)")


def cmd_show(name):
    print(json.dumps(read_encrypted(name, unlock()), ensure_ascii=False, indent=2))


def cmd_put(name, src):
    key = unlock()
    payload = json.loads(Path(src).read_text(encoding="utf-8"))
    updated = payload.pop("updated", None)
    write_encrypted(name, key, payload, updated)
    print(f"{name}: encrypted -> {enc_path(name).name}")


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    cmd = args[0]
    if cmd == "init":
        cmd_init()
    elif cmd == "show" and len(args) == 2:
        cmd_show(args[1])
    elif cmd == "put" and len(args) == 3:
        cmd_put(args[1], args[2])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
