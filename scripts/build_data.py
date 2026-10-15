#!/usr/bin/env python3
"""Download nflverse weekly player stats + schedule and write compact JSON for the site.

Usage:  python3 scripts/build_data.py            # seasons 2024-2026
        python3 scripts/build_data.py --offline  # reuse files already in data/raw

Outputs (public/data/):
  season_<YYYY>.json  - offensive game logs for QB/RB/WR/TE plus that season's schedule
  meta.json           - build timestamp, seasons, last completed week
"""
import argparse
import csv
import io
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
OUT = os.path.join(ROOT, "public", "data")

STATS_URL = "https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_{season}.csv"
GAMES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"

SEASONS = [2024, 2025, 2026]
CURRENT = 2026
POSITIONS = {"QB": "QB", "RB": "RB", "FB": "RB", "WR": "WR", "TE": "TE"}

# Order matters: the front end reads logs positionally using meta.statCols.
STAT_COLS = [
    "completions", "attempts", "passing_yards", "passing_tds", "passing_interceptions",
    "sacks_suffered", "carries", "rushing_yards", "rushing_tds", "receptions", "targets",
    "receiving_yards", "receiving_tds", "fantasy_points_ppr",
]


def fetch(url, dest, offline):
    if not offline or not os.path.exists(dest):
        print(f"  downloading {url}", file=sys.stderr)
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                data = r.read()
            with open(dest, "wb") as f:
                f.write(data)
        except urllib.error.URLError:
            # python.org builds on macOS often ship without CA certs; curl uses the system store.
            subprocess.run(["curl", "-sSfL", "-o", dest, url], check=True)
    with open(dest, encoding="utf-8") as f:
        return list(csv.DictReader(io.StringIO(f.read())))


def num(v):
    if v in ("", "NA", None):
        return 0
    x = float(v)
    return int(x) if x.is_integer() else round(x, 2)


def opt_num(v):
    return None if v in ("", "NA", None) else float(v)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args()
    os.makedirs(RAW, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)

    games = fetch(GAMES_URL, os.path.join(RAW, "games.csv"), args.offline)
    last_week = 0
    for season in SEASONS:
        sched = [g for g in games if int(g["season"]) == season and g["game_type"] == "REG"]
        game_home = {g["game_id"]: g["home_team"] for g in sched}
        schedule = [
            {
                "id": g["game_id"], "week": int(g["week"]), "date": g["gameday"], "time": g["gametime"],
                "home": g["home_team"], "away": g["away_team"],
                "hs": opt_num(g["home_score"]), "as": opt_num(g["away_score"]),
                # nflverse spread_line is from the home team's perspective (positive = home favored)
                "spread": opt_num(g["spread_line"]), "total": opt_num(g["total_line"]),
                "roof": g["roof"],
            }
            for g in sched
        ]
        if season == CURRENT:
            done = [s["week"] for s in schedule if s["hs"] is not None]
            last_week = max(done) if done else 0

        rows = fetch(STATS_URL.format(season=season), os.path.join(RAW, f"stats_{season}.csv"), args.offline)
        players, logs = {}, []
        for r in rows:
            pos = POSITIONS.get(r["position"])
            if pos is None or r["season_type"] != "REG":
                continue
            pid = r["player_id"]
            week = int(r["week"])
            p = players.setdefault(pid, {"name": r["player_display_name"], "pos": pos,
                                         "headshot": r["headshot_url"], "team": r["team"], "lastWeek": 0})
            if week >= p["lastWeek"]:
                p.update(team=r["team"], lastWeek=week)
            home = 1 if game_home.get(r["game_id"]) == r["team"] else 0
            logs.append([pid, week, r["team"], r["opponent_team"], home] + [num(r[c]) for c in STAT_COLS])

        out = {"season": season, "statCols": STAT_COLS, "players": players, "logs": logs, "schedule": schedule}
        path = os.path.join(OUT, f"season_{season}.json")
        with open(path, "w") as f:
            json.dump(out, f, separators=(",", ":"))
        print(f"  {season}: {len(players)} players, {len(logs)} game logs, {len(schedule)} games -> {path}",
              file=sys.stderr)

    meta = {
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "current": CURRENT, "seasons": SEASONS, "lastCompletedWeek": last_week,
        "source": "nflverse (github.com/nflverse/nflverse-data)",
    }
    with open(os.path.join(OUT, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(f"  current season {CURRENT}: completed through week {last_week}", file=sys.stderr)


if __name__ == "__main__":
    main()
