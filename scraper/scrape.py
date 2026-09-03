#!/usr/bin/env python3
"""
Scraper for AC Rossoneri – Junioren D-9 schwarz.

The FVNWS matchcenter sits behind Cloudflare's bot challenge, so a plain HTTP
request is refused (HTTP 403). This uses a real headless Chromium (Playwright),
which executes the challenge JS and loads the page like a normal browser.

It reads the whole group's Spielplan (a=sp), then:
  * writes data/matches.enc.json   -> every game in the group (id = Spielnummer)
  * writes data/standings.enc.json -> table COMPUTED from all played group results
It never touches data/config.enc.json (that one is hand-maintained).

Each game row links to its Spieldetail page, which carries the Spielort, the
Drittelsresultate, the Verlauf (cards — goal scorers are not published at D-9)
and the full Aufstellung of both teams. Those pages are fetched too, see
attach_details() for how often.

Both outputs are encrypted — see crypt.py. The site is public, the data is not,
so the scraper needs the site credentials to write:

Run:  SITE_USER=... SITE_PASSWORD=... python scrape.py
Deps: playwright, beautifulsoup4, cryptography  (+  playwright install chromium)
"""
import re
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

import sitecrypt

OUR_TEAM = "AC Rossoneri schwarz"
HOST = "https://matchcenter.fvnws.ch"
BASE = HOST + "/default.aspx?oid=8&lng=1&v=508&t=63291&ls=26142&sg=71135"
SPIELPLAN_URL = BASE + "&a=sp"       # whole group schedule (all teams)
TZ = ZoneInfo("Europe/Zurich")       # the matchcenter prints Swiss local time

# When a Spieldetail is worth asking for. Deliberately sparse: a report nobody has
# written yet does not get written by asking more often. Our games start looking 4h
# after kickoff and try again every couple of hours until the Aufstellung is
# actually there; everyone else's are fetched once, after their weekend is over and
# every report has been filed.
PRE_MATCH_LOOK = 24                  # our games: one look this many hours before kickoff
OUR_FIRST_AFTER = timedelta(hours=4)
OUR_RETRY_EVERY = 2                  # hours between our retries, until the data lands
GIVE_UP_DAYS = 14                    # a report missing this long is never coming
MAX_OTHER_PER_RUN = 8                # bounds the Monday batch
GIVE_UP_AFTER = 3                    # consecutive empty details -> stop asking this run

# Master switch for the Spieldetail requests. The pages do not always serve a
# report; when they answer with the refusal page below, the run stops asking rather
# than working through the rest of the list for nothing.
FETCH_DETAILS = True
REFUSAL_MARKER = "maschineller Zugriff ist nicht erlaubt"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

WIN, DRAW = 3, 1  # points (standard 3-1-0)


def _looks_real(html, title):
    t = (title or "").lower()
    bad = ("moment" in t or "attention required" in t or "just a moment" in html.lower())
    return len(html) > 8000 and not bad


def fetch(page, url, tries=3, expect=None):
    """Load a matchcenter URL, patiently waiting for the Cloudflare challenge to clear.
    Retries a few times (the clearance cookie is kept across attempts on the same page).

    `expect` is a marker that must appear in the HTML before it counts as loaded.
    Without one a page only has to be big and free of challenge wording — which an
    interstitial can manage — so pass the marker when you know what you came for."""
    html = ""
    for attempt in range(tries):
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        for _ in range(20):  # up to ~40s per attempt
            page.wait_for_timeout(2000)
            html = page.content()
            if REFUSAL_MARKER in html:
                return html          # a refusal is final; polling it 20x helps nobody
            if _looks_real(html, page.title()) and (not expect or expect in html):
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
        link = tag.find_parent("a")
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
            # transient: the Spieldetail URL. main() pops it before writing, so a
            # matchcenter that renumbers its links can never churn the data file.
            "_url": link.get("href") if link else None,
        })
    return games


