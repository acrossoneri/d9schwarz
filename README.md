# AC Rossoneri – Junioren D-9 schwarz

Eigenständige Team-Website mit **Tabelle**, **Spielplan / Resultaten** und **Torschützen**.
Statische Seite (HTML/CSS/JS, kein Build), gehostet auf **GitHub Pages**:

**→ https://seiimeen.github.io/acrossoneri-d9/**

Tabelle, Spielplan und Resultate kommen automatisch aus dem FVNWS-Matchcenter
(via Scraper). Die Torschützen pflegst du selbst.

## Ordnerstruktur

```
index.html            Seite mit den drei Tabs
assets/style.css      Design (rot/schwarz, hell + dunkel)
assets/app.js         lädt die JSON-Dateien und baut die Ansichten
data/config.json      Team-Name, Saison
data/standings.json   Tabelle          (Scraper)
data/matches.json     Spiele + Resultate (Scraper)
data/goals.json       Torschützen pro Spiel – Schlüssel = Spielnummer (von Hand)
scraper/scrape.py     holt Tabelle + Spiele aus dem Matchcenter
scraper/update.sh     scrape + committen + pushen (nach dem Spieltag ausführen)
```

## Lokal ansehen

Doppelklick auf `index.html` funktioniert **nicht** (Browser blockieren lokale JSON).
Im Projektordner einen Mini-Server starten:

```bash
python3 -m http.server 8000     # dann http://localhost:8000
```

## Daten aktualisieren

**Tabelle / Spielplan / Resultate** – automatisch per Scraper:

```bash
./scraper/update.sh
```

Das lädt die aktuellen Daten aus dem Matchcenter, committet und pusht sie; ein paar
Sekunden später ist die Live-Seite aktuell. Am besten nach jedem Spieltag ausführen.

**Torschützen** – von Hand in `data/goals.json`, unter der Spielnummer des Spiels
(siehe `id` in `matches.json`):

```json
"145015": [ { "player": "Max Muster", "minute": 12 }, { "player": "Max Muster" } ]
```

Die Torschützenliste wird daraus automatisch berechnet. `update.sh` nimmt diese
Änderungen gleich mit. (Für Junioren D erfasst das Matchcenter keine Torschützen –
darum von Hand.)

### Optional: automatisch per Zeitplan (dein Rechner)

Per `cron` auf deinem Rechner, z. B. samstags stündlich (Rechner muss dann laufen):

```cron
0 9-18 * * 6  cd /home/simon/acrosso && ./scraper/update.sh >> /tmp/acr-update.log 2>&1
```

> Hinweis: `cron` findet `gh` evtl. nicht im PATH. Dann im Crontab `PATH=` setzen
> oder in `update.sh` den vollen Pfad zu `gh` hinterlegen.

## Automatische Aktualisierung (Cloud)

Ein GitHub-Actions-Workflow (`.github/workflows/update.yml`) startet den Scraper
nach Zeitplan (samstags oft, sonst täglich) und veröffentlicht neue Resultate/Tabelle
von selbst – ohne dass dein Rechner läuft.

Das Matchcenter liegt hinter **Cloudflare**; ein geduldiger headless Browser kommt
durch, aber die Rechenzentrums-IP von GitHub wird gelegentlich blockiert. Darum ist
der Scrape-Schritt **best effort**: klappt er nicht, bleiben einfach die letzten Daten
stehen (keine Fehlermails). Für eine garantierte Aktualisierung `./scraper/update.sh`
von deinem Rechner ausführen.

## Einrichtung auf einem neuen Rechner

```bash
git clone https://github.com/Seiimeen/acrossoneri-d9.git
cd acrossoneri-d9
python3 -m venv .venv
.venv/bin/python -m pip install -r scraper/requirements.txt
.venv/bin/python -m playwright install chromium
gh auth login          # einmalig, für git push
```
