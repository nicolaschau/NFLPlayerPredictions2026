// Walk-forward backtest: for each week, project every player-game using only data available
// before kickoff, then score the probabilities against what actually happened.
//
// Usage: node scripts/backtest.mjs     (after python3 scripts/build_data.py)
// Writes public/data/calibration.json, which the "Method & accuracy" tab renders.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModel, STAT } from '../public/js/model.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const load = (y) => JSON.parse(fs.readFileSync(path.join(root, 'public/data', `season_${y}.json`)));
const meta = JSON.parse(fs.readFileSync(path.join(root, 'public/data/meta.json')));
const data = Object.fromEntries(meta.seasons.map((y) => [y, load(y)]));
const model = createModel(data);

// Prop-style thresholds tested for each stat; a line is only tested for players whose
// current-season average is at least 40% of it (i.e. lines a book might actually offer).
const TESTS = {
  passing_yards: [200, 225, 250, 275, 300],
  passing_tds: [1, 2, 3],
  completions: [18, 20, 22, 25],
  rushing_yards: [25, 40, 50, 60, 75, 100],
  carries: [10, 12, 15, 18, 20],
  receptions: [2, 3, 4, 5, 6, 7],
  receiving_yards: [25, 40, 50, 60, 75, 100],
  rush_rec_yards: [50, 75, 100, 125],
  anytime_td: [1, 2],
};

// Parameters in model.js were tuned on 2025 only, so the current season is an out-of-sample check.
const windows = [
  { season: 2025, weeks: [4, 18] },
  { season: meta.current, weeks: [3, meta.lastCompletedWeek] },
];

const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, hit: 0 }));
const score = { model: { brier: 0, ll: 0 }, naive: { brier: 0, ll: 0 }, noMatchup: { brier: 0, ll: 0 } };
const byStat = {};
const byWindow = {};
let n = 0;
const ll = (p, y) => -(y ? Math.log(Math.max(1e-6, p)) : Math.log(Math.max(1e-6, 1 - p)));

for (const { season, weeks } of windows) {
  const win = (byWindow[`${season} weeks ${weeks[0]}-${weeks[1]}`] = { n: 0, model: 0, noMatchup: 0, naive: 0, holdout: season !== 2025 });
  const S = model.seasons[season];
  for (let week = weeks[0]; week <= weeks[1]; week++) {
    for (const g of S.logs.filter((l) => l.week === week)) {
      const info = S.players[g.pid];
      const { cur } = model.priorGames(g.pid, season, week);
      if (cur.length < 2) continue;
      const sched = model.gameFor(g.team, model.teamGame(season, g.team, week));
      if (!sched) continue;
      for (const [key, lines] of Object.entries(TESTS)) {
        const st = STAT[key];
        if (!st.pos.includes(info.pos)) continue;
        const avg = cur.reduce((a, x) => a + x.s[key], 0) / cur.length;
        const proj = model.project(season, week, g.pid, key, sched);
        const plain = model.project(season, week, g.pid, key, { opp: null, home: null, spread: null, total: null });
        if (!proj) continue;
        for (const line of lines) {
          if (avg < 0.4 * line) continue;
          const y = g.s[key] >= line ? 1 : 0;
          const p = proj.dist.pAtLeast(line);
          const pPlain = plain.dist.pAtLeast(line);
          const hits = cur.filter((x) => x.s[key] >= line).length;
          const pNaive = (hits + 0.5) / (cur.length + 1);
          score.model.brier += (p - y) ** 2; score.model.ll += ll(p, y);
          score.naive.brier += (pNaive - y) ** 2; score.naive.ll += ll(pNaive, y);
          score.noMatchup.brier += (pPlain - y) ** 2; score.noMatchup.ll += ll(pPlain, y);
          const b = bins[Math.min(9, Math.floor(p * 10))];
          b.n++; b.p += p; b.hit += y;
          const s = (byStat[key] ||= { n: 0, brier: 0, naive: 0, base: 0 });
          s.n++; s.brier += (p - y) ** 2; s.naive += (pNaive - y) ** 2; s.base += y;
          win.n++; win.model += (p - y) ** 2; win.noMatchup += (pPlain - y) ** 2; win.naive += (pNaive - y) ** 2;
          n++;
        }
      }
    }
  }
}

// Brier of always guessing the overall hit rate - the "know nothing about the player" floor.
const baseRate = bins.reduce((a, b) => a + b.hit, 0) / n;
const out = {
  built: meta.built,
  windows: windows.map((w) => `${w.season} weeks ${w.weeks[0]}-${w.weeks[1]}`),
  n,
  baseRate,
  brier: {
    model: score.model.brier / n,
    noMatchup: score.noMatchup.brier / n,
    naive: score.naive.brier / n,
    climatology: baseRate * (1 - baseRate),
  },
  logLoss: { model: score.model.ll / n, noMatchup: score.noMatchup.ll / n, naive: score.naive.ll / n },
  calibration: bins.map((b, i) => ({ lo: i / 10, hi: (i + 1) / 10, n: b.n, predicted: b.n ? b.p / b.n : null, observed: b.n ? b.hit / b.n : null })),
  byWindow: Object.fromEntries(Object.entries(byWindow).map(([k, w]) => [k, { n: w.n, holdout: w.holdout, model: w.model / w.n, noMatchup: w.noMatchup / w.n, naive: w.naive / w.n }])),
  byStat: Object.fromEntries(Object.entries(byStat).map(([k, s]) => [k, { n: s.n, brier: s.brier / s.n, naive: s.naive / s.n, hitRate: s.base / s.n }])),
};
fs.writeFileSync(path.join(root, 'public/data/calibration.json'), JSON.stringify(out, null, 2));
console.log(`predictions scored: ${n}`);
console.log('Brier (lower is better):', Object.fromEntries(Object.entries(out.brier).map(([k, v]) => [k, v.toFixed(4)])));
console.log('Log loss:', Object.fromEntries(Object.entries(out.logLoss).map(([k, v]) => [k, v.toFixed(4)])));
console.table(out.byWindow);
console.table(out.calibration.map((c) => ({ bin: `${c.lo.toFixed(1)}-${c.hi.toFixed(1)}`, n: c.n, predicted: c.predicted?.toFixed(3), observed: c.observed?.toFixed(3) })));