def parse_game_detail(html):
    """Everything the Spieldetail page adds: Spielort, Drittelsresultate, Verlauf
    and the Aufstellung of both teams. Returns {} if the page did not really load."""
    soup = BeautifulSoup(html, "html.parser")
    for t in soup(["script", "style"]):
        t.decompose()

    head = soup.select_one(".shortSpielort")
    if not head:
        return {}

    detail = {}
    # "… - Spielnummer: 145015 - Bifang, Lausen - Schelligacker" -> the ground only
    venue = re.sub(r"^[\s\-\u2013]+", "", _txt(head.select_one("span.hidden-xs")))
    if venue:
        detail["venue"] = venue

    # D-9 plays thirds, so the score line reads "(0:1/3:3/6:6)".
    periods = _txt(soup.select_one("div[id$='divToreViertel']")).strip("()")
    parts = [p.strip() for p in periods.split("/") if p.strip()]
    if parts:
        detail["periods"] = parts

    events = []
    for li in soup.select("ul.bnEventsList > li"):
        label = _txt(li.select_one(".eventlabel"))
        if not label:
            continue
        img = li.select_one("img")
        icon = (img.get("src") or "").rsplit("/", 1)[-1].split(".")[0] if img else ""
        ev = {"text": label}
        minute = re.search(r"(\d+)", _txt(li.select_one("time.timeline-time")))
        if minute:
            ev["minute"] = int(minute.group(1))
        if icon:
            ev["kind"] = icon          # "gelb", "rot", … — the icon names the event
        events.append(ev)
    if events:
        detail["events"] = events

    lineups = [_parse_lineup(b)
               for b in soup.select("div[id$='phAufstellung'] > div.col-sm-6")]
    lineups = [l for l in lineups if l["starting"] or l["subs"] or l["coaches"]]
    if lineups:
        detail["lineups"] = lineups

    return detail


def _parse_lineup(block):
    """One team's Aufstellung. Sections are delimited by the .aufTitel rows:
    everything before the first one is the starting line-up."""
    out = {"team": _txt(block.select_one(".eventsTeamName")),
           "starting": [], "subs": [], "coaches": []}
    section = "starting"
    for tr in block.select("table.table-hover tr"):
        titel = _txt(tr.select_one(".aufTitel")).lower()
        if titel:
            section = ("subs" if "ersatz" in titel else
                       "coaches" if "trainer" in titel else section)
            continue
        name = _txt(tr.select_one(".aufName"))
        if not name:
            continue                   # the "= Kein Einsatz" legend row
        player = {"name": re.sub(r"\s*\(C\)$", "", name).strip()}
        num = _txt(tr.select_one(".eventsTime"))
        if num.isdigit():
            player["number"] = int(num)
        pos = _txt(tr.select_one(".aufPos"))
        if pos:
            player["position"] = pos
        if tr.select_one(".aufCaptain") or name.endswith("(C)"):
            player["captain"] = True
        if tr.select_one(".aufStern"):
            player["unused"] = True    # in the squad, did not play
        out[section].append(player)
    return out


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


def _kickoff(game):
    """Kickoff as an aware datetime, or None if the row had no usable date."""
    if not game.get("date"):
        return None
    try:
        return datetime.strptime(f"{game['date']} {game.get('time') or '00:00'}",
                                 "%Y-%m-%d %H:%M").replace(tzinfo=TZ)
    except ValueError:
        return None


def _weekend_over(kickoff):
    """Midnight starting the Monday after the game — 'once the weekend is done'."""
    days = ((0 - kickoff.weekday()) % 7) or 7        # Mon=0; a Monday game waits a week
    return (kickoff + timedelta(days=days)).replace(
        hour=0, minute=0, second=0, microsecond=0)


