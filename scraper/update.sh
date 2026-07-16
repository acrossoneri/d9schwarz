#!/usr/bin/env bash
# Refresh Tabelle + Spielplan/Resultate from the matchcenter and publish to GitHub Pages.
# Run this after a match day. It also picks up any goals.json edits you made by hand.
#
#   ./scraper/update.sh
#
# Needs: the project's .venv (playwright + beautifulsoup4) and `gh` logged in for git push.
set -euo pipefail
cd "$(dirname "$0")/.."   # -> project root

echo "» Scraping matchcenter ..."
.venv/bin/python scraper/scrape.py

git add data/
if git diff --staged --quiet; then
  echo "» Keine Änderungen – nichts zu veröffentlichen."
else
  git commit -m "data: update $(date '+%Y-%m-%d %H:%M')"
  git push
  echo "» Aktualisiert & veröffentlicht → https://seiimeen.github.io/acrossoneri-d9/"
fi
