# AC Rossoneri – Junioren D-9 schwarz

Kleine, eigenständige Team-Website mit **Tabelle**, **Spielplan / Resultaten** und **Torschützen**.
Reine statische Seite (HTML/CSS/JS) – kein Server, kein Build, kein Framework.
Alle Inhalte stehen in einfachen JSON-Dateien im Ordner `data/`.

## Ordnerstruktur

```
index.html            Seite mit den drei Tabs
assets/style.css      Design (rot/schwarz, hell + dunkel)
assets/app.js         lädt die JSON-Dateien und baut die Ansichten
data/config.json      Team-Name, Saison, Links zum Matchcenter
data/standings.json   Tabelle
data/matches.json     Spiele (Spielplan + Resultate)
data/goals.json       Torschützen pro Spiel (nur eigene Tore)
```

## Lokal ansehen

Ein Doppelklick auf `index.html` funktioniert **nicht** – Browser blockieren dann
das Laden lokaler JSON-Dateien. Starte stattdessen im Projektordner einen Mini-Server:

```bash
python3 -m http.server 8000
```

Dann im Browser `http://localhost:8000` öffnen.
(Alternativ `npx serve` oder die „Live Server"-Erweiterung in VS Code.)

## Daten pflegen

Alles wird von Hand in den `data/`-Dateien gepflegt. Nach dem Speichern die Seite neu laden.

- **Resultat eintragen:** in `data/matches.json` beim Spiel `homeScore`/`awayScore` setzen
  und `"status": "scheduled"` auf `"status": "played"` ändern.
- **Torschützen eintragen:** in `data/goals.json` unter der Match-ID (z. B. `"m5"`) die Torschützen
  ergänzen: `{ "player": "Name", "minute": 12 }` (die Minute ist optional).
  Die Torschützenliste im Tab „Torschützen" wird daraus automatisch berechnet.
- **Neues Spiel:** in `data/matches.json` einen Eintrag mit **eindeutiger** `id` ergänzen.
- **Sample-Hinweis ausblenden:** in `data/config.json` `"sampleData": false` setzen,
  sobald echte Daten drin sind.

> Hinweis: Die aktuellen Zahlen sind **Beispieldaten**. Für Junioren D werden die einzelnen
> Torschützen im offiziellen Matchcenter i. d. R. nicht erfasst – die trägst du selbst ein.

## Selbst hosten

Es ist eine statische Seite – der komplette Ordner kann bei fast jedem Hoster liegen:

- **Eigener Webspace / eigener Server:** Ordner per FTP/SFTP hochladen. Fertig.
- **Netlify / Cloudflare Pages / GitHub Pages:** Ordner hochladen bzw. Repo verbinden (Gratis-Stufe reicht).
- Wichtig: über **http(s)** ausliefern (nicht `file://`), sonst laden die JSON-Dateien nicht.

## Ausblick (Phase 2)

Automatisches Aktualisieren von Tabelle/Resultaten via Scraper (headless Browser, da das
Matchcenter hinter Cloudflare liegt) – schreibt dieselben JSON-Dateien. Torschützen bleiben
manuell. Bei Bedarf einbauen.