def wants_detail(game, old, now, ours):
    """Is this game due for a Spieldetail request in this run?

    Ours: one look the day before for the Spielort, then nothing until
    kickoff + OUR_FIRST_AFTER, then every OUR_RETRY_EVERY hours until the
    Aufstellung is there. Everyone else's: exactly once, after their weekend is
    over. Both give up after GIVE_UP_DAYS."""
    kickoff = _kickoff(game)
    if not kickoff:
        return False

    if now < kickoff:
        # The Spielort is published in advance and "wo spielen wir am Samstag?" is
        # worth one question. One scheduled slot, not a poll: if it is missed or
        # refused, the venue simply arrives with the post-match look instead. (On the
        # Saturday match-day cron that slot can come round more than once for a Sunday
        # game — harmless, since the first answer stores the venue and ends it.)
        if not ours or (old and old.get("venue")):
            return False
        return int((kickoff - now).total_seconds() // 3600) == PRE_MATCH_LOOK - 1

    if now - kickoff > timedelta(days=GIVE_UP_DAYS):
        return False

    if not ours:
        return not old and game["status"] == "played" and now >= _weekend_over(kickoff)

    if old and old.get("lineups"):
        return False                                 # already have what we came for
    elapsed = now - kickoff
    if elapsed < OUR_FIRST_AFTER:
        return False
    # Hourly cron, so whole hours past the first look decide whose turn it is.
    slot = int((elapsed - OUR_FIRST_AFTER).total_seconds() // 3600)
    return slot % OUR_RETRY_EVERY == 0


def previous_details(key):
    """{game id: detail} from the last run, so a skipped or failed fetch keeps
    what we already had instead of blanking it."""
    try:
        old = sitecrypt.read_encrypted("matches", key)
    except Exception:
        return {}
    return {g["id"]: g["detail"] for g in old.get("matches", [])
            if g.get("id") and g.get("detail")}


def attach_details(page, games, cached, now):
    """Give every game its Spieldetail, fetching what needs fetching.

    wants_detail() decides whose turn it is; whatever is not fetched keeps the detail
    the previous run stored, so a skip or a failure never blanks a game.

    Two brakes on top: GIVE_UP_AFTER empty answers in a row end the run's detail
    phase, and the refusal page ends it immediately — asking again in the same run
    would not change the answer."""
    budget, deferred, fetched = MAX_OTHER_PER_RUN, 0, 0
    blocked, unreached = 0, 0
    for g in games:
        url = g.pop("_url", None)
        old = cached.get(g["id"])
        if old:
            g["detail"] = old
        if not url or not FETCH_DETAILS:
            continue
        ours = OUR_TEAM in (g["home"], g["away"])
        if not wants_detail(g, old, now, ours):
            continue
        if blocked >= GIVE_UP_AFTER:
            unreached += 1
            continue
        if not ours:
            if budget <= 0:
                deferred += 1
                continue
            budget -= 1

        try:
            # One attempt: the schedule already spaces these out, and a page that is
            # not there now will not be there 40 seconds later — the next slot can have
            # it. A refusal short-circuits inside fetch().
            html = fetch(page, HOST + url, tries=1, expect="shortSpielort")
            if REFUSAL_MARKER in html:
                print("NOTE  Spieldetails werden derzeit nicht ausgeliefert — "
                      "Abfrage für diesen Lauf abgebrochen.", file=sys.stderr)
                break
            detail = parse_game_detail(html)
        except Exception as exc:                     # best effort, like the scrape itself
            print(f"WARN  Spieldetail {g['id']} fehlgeschlagen: {exc}", file=sys.stderr)
            blocked += 1
            continue
        if detail:                                   # never let a blocked page blank a game
            g["detail"] = detail
            fetched += 1
            blocked = 0
        else:
            blocked += 1
            if blocked == 1:                         # once per run: what did we actually get?
                print(f"WARN  Spieldetail {g['id']} leer — {len(html)} Zeichen, "
                      f"Titel {page.title()!r}", file=sys.stderr)
    if unreached:
        print(f"NOTE  Nach {GIVE_UP_AFTER} leeren Spieldetails abgebrochen — "
              f"{unreached} Spiele diesmal nicht abgefragt (Cloudflare?). "
              f"Bestehende Details bleiben erhalten.")
    if deferred:
        print(f"NOTE  {deferred} fremde Spiele diesmal ausgelassen "
              f"(max {MAX_OTHER_PER_RUN} pro Lauf) — sie kommen im nächsten Lauf dran.")
    return fetched


def main():
    now = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
    key, _role = sitecrypt.unlock()  # fail fast on bad credentials, before the slow scrape

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

        if OUR_TEAM.split()[1] not in html:  # sanity: did the real page load?
            browser.close()
            print("ERROR: page did not load real content (Cloudflare?).", file=sys.stderr)
            sys.exit(1)

        games = parse_group_games(html)
        # The matchcenter shuffles games within a day between requests, which used to
        # produce commits with no actual change. Fix the order ourselves.
        games.sort(key=lambda g: (g["date"] or "", g["time"] or "", g["id"] or ""))
        # Same page object, so the Cloudflare clearance cookie carries over and the
        # detail pages load without another challenge.
        details = attach_details(page, games, previous_details(key),
                                 datetime.now(timezone.utc).astimezone(TZ))
        browser.close()

    our = [g for g in games if OUR_TEAM in (g["home"], g["away"])]
    standings = compute_standings(games)
    group_name = extract_group_name(html)

    sitecrypt.write_encrypted("matches", key, {"matches": games}, now)
    sitecrypt.write_encrypted("standings", key,
                              {"group": group_name, "rows": standings}, now)

    played = sum(1 for g in our if g["status"] == "played")
    with_detail = sum(1 for g in games if g.get("detail"))
    if not FETCH_DETAILS:
        print("NOTE  Spieldetails abgeschaltet. Vorhandene Details bleiben erhalten.")
    print(f"OK  {len(games)} group games | our team: {len(our)} games "
          f"({played} played) | {len(standings)} teams in table | "
          f"{with_detail} Spieldetails ({details} neu geholt) | {now}")


if __name__ == "__main__":
    main()
