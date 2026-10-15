// Projection model shared by the browser app and the Node backtest (scripts/backtest.mjs).
//
// For a player, stat, and matchup, the model:
//   1. Builds an opponent-adjusted, recency-weighted per-game baseline from this season's games
//      (heavy weight) and last season's games (light weight).
//   2. Multiplies by the opponent's allowed-vs-position factor, regressed toward league average.
//   3. Multiplies by a game-script factor from the Vegas spread / total (implied team points).
//   4. Applies a small home/away adjustment.
//   5. Turns the projected mean into a full distribution (gamma for yards/volume, Poisson for
//      TDs/INTs) whose spread comes from the player's own game-to-game volatility, shrunk toward
//      the position norm, plus uncertainty in the mean itself.

export const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

export const STATS = [
  { key: 'passing_yards', label: 'Passing yards', pos: ['QB'], dist: 'gamma', kind: 'passYds', line: 250, step: 5 },
  { key: 'passing_tds', label: 'Passing TDs', pos: ['QB'], dist: 'poisson', kind: 'td', line: 2, step: 1 },
  { key: 'completions', label: 'Completions', pos: ['QB'], dist: 'gamma', kind: 'passVol', line: 22, step: 1 },
  { key: 'attempts', label: 'Pass attempts', pos: ['QB'], dist: 'gamma', kind: 'passVol', line: 33, step: 1 },
  { key: 'passing_interceptions', label: 'Interceptions thrown', pos: ['QB'], dist: 'poisson', kind: 'int', line: 1, step: 1 },
  { key: 'pass_rush_yards', label: 'Pass + rush yards', pos: ['QB'], dist: 'gamma', kind: 'passYds', line: 275, step: 5 },
  { key: 'rushing_yards', label: 'Rushing yards', pos: ['RB', 'QB', 'WR'], dist: 'gamma', kind: 'rushYds', line: 100, step: 5 },
  { key: 'carries', label: 'Carries', pos: ['RB', 'QB'], dist: 'gamma', kind: 'rushVol', line: 15, step: 1 },
  { key: 'rushing_tds', label: 'Rushing TDs', pos: ['RB', 'QB'], dist: 'poisson', kind: 'td', line: 1, step: 1 },
  { key: 'receptions', label: 'Receptions', pos: ['WR', 'TE', 'RB'], dist: 'gamma', kind: 'recVol', line: 5, step: 1 },
  { key: 'targets', label: 'Targets', pos: ['WR', 'TE', 'RB'], dist: 'gamma', kind: 'recVol', line: 7, step: 1 },
  { key: 'receiving_yards', label: 'Receiving yards', pos: ['WR', 'TE', 'RB'], dist: 'gamma', kind: 'recYds', line: 75, step: 5 },
  { key: 'receiving_tds', label: 'Receiving TDs', pos: ['WR', 'TE', 'RB'], dist: 'poisson', kind: 'td', line: 1, step: 1 },
  { key: 'rush_rec_yards', label: 'Rush + rec yards', pos: ['RB', 'WR', 'TE'], dist: 'gamma', kind: 'yds', line: 100, step: 5 },
  { key: 'anytime_td', label: 'Total TDs (rush + rec)', pos: ['RB', 'WR', 'TE', 'QB'], dist: 'poisson', kind: 'td', line: 1, step: 1 },
  { key: 'fantasy_points_ppr', label: 'Fantasy points (PPR)', pos: ['QB', 'RB', 'WR', 'TE'], dist: 'gamma', kind: 'yds', line: 15, step: 1, continuous: true },
];
export const STAT = Object.fromEntries(STATS.map((s) => [s.key, s]));

const DERIVED = {
  rush_rec_yards: (s) => s.rushing_yards + s.receiving_yards,
  pass_rush_yards: (s) => s.passing_yards + s.rushing_yards,
  anytime_td: (s) => s.rushing_tds + s.receiving_tds,
};

// How each kind of stat responds to game script.
//   total:  elasticity to implied team points (implied / league average) ^ total
//   spread: % change per point the player's team is favored by (positive = favorites do more)
const KIND = {
  passYds: { total: 0.5, spread: -0.004 },
  passVol: { total: 0.25, spread: -0.006 },
  rushYds: { total: 0.5, spread: 0.008 },
  rushVol: { total: 0.3, spread: 0.012 },
  recYds: { total: 0.5, spread: -0.003 },
  recVol: { total: 0.25, spread: -0.004 },
  yds: { total: 0.6, spread: 0 },
  td: { total: 1.0, spread: 0 },
  int: { total: 0, spread: -0.012 },
};

