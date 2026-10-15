# Gridiron Odds 2026

A website for making **justified, matchup-adjusted predictions of NFL player stats** in the 2026 season.
Pick a player, a stat, and a line (e.g. *Derrick Henry, 100+ rushing yards*) and it shows the
probability, along with the full reasoning behind it: the opponent-adjusted baseline, how the
upcoming defense treats that position, the Vegas game script, the distribution of outcomes, and
the player's game log against that line.

## Run it

```bash
python3 scripts/build_data.py   # download the latest nflverse stats + schedule/Vegas lines
node scripts/backtest.mjs       # optional: regenerate accuracy/calibration results
cd public && python3 -m http.server 8026
# open http://localhost:8026
```

It's a static site with no build step and no dependencies beyond Python 3 and Node. Re-run
`build_data.py` each week to pull in new games and lines (then `backtest.mjs` to refresh accuracy).

## Tabs

- **Predict**: the probability that a player reaches a line, with a step-by-step "why" breakdown.
  Games come from the real 2026 schedule with Vegas spreads and totals prefilled. Edit any input
  (opponent, venue, spread, total) to try a hypothetical matchup. For past weeks the prediction
  uses only pre-game data and shows the actual result.
- **Weekly board**: every active player ranked by chance to clear a line in a given week.
- **Defense vs position**: what each defense allows per game to QBs, RBs, WRs and TEs.
- **Method & accuracy**: how the model works, plus walk-forward backtest results.

## Model (public/js/model.js)

1. Opponent-adjusted, recency-weighted per-game baseline (this season, plus last season at reduced weight).
2. × opponent factor: what the defense allows to that position for that stat versus league average,
   regressed toward the mean.
3. × game script: implied team points from the spread and total. Favorites run more, underdogs pass more.
4. × small home/away adjustment.
5. A gamma distribution for yards and volume, or Poisson for TDs and INTs, gives P(X ≥ line).
   This is followed by a light calibration step.

The parameters were tuned by walk-forward backtest on 2025 only. 2026 serves as the holdout.

| Brier score (lower is better) | 2025 (tuning) | 2026 wk 3–5 (holdout) |
|---|---|---|
| This model | 0.1753 | 0.1816 |
| Same model without matchup factors | 0.1760 | 0.1825 |
| Player's hit rate so far | 0.1878 | 0.2069 |

**Limitations:** there's no injury or depth-chart feed and no weather. Vegas lines only exist about
a week ahead, so you'll need to enter your own spread and total for later games.

Data: [nflverse](https://github.com/nflverse/nflverse-data).
