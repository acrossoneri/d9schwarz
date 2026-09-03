#!/usr/bin/env python3
"""
Import saved match reports into the encrypted data files.

Reads game pages saved from a browser (Ctrl+S), and writes:

  * data/lineups.enc.json     -> our line-up per game, plus the opponent's,
                                 the Spielort, the Drittelsresultate and the Verlauf
  * data/friendlies.enc.json  -> games that are not in the group Spielplan
                                 (friendlies, cup ties), built from the report header
  * data/players.enc.json     -> the squad, with the shirt number from the most
                                 recent game each player appeared in
  * data/scorers.enc.json     -> optional, from --scorers

Nothing is fetched: the files are read from disk. Existing entries for games not
mentioned in the given reports are kept.

Run:
  SITE_USER=... SITE_PASSWORD=... python scraper/import_reports.py report*.html
  ... --scorers 145015=Marlon,Dean,Dean,Dean,Dean,Marlon --scorers 145019=Dean

A scorer name may be a first name, a surname or any part of the full name; it is
matched against that game's squad. Add a minute after a name if you have it:
"Dean 33".
"""
import argparse
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

from bs4 import BeautifulSoup

import scrape
import sitecrypt


def _txt(el):
    return " ".join(el.get_text(" ", strip=True).split()) if el else ""


def parse_report(path):
    """The whole report: the fixture it describes plus scrape.parse_game_detail()."""
    html = Path(path).read_text(encoding="utf-8", errors="replace")
    detail = scrape.parse_game_detail(html)
    if not detail:
        return None

    soup = BeautifulSoup(html, "html.parser")
    head = _txt(soup.select_one(".shortSpielort"))
    number = re.search(r"Spielnummer:?\s*(\d{4,})", head)
    when = re.search(r"(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}:\d{2})", head)
    score = re.search(r"(\d+)\s*:\s*(\d+)", _txt(soup.select_one(".shortResults")))

    fixture = {
        "id": number.group(1) if number else None,
        "date": f"{when.group(3)}-{when.group(2)}-{when.group(1)}" if when else None,
        "time": when.group(4) if when else None,
        "round": head[:when.start()].strip(" -–") if when else None,
        "home": _txt(soup.select_one(".shortTeamHeim")),
        "away": _txt(soup.select_one(".shortTeamGast")),
        "homeScore": int(score.group(1)) if score else None,
        "awayScore": int(score.group(2)) if score else None,
    }
    fixture["status"] = "played" if score else "scheduled"
    return {"fixture": fixture, "detail": detail}


def _load(name, key, empty):
    try:
        payload = sitecrypt.read_encrypted(name, key)
    except Exception:
        return dict(empty)
    payload.pop("updated", None)
    return payload or dict(empty)


def _fold(s):
    """Casefold and strip accents, so 'Hugli' still finds 'Hügli'."""
    return "".join(c for c in unicodedata.normalize("NFD", s.casefold())
                   if unicodedata.category(c) != "Mn")