// Tuned by walk-forward backtest on the 2025 season (scripts/backtest.mjs); 2026 is held out.
export const PARAMS = {
  recencyDecay: 0.88, // weight multiplier per game back within the current season
  priorSeasonWeight: 0.3, // weight of each last-season game (same team)
  priorSeasonTeamChangeWeight: 0.12, // ... if the player changed teams
  defCurK: 12, // pseudo-games of league average when regressing a defense factor
  defPrevGames: 3, // pseudo-games of last season's defense factor
  defClamp: [0.7, 1.35],
  cvPoolK: 6, // pseudo-games of position-typical volatility
  homeBoost: 0.015,
  scriptClamp: [0.8, 1.25],
  shrinkK: 0, // pseudo-games of the position-average output mixed into each player's baseline
  shrinkKCount: 6, // ... for TD / INT counts, which are far noisier game to game
  defStrength: 0.6, // exponent applied to the opponent factor
  scriptStrength: 0.5, // exponent applied to the game-script factor (yards / volume)
  scriptStrengthCount: 1, // ... for TD / INT counts
  temper: 0.9, // calibration: p -> logistic(temper * logit(p)); < 1 pulls extremes toward 50%
  adjustHistory: 1, // exponent for opponent-adjusting past games (0 = use raw values)
  varInflate: 1, // multiplier on the gamma variance
  tdDispersion: 0, // extra variance for count stats: var = mean + d * mean^2 (negative binomial)
};

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/* ---------- distributions ---------- */

function lgamma(z) {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61503916999185, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// Regularized lower incomplete gamma P(a, x).
function gammaP(a, x) {
  if (x <= 0) return 0;
  const lnPre = -x + a * Math.log(x) - lgamma(a);
  if (x < a + 1) {
    let sum = 1 / a, term = sum;
    for (let n = 1; n < 500; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-12) break;
    }
    return Math.min(1, sum * Math.exp(lnPre));
  }
  // Lentz continued fraction for Q(a, x)
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return Math.max(0, 1 - Math.exp(lnPre) * h);
}

// A projected distribution with cdf / pdf / quantile helpers.
export function makeDist(stat, mean, variance) {
  const def = STAT[stat];
  if (mean <= 1e-6) {
    return { type: 'point', mean: 0, sd: 0, cdf: (x) => (x >= 0 ? 1 : 0), pAtLeast: (l) => (l <= 0 ? 1 : 0), quantile: () => 0, pdf: () => 0 };
  }
  if (def.dist === 'poisson') {
    // Poisson, or negative binomial when the variance exceeds the mean.
    let pmf;
    if (variance > mean * 1.001) {
      const r = (mean * mean) / (variance - mean), p = r / (r + mean);
      pmf = (k) => (k < 0 ? 0 : Math.exp(lgamma(k + r) - lgamma(r) - lgamma(k + 1) + r * Math.log(p) + k * Math.log(1 - p)));
    } else {
      variance = mean;
      pmf = (k) => (k < 0 ? 0 : Math.exp(k * Math.log(mean) - mean - lgamma(k + 1)));
    }
    const cdf = (x) => { let s = 0; for (let k = 0; k <= Math.floor(x); k++) s += pmf(k); return Math.min(1, s); };
    return {
      type: 'count', mean, sd: Math.sqrt(variance), cdf, pmf,
      pAtLeast: (l) => (l <= 0 ? 1 : 1 - cdf(Math.ceil(l) - 1)),
      quantile: (q) => { let k = 0; while (cdf(k) < q && k < 50) k++; return k; },
    };
  }
  const shape = (mean * mean) / variance, scale = variance / mean;
  const cdf = (x) => gammaP(shape, x / scale);
  // Integer-valued stats: P(X >= l) uses a continuity correction at l - 0.5.
  const cc = def.continuous ? 0 : 0.5;
  return {
    type: 'gamma', mean, sd: Math.sqrt(variance), shape, scale, cdf,
    pAtLeast: (l) => (l - cc <= 0 ? 1 : 1 - cdf(l - cc)),
    pdf: (x) => (x <= 0 ? 0 : Math.exp((shape - 1) * Math.log(x) - x / scale - lgamma(shape) - shape * Math.log(scale))),
    quantile: (q) => {
      let lo = 0, hi = mean + 20 * Math.sqrt(variance);
      for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (cdf(m) < q) lo = m; else hi = m; }
      return (lo + hi) / 2;
    },
  };
}

