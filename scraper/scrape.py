#!/usr/bin/env python3
"""
Scraper for AC Rossoneri – Junioren D-9 schwarz.

The FVNWS matchcenter sits behind Cloudflare's bot challenge, so a plain HTTP
request is refused (HTTP 403). This uses a real headless Chromium (Playwright),
which executes the challenge JS and loads the page like a normal browser.

It reads the whole group's Spielplan (a=sp), then:
  * writes data/matches.json   -> only our team's games (id = Spielnummer)
  * writes data/standings.json -> table COMPUTED from all played group results
It never touches data/goals.json or data/config.json (those are hand-maintained).

Run:  python scrape.py
Deps: playwright, beautifulsoup4  (+  playwright install chromium)
"""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

OUR_TEAM = "AC Rossoneri schwarz"
BASE = "https://matchcenter.fvnws.ch/default.aspx?oid=8&lng=1&v=508&t=63291&ls=26142&sg=71135"
SPIELPLAN_URL = BASE + "&a=sp"       # whole group schedule (all teams)
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

WIN, DRAW = 3, 1  # points (standard 3-1-0)


def _looks_real(html, title):
    t = (title or "").lower()
    bad = ("moment" in t or "attention required" in t or "just a moment" in html.lower())
    return len(html) > 8000 and not bad


def fetch(page, url, tries=3):
    """Load a matchcenter URL, patiently waiting for the Cloudflare challenge to clear.
    Retries a few times (the clearance cookie is kept across attempts on the same page)."""
    html = ""
    for attempt in range(tries):
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        for _ in range(20):  # up to ~40s per attempt
            page.wait_for_timeout(2000)
            html = page.content()
            if _looks_real(html, page.title()):
                return html
        page.wait_for_timeout(3000)  # brief backoff, then retry
    return html


def _txt(el):
    return " ".join(el.get_text(" ", strip=True).split()) if el else ""


def _iso_date(titel):
    m = re.search(r"(\d{2})\.(\d{2})\.(\d{4})", titel or "")
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else None


def parse_group_games(html):
    """Return every game in the group, each: date, time, home, away, scores, id."""
    soup = BeautifulSoup(html, "html.parser")

    def is_spiel(t):
        c = t.get("class", []) or []
        return "spiel" in c and "row" in c

    def is_titel(t):
        return "sppTitel" in (t.get("class", []) or [])

    cur_titel = None
    games = []
    for tag in soup.find_all(lambda t: is_spiel(t) or is_titel(t)):
        if is_titel(tag):
            cur_titel = _txt(tag)
            continue
        home = _txt(tag.select_one(".teamA"))
        away = _txt(tag.select_one(".teamB"))
        if not home or not away:
            continue
        info = _txt(tag.select_one(".spielInfo"))
        mnum = re.search(r"(\d{4,})", info)
        goals = _txt(tag.select_one(".goals"))
        sc = re.findall(r"\d+", goals)
        hs, as_ = (int(sc[0]), int(sc[1])) if len(sc) >= 2 else (None, None)
        games.append({
            "id": mnum.group(1) if mnum else None,
            "date": _iso_date(cur_titel),
            "time": _txt(tag.select_one(".time")) or None,
            "round": cur_titel,
            "home": home,
            "away": away,
            "homeScore": hs,
            "awayScore": as_,
            "status": "played" if hs is not None else "scheduled",
        })
    return games


def write_json(path, payload):
    """Write JSON, but keep the previous 'updated' timestamp when nothing else
    changed — so unchanged runs produce a byte-identical file and no git commit."""
    if path.exists():
        try:
            old = json.loads(path.read_text(encoding="utf-8"))
            if {k: v for k, v in old.items() if k != "updated"} == \
               {k: v for k, v in payload.items() if k != "updated"}:
                payload = {**payload, "updated": old.get("updated", payload.get("updated"))}
        except Exception:
            pass
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def extract_group_name(html, default="Junioren D-9"):
    """Pull the official championship/group name, e.g.
    'Junioren D-9 - Stärkeklasse 2 - Herbstrunde - Gruppe 3'."""
    soup = BeautifulSoup(html, "html.parser")
    for s in soup.find_all(string=re.compile(r"Junioren\s*D.*Gruppe\s*\d+", re.I)):
        return " ".join(str(s).split())
    return default


def compute_standings(games):
    """Build the table from all PLAYED group results (3-1-0)."""
    teams = {}

    def row(name):
        return teams.setdefault(name, {
            "team": name, "played": 0, "won": 0, "drawn": 0, "lost": 0,
            "goalsFor": 0, "goalsAgainst": 0, "points": 0,
        })

    for g in games:
        # register every team so pre-season shows the full field at 0
        row(g["home"]); row(g["away"])
        if g["status"] != "played":
            continue
        h, a = row(g["home"]), row(g["away"])
        hs, as_ = g["homeScore"], g["awayScore"]
        h["played"] += 1; a["played"] += 1
        h["goalsFor"] += hs; h["goalsAgainst"] += as_
        a["goalsFor"] += as_; a["goalsAgainst"] += hs
        if hs > as_:
            h["won"] += 1; a["lost"] += 1; h["points"] += WIN
        elif hs < as_:
            a["won"] += 1; h["lost"] += 1; a["points"] += WIN
        else:
            h["drawn"] += 1; a["drawn"] += 1
            h["points"] += DRAW; a["points"] += DRAW

    rows = sorted(
        teams.values(),
        key=lambda r: (-r["points"], -(r["goalsFor"] - r["goalsAgainst"]),
                       -r["goalsFor"], r["team"]),
    )
    for i, r in enumerate(rows, 1):
        r["rank"] = i
    return rows


def main():
    now = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=[
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled",
        ])
        ctx = browser.new_context(
            locale="de-CH", timezone_id="Europe/Zurich", user_agent=UA,
            viewport={"width": 1360, "height": 900},
            extra_http_headers={"Accept-Language": "de-CH,de;q=0.9,en;q=0.8"},
        )
        ctx.add_init_script(
            "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});")
        page = ctx.new_page()
        html = fetch(page, SPIELPLAN_URL)
        browser.close()

    if OUR_TEAM.split()[1] not in html:  # sanity: did the real page load?
        print("ERROR: page did not load real content (Cloudflare?).", file=sys.stderr)
        sys.exit(1)

    games = parse_group_games(html)
    our = [g for g in games if OUR_TEAM in (g["home"], g["away"])]
    standings = compute_standings(games)
    group_name = extract_group_name(html)

    write_json(DATA / "matches.json", {"updated": now, "matches": our})
    write_json(DATA / "standings.json",
               {"updated": now, "group": group_name, "rows": standings})

    played = sum(1 for g in our if g["status"] == "played")
    print(f"OK  {len(games)} group games | our team: {len(our)} games "
          f"({played} played) | {len(standings)} teams in table | {now}")


if __name__ == "__main__":
    main()