def _levenshtein(a, b):
    if abs(len(a) - len(b)) > 2:
        return 9
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        row = [i]
        for j, cb in enumerate(b, 1):
            row.append(min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = row
    return prev[len(b)]


def resolve(token, candidates):
    """One scorer name against a squad: exact, name part, prefix, substring, typo."""
    t = _fold(token)
    folded = [(c, _fold(c)) for c in candidates]

    def only(hits):
        return hits[0] if len(hits) == 1 else None

    for pick in (
        [c for c, f in folded if f == t],
        [c for c, f in folded if t in f.split()],
        [c for c, f in folded if f.startswith(t)],
        [c for c, f in folded if t in f],
        [c for c, f in folded if any(_levenshtein(w, t) <= 2 for w in f.split())],
    ):
        if pick:
            hit = only(pick)
            if hit:
                return hit
            return None            # ambiguous: better to stop than guess
    return None


def parse_scorer_arg(arg):
    """'145015=Marlon,Dean 33' -> ('145015', [('Marlon', None), ('Dean', 33)])"""
    if "=" not in arg:
        sys.exit(f"ERROR: --scorers braucht die Form SPIELNUMMER=Name,Name — bekam {arg!r}")
    game, names = arg.split("=", 1)
    out = []
    for part in (p.strip() for p in names.split(",")):
        if not part:
            continue
        m = re.match(r"^(.*?)[\s.']*(\d{1,3})'?\.?$", part)
        out.append((m.group(1).strip(), int(m.group(2))) if m else (part, None))
    return game.strip(), out


def main():
    ap = argparse.ArgumentParser(description="Gespeicherte Spielberichte einlesen.")
    ap.add_argument("reports", nargs="+", help="HTML-Dateien aus dem Browser")
    ap.add_argument("--scorers", action="append", default=[],
                    metavar="NR=Name,Name", help="Torschützen in Reihenfolge der Tore")
    ap.add_argument("--dry-run", action="store_true", help="nur zeigen, nichts schreiben")
    args = ap.parse_args()

    key, _role = sitecrypt.unlock()
    our = _load("config", key, {}).get("ourTeam") or scrape.OUR_TEAM
    league = {str(g["id"]): g for g in _load("matches", key, {"matches": []})["matches"]}

    lineups = _load("lineups", key, {"byMatch": {}})
    lineups.setdefault("byMatch", {})
    friendlies = _load("friendlies", key, {"matches": []})
    friendlies.setdefault("matches", [])

    seen = []
    for path in args.reports:
        report = parse_report(path)
        if not report:
            print(f"  übersprungen: {Path(path).name} — kein Spielbericht", file=sys.stderr)
            continue
        fx, detail = report["fixture"], report["detail"]
        gid = fx["id"]
        ours = next((l for l in detail.get("lineups", []) if l["team"] == our), None)
        if not gid or not ours:
            print(f"  übersprungen: {Path(path).name} — keine eigene Aufstellung",
                  file=sys.stderr)
            continue

        record = {"starting": ours["starting"], "subs": ours["subs"]}
        for extra in ("venue", "periods", "events"):
            if detail.get(extra):
                record[extra] = detail[extra]
        opponents = [l for l in detail["lineups"] if l["team"] != our]
        if opponents:
            record["opponents"] = opponents
        lineups["byMatch"][gid] = record

        if gid not in league:
            fx["friendly"] = True
            rest = [m for m in friendlies["matches"] if str(m["id"]) != gid]
            friendlies["matches"] = sorted(rest + [fx],
                                           key=lambda m: (m.get("date") or "", str(m["id"])))
            note = "  (eigenes Spiel angelegt)"
        else:
            note = ""
        seen.append(gid)
        print(f"  {gid}  {fx['date']}  {fx['home']} {fx['homeScore']}:{fx['awayScore']} "
              f"{fx['away']}  — {len(ours['starting'])} Start / {len(ours['subs'])} Ersatz"
              f"{note}")

    # Squad, with the number from the most recent game each player appeared in.
    dates = {}
    for gid in lineups["byMatch"]:
        g = league.get(gid) or next((m for m in friendlies["matches"] if str(m["id"]) == gid), {})
        dates[gid] = g.get("date") or ""
    squad = {}
    for gid, rec in lineups["byMatch"].items():
        for p in rec.get("starting", []) + rec.get("subs", []):
            name = (p.get("name") or "").strip()
            if not name:
                continue
            prev = squad.get(name)
            if not prev or dates[gid] >= prev[0]:
                squad[name] = (dates[gid], p.get("number"))
    players = [{"name": n, **({"number": num} if num is not None else {})}
               for n, (_when, num) in sorted(squad.items())]

    # Scorers, matched against the squad of the game they belong to.
    scorers = _load("scorers", key, {"byMatch": {}})
    scorers.setdefault("byMatch", {})
    for arg in args.scorers:
        gid, entries = parse_scorer_arg(arg)
        rec = lineups["byMatch"].get(gid, {})
        candidates = [p["name"] for p in rec.get("starting", []) + rec.get("subs", [])] \
                     or [p["name"] for p in players]
        out, unresolved = [], []
        for token, minute in entries:
            name = resolve(token, candidates)
            if not name:
                unresolved.append(token)
                name = token
            entry = {"player": name, "team": our}
            if minute is not None:
                entry["minute"] = minute
            out.append(entry)
        scorers["byMatch"][gid] = out
        game = league.get(gid) or {}
        goals = (game.get("homeScore") if game.get("home") == our else game.get("awayScore"))
        warn = ""
        if goals is not None and goals != len(out):
            warn = f"  ACHTUNG: Resultat sagt {goals} eigene Tore"
        print(f"  Torschützen {gid}: " + ", ".join(e["player"] for e in out) + warn)
        if unresolved:
            print(f"    nicht zugeordnet: {', '.join(unresolved)}", file=sys.stderr)

    if args.dry_run:
        print("\n--dry-run: nichts geschrieben.")
        return

    now = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
    sitecrypt.write_encrypted("lineups", key, {"byMatch": lineups["byMatch"]}, now)
    sitecrypt.write_encrypted("players", key, {"players": players}, now)
    if friendlies["matches"]:
        sitecrypt.write_encrypted("friendlies", key, {"matches": friendlies["matches"]}, now)
    if scorers["byMatch"]:
        sitecrypt.write_encrypted("scorers", key, {"byMatch": scorers["byMatch"]}, now)

    print(f"\nOK  {len(seen)} Berichte | {len(lineups['byMatch'])} Aufstellungen | "
          f"{len(players)} Spieler | {len(friendlies['matches'])} eigene Spiele | "
          f"{len(scorers['byMatch'])} Spiele mit Torschützen")
    print("Jetzt committen:  git add data/ && git commit -m 'data: Spielberichte "
          "eingelesen' && git push")


if __name__ == "__main__":
    main()