// Backtests showed raw probabilities run slightly too extreme (week-to-week role changes and
// in-game injuries the stats can't see), so P(X >= line) is pulled toward 50% on the logit scale.
function temperDist(dist, t) {
  if (t === 1 || dist.type === 'point') return dist;
  const raw = dist.pAtLeast;
  return {
    ...dist, rawPAtLeast: raw,
    pAtLeast: (l) => {
      const p = raw(l);
      if (p <= 0 || p >= 1) return p;
      return 1 / (1 + Math.exp(-t * Math.log(p / (1 - p))));
    },
  };
}

/* ---------- model ---------- */

export function createModel(seasonData) {
  const seasons = {};
  for (const [y, d] of Object.entries(seasonData)) {
    const cols = d.statCols;
    const logs = d.logs.map((r) => {
      const s = {};
      cols.forEach((c, i) => { s[c] = r[5 + i]; });
      for (const k in DERIVED) s[k] = DERIVED[k](s);
      return { season: +y, pid: r[0], week: r[1], team: r[2], opp: r[3], home: r[4], s };
    });
    const byPlayer = {};
    for (const g of logs) (byPlayer[g.pid] ||= []).push(g);
    for (const arr of Object.values(byPlayer)) arr.sort((a, b) => a.week - b.week);
    seasons[+y] = { season: +y, players: d.players, logs, byPlayer, schedule: d.schedule };
  }

  const teams = [...new Set(Object.values(seasons).flatMap((S) => S.schedule.flatMap((g) => [g.home, g.away])))].sort();
  const ctxCache = new Map();

  function defenseTable(season, beforeWeek) {
    const S = seasons[season];
    if (!S) return null;
    const agg = {};
    for (const t of teams) agg[t] = { weeks: new Set(), sums: Object.fromEntries(POSITIONS.map((p) => [p, {}])) };
    for (const g of S.logs) {
      if (g.week >= beforeWeek) continue;
      const pos = S.players[g.pid].pos;
      const t = agg[g.opp];
      if (!t) continue;
      t.weeks.add(g.week);
      const sums = t.sums[pos];
      for (const st of STATS) sums[st.key] = (sums[st.key] || 0) + g.s[st.key];
    }
    const out = { teams: {}, league: {} };
    for (const pos of POSITIONS) {
      out.league[pos] = {};
      for (const st of STATS) {
        let tot = 0, games = 0;
        for (const t of teams) { tot += agg[t].sums[pos][st.key] || 0; games += agg[t].weeks.size; }
        out.league[pos][st.key] = games ? tot / games : 0;
      }
    }
    for (const t of teams) {
      const n = agg[t].weeks.size;
      out.teams[t] = { games: n, pos: {} };
      for (const pos of POSITIONS) {
        out.teams[t].pos[pos] = {};
        for (const st of STATS) {
          const perGame = n ? (agg[t].sums[pos][st.key] || 0) / n : null;
          const lg = out.league[pos][st.key];
          out.teams[t].pos[pos][st.key] = { perGame, raw: perGame != null && lg > 0 ? perGame / lg : null };
        }
      }
    }
    // rank 1 = allows the fewest
    for (const pos of POSITIONS) {
      for (const st of STATS) {
        const ranked = teams.filter((t) => out.teams[t].games > 0)
          .sort((a, b) => out.teams[a].pos[pos][st.key].perGame - out.teams[b].pos[pos][st.key].perGame);
        ranked.forEach((t, i) => { out.teams[t].pos[pos][st.key].rank = i + 1; });
        out.rankOf = ranked.length;
      }
    }
    return out;
  }

  // Everything known before kickoff of (season, week).
  function context(season, week) {
    const id = `${season}-${week}`;
    if (ctxCache.has(id)) return ctxCache.get(id);
    const cur = defenseTable(season, week);
    const prev = defenseTable(season - 1, 99);
    const ctx = { season, week, cur, prev, cvPool: {}, posMean: {}, leagueImplied: 22.5 };

    const sched = [...(seasons[season]?.schedule || []), ...(seasons[season - 1]?.schedule || [])].filter((g) => g.total);
    if (sched.length) ctx.leagueImplied = sched.reduce((a, g) => a + g.total / 2, 0) / sched.length;

    // Position-typical game-to-game volatility (coefficient of variation) from last season's
    // regulars: players at or above the position's median per-game output with 6+ games.
    const Sp = seasons[season - 1] || seasons[season];
    for (const pos of POSITIONS) {
      ctx.cvPool[pos] = {};
      for (const st of STATS) {
        const rows = [];
        for (const [pid, games] of Object.entries(Sp.byPlayer)) {
          if (Sp.players[pid].pos !== pos || games.length < 6) continue;
          const v = games.map((g) => g.s[st.key]);
          const m = v.reduce((a, b) => a + b, 0) / v.length;
          if (m <= 0) continue;
          const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
          rows.push({ m, cv: sd / m });
        }
        ctx.posMean[pos] ||= {};
        ctx.posMean[pos][st.key] = rows.length ? rows.reduce((a, r) => a + r.m, 0) / rows.length : 0;
        if (!rows.length) { ctx.cvPool[pos][st.key] = 0.6; continue; }
        const medM = rows.map((r) => r.m).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
        const cvs = rows.filter((r) => r.m >= medM).map((r) => r.cv).sort((a, b) => a - b);
        ctx.cvPool[pos][st.key] = cvs[Math.floor(cvs.length / 2)];
      }
    }
    ctxCache.set(id, ctx);
    return ctx;
  }

  // Opponent factor for `team`'s defense vs `pos` on `key`, regressed toward 1.
  function defFactor(ctx, team, pos, key, which = 'cur') {
    const P = PARAMS;
    if (which === 'prev') {
      const d = ctx.prev?.teams[team];
      if (!d || !d.games) return { factor: 1 };
      const raw = d.pos[pos][key].raw ?? 1;
      return { factor: clamp((d.games * raw + P.defCurK) / (d.games + P.defCurK), ...P.defClamp) };
    }
    const c = ctx.cur?.teams[team];
    const p = ctx.prev?.teams[team];
    const n = c?.games || 0;
    const rawCur = n ? c.pos[pos][key].raw ?? 1 : null;
    const rawPrev = p?.games ? p.pos[pos][key].raw ?? 1 : null;
    const kp = rawPrev != null ? P.defPrevGames : 0;
    const factor = clamp(((rawCur ?? 0) * n + (rawPrev ?? 0) * kp + P.defCurK) / (n + kp + P.defCurK), ...P.defClamp);
    return {
      factor, rawCur, rawPrev, games: n,
      perGame: n ? c.pos[pos][key].perGame : null,
      leagueAvg: ctx.cur?.league[pos][key],
      rank: n ? c.pos[pos][key].rank : null,
      rankOf: ctx.cur?.rankOf,
      prevPerGame: p?.games ? p.pos[pos][key].perGame : null,
      prevRank: p?.games ? p.pos[pos][key].rank : null,
    };
  }

  function playerInfo(pid, season) {
    return seasons[season]?.players[pid] || seasons[season - 1]?.players[pid] || null;
  }

  function priorGames(pid, season, week) {
    const cur = (seasons[season]?.byPlayer[pid] || []).filter((g) => g.week < week);
    const prev = seasons[season - 1]?.byPlayer[pid] || [];
    return { cur, prev };
  }

  function currentTeam(pid, season, week) {
    const { cur, prev } = priorGames(pid, season, week);
    if (cur.length) return cur[cur.length - 1].team;
    return seasons[season]?.players[pid]?.team || prev[prev.length - 1]?.team || null;
  }

  /**
   * Project one stat for one game.
   * game: { opp, home: 1 | 0 | null, spread: points the player's team is favored by (or null),
   *         total: game over/under (or null) }
   */
  function project(season, week, pid, key, game) {
    const ctx = context(season, week);
    const st = STAT[key];
    const info = playerInfo(pid, season);
    if (!info) return null;
    const pos = info.pos;
    const P = PARAMS;
    const { cur, prev } = priorGames(pid, season, week);
    if (!cur.length && !prev.length) return null;
    const team = currentTeam(pid, season, week);

    // 1. Baseline: opponent-adjusted, recency-weighted per-game average.
    const samples = [];
    cur.slice().reverse().forEach((g, i) => {
      const f = defFactor(ctx, g.opp, pos, key).factor ** P.adjustHistory;
      samples.push({ v: g.s[key] / f, raw: g.s[key], w: P.recencyDecay ** i, g });
    });
    const prevW = prev.length && prev[prev.length - 1].team !== team ? P.priorSeasonTeamChangeWeight : P.priorSeasonWeight;
    for (const g of prev) {
      const f = defFactor(ctx, g.opp, pos, key, 'prev').factor ** P.adjustHistory;
      samples.push({ v: g.s[key] / f, raw: g.s[key], w: prevW, g });
    }
    const W = samples.reduce((a, s) => a + s.w, 0);
    const W2 = samples.reduce((a, s) => a + s.w * s.w, 0);
    const sampleMean = samples.reduce((a, s) => a + s.w * s.v, 0) / W;
    const posMean = ctx.posMean[pos][key] ?? sampleMean;
    const shrinkK = st.dist === 'poisson' ? P.shrinkKCount : P.shrinkK;
    const base = (W * sampleMean + shrinkK * posMean) / (W + shrinkK);
    const nEff = (W * W) / W2;
    const curWeightShare = samples.filter((s) => s.g.season === season).reduce((a, s) => a + s.w, 0) / W;
    const rawCurAvg = cur.length ? cur.reduce((a, g) => a + g.s[key], 0) / cur.length : null;
    const rawPrevAvg = prev.length ? prev.reduce((a, g) => a + g.s[key], 0) / prev.length : null;

    // 2. Opponent.
    const def = game.opp ? defFactor(ctx, game.opp, pos, key) : { factor: 1 };

    // 3. Game script from the betting line.
    const k = KIND[st.kind];
    let script = { factor: 1 };
    if (game.total != null) {
      const spread = game.spread ?? 0;
      const implied = game.total / 2 + spread / 2;
      const totalF = (implied / ctx.leagueImplied) ** k.total;
      const spreadF = 1 + k.spread * spread;
      script = { factor: clamp(totalF * spreadF, ...P.scriptClamp), implied, oppImplied: game.total - implied, totalF, spreadF, league: ctx.leagueImplied };
    }

    // 4. Venue.
    let venue = 1;
    if (game.home === 1) venue = st.kind === 'int' ? 1 - P.homeBoost : 1 + P.homeBoost;
    else if (game.home === 0) venue = st.kind === 'int' ? 1 + P.homeBoost : 1 - P.homeBoost;

    const defF = def.factor ** P.defStrength;
    const scriptF = script.factor ** (st.dist === 'poisson' ? P.scriptStrengthCount : P.scriptStrength);
    const mean = Math.max(0, base * defF * scriptF * venue);

    // 5. Spread of outcomes.
    let variance = 0;
    if (st.dist === 'gamma' && base > 0) {
      const cvPool = ctx.cvPool[pos][key] ?? 0.6;
      const wVar = samples.reduce((a, s) => a + s.w * (s.v - sampleMean) ** 2, 0) / W * (nEff / Math.max(1, nEff - 1));
      const cvPlayer = sampleMean > 0 ? Math.sqrt(wVar) / sampleMean : cvPool;
      const cv2 = (nEff * cvPlayer ** 2 + P.cvPoolK * cvPool ** 2) / (nEff + P.cvPoolK);
      variance = P.varInflate * cv2 * mean * mean * (1 + 1 / nEff);
    } else if (st.dist === 'poisson') {
      variance = mean + P.tdDispersion * mean * mean;
    }
    const dist = temperDist(makeDist(key, mean, variance), P.temper);

    return {
      pid, key, pos, team, info, game, dist, mean,
      baseline: { value: base, sampleMean, posMean, shrinkShare: shrinkK / (W + shrinkK), nCur: cur.length, nPrev: prev.length, nEff, curWeightShare, rawCurAvg, rawPrevAvg, prevW },
      def: { ...def, applied: defF }, script: { ...script, applied: scriptF }, venue,
      logs: { cur, prev },
    };
  }

  // Schedule helpers -----------------------------------------------------------
  function teamGame(season, team, week) {
    return seasons[season]?.schedule.find((g) => g.week === week && (g.home === team || g.away === team)) || null;
  }

  // Convert a schedule row to the perspective of `team`.
  function gameFor(team, g) {
    if (!g) return null;
    const home = g.home === team;
    return {
      week: g.week, date: g.date, time: g.time, id: g.id,
      opp: home ? g.away : g.home, home: home ? 1 : 0,
      spread: g.spread == null ? null : home ? g.spread : -g.spread,
      total: g.total, roof: g.roof, played: g.hs != null,
      score: g.hs == null ? null : home ? [g.hs, g.as] : [g.as, g.hs],
    };
  }

  return { seasons, teams, context, project, defFactor, playerInfo, currentTeam, priorGames, teamGame, gameFor };
}
