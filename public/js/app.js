import { createModel, STATS, STAT, PARAMS } from './model.js';
import { distChart, logChart, reliabilityChart, scoreBars, pct, fmtNum } from './charts.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TEAM_NAMES = {
  ARI: 'Arizona Cardinals', ATL: 'Atlanta Falcons', BAL: 'Baltimore Ravens', BUF: 'Buffalo Bills', CAR: 'Carolina Panthers',
  CHI: 'Chicago Bears', CIN: 'Cincinnati Bengals', CLE: 'Cleveland Browns', DAL: 'Dallas Cowboys', DEN: 'Denver Broncos',
  DET: 'Detroit Lions', GB: 'Green Bay Packers', HOU: 'Houston Texans', IND: 'Indianapolis Colts', JAX: 'Jacksonville Jaguars',
  KC: 'Kansas City Chiefs', LA: 'Los Angeles Rams', LAC: 'Los Angeles Chargers', LV: 'Las Vegas Raiders', MIA: 'Miami Dolphins',
  MIN: 'Minnesota Vikings', NE: 'New England Patriots', NO: 'New Orleans Saints', NYG: 'New York Giants', NYJ: 'New York Jets',
  PHI: 'Philadelphia Eagles', PIT: 'Pittsburgh Steelers', SEA: 'Seattle Seahawks', SF: 'San Francisco 49ers', TB: 'Tampa Bay Buccaneers',
  TEN: 'Tennessee Titans', WAS: 'Washington Commanders',
};
const DEFAULT_STAT = { QB: 'passing_yards', RB: 'rushing_yards', WR: 'receiving_yards', TE: 'receiving_yards' };
const OPP_STATS = {
  QB: ['passing_yards', 'passing_tds', 'passing_interceptions', 'completions', 'rushing_yards', 'fantasy_points_ppr'],
  RB: ['rushing_yards', 'carries', 'rushing_tds', 'receptions', 'receiving_yards', 'fantasy_points_ppr'],
  WR: ['targets', 'receptions', 'receiving_yards', 'receiving_tds', 'fantasy_points_ppr'],
  TE: ['targets', 'receptions', 'receiving_yards', 'receiving_tds', 'fantasy_points_ppr'],
};
const unitOf = (key) => STAT[key].label.toLowerCase();

let model, meta, calibration, SEASON, NEXT_WEEK, roster;
const state = { pid: null, key: null, line: null, week: null, custom: false, opp: null, home: null, spread: null, total: null };

/* ---------------- boot ---------------- */

async function boot() {
  initTheme();
  const get = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); });
  meta = await get('data/meta.json');
  SEASON = meta.current;
  const [prev, cur] = await Promise.all([get(`data/season_${SEASON - 1}.json`), get(`data/season_${SEASON}.json`)]);
  calibration = await get('data/calibration.json').catch(() => null);
  model = createModel({ [SEASON - 1]: prev, [SEASON]: cur });
  NEXT_WEEK = Math.min(18, meta.lastCompletedWeek + 1);

  $('stamp').textContent = `${SEASON} stats through Week ${meta.lastCompletedWeek} · updated ${meta.built}`;

  // Search ranks players by this season's PPR points so starters surface first.
  const S = model.seasons[SEASON];
  roster = Object.entries(S.players).map(([pid, p]) => ({
    pid, ...p, fp: (S.byPlayer[pid] || []).reduce((a, g) => a + g.s.fantasy_points_ppr, 0),
  })).sort((a, b) => b.fp - a.fp);

  for (const t of model.teams) $('oppSelect').add(new Option(`${t} – ${TEAM_NAMES[t] || t}`, t));
  wireTabs();
  wirePredict();
  wireBoard();
  wireDefense();
  renderMethod();

  const fromHash = readHash();
  const fallback = roster.find((p) => p.name === 'Derrick Henry') || roster.find((p) => p.pos === 'RB');
  selectPlayer(fromHash?.pid && S.players[fromHash.pid] ? fromHash.pid : fallback.pid, fromHash || {});
  window.addEventListener('resize', debounce(() => { renderPredict(); }, 150));
}

/* ---------------- tabs, theme, hash ---------------- */

function wireTabs() {
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { showTab(b.dataset.tab); window.scrollTo(0, 0); }));
}
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
  if (name === 'board') renderBoard();
  if (name === 'defense') renderDefense();
  if (name === 'method') renderMethod();
  if (name === 'predict') renderPredict();
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch { /* storage unavailable */ }
  if (saved) document.documentElement.dataset.theme = saved;
  $('themeToggle').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch { /* ignore */ }
  });
}

function writeHash() {
  const p = new URLSearchParams({ p: state.pid, s: state.key, l: state.line, w: state.week });
  history.replaceState(null, '', `#${p}`);
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.get('p')) return null;
  return { pid: p.get('p'), key: p.get('s'), line: p.get('l') != null ? +p.get('l') : null, week: p.get('w') ? +p.get('w') : null };
}

/* ---------------- predict tab ---------------- */

function wirePredict() {
  const input = $('playerSearch'), list = $('playerList');
  let hi = 0, matches = [];
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); };
  const draw = () => {
    list.innerHTML = matches.map((p, i) => `
      <li role="option" data-pid="${p.pid}" aria-selected="${i === hi}">
        <img src="${esc(p.headshot || '')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        <div><div>${esc(p.name)}</div><div class="meta">${p.pos} · ${p.team}</div></div>
      </li>`).join('');
    list.hidden = !matches.length;
    input.setAttribute('aria-expanded', String(!list.hidden));
  };
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { close(); return; }
    const words = q.split(/\s+/);
    matches = roster.filter((p) => words.every((w) => p.name.toLowerCase().includes(w) || p.team.toLowerCase() === w || p.pos.toLowerCase() === w)).slice(0, 10);
    hi = 0;
    draw();
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { hi = Math.min(matches.length - 1, hi + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { hi = Math.max(0, hi - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter' && matches[hi]) { pick(matches[hi].pid); e.preventDefault(); }
    else if (e.key === 'Escape') close();
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li');
    if (li) { pick(li.dataset.pid); e.preventDefault(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 100));
  const pick = (pid) => { input.value = ''; close(); selectPlayer(pid); };

  $('statSelect').addEventListener('change', (e) => { state.key = e.target.value; state.line = null; renderPredict(); });
  const setLine = (v) => { state.line = Math.max(0, v); renderPredict(); };
  $('lineInput').addEventListener('input', (e) => { if (e.target.value !== '') setLine(+e.target.value); });
  $('lineUp').addEventListener('click', () => setLine((state.line ?? 0) + STAT[state.key].step));
  $('lineDown').addEventListener('click', () => setLine((state.line ?? 0) - STAT[state.key].step));

  $('gameSelect').addEventListener('change', (e) => {
    if (e.target.value === 'custom') { state.custom = true; state.week = state.week ?? NEXT_WEEK; }
    else applyGame(+e.target.value);
    renderPredict();
  });
  const goCustom = () => { state.custom = true; $('gameSelect').value = 'custom'; };
  $('oppSelect').addEventListener('change', (e) => { state.opp = e.target.value; goCustom(); renderPredict(); });
  $('venueSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.home = b.dataset.v === '' ? null : +b.dataset.v;
    goCustom();
    renderPredict();
  });
  const num = (v) => (v === '' ? null : +v);
  $('spreadInput').addEventListener('input', (e) => { state.spread = num(e.target.value); goCustom(); renderPredict(); });
  $('totalInput').addEventListener('input', (e) => { state.total = num(e.target.value); goCustom(); renderPredict(); });
}

function teamSchedule(team) {
  return model.seasons[SEASON].schedule
    .filter((g) => g.home === team || g.away === team)
    .sort((a, b) => a.week - b.week)
    .map((g) => model.gameFor(team, g));
}

function selectPlayer(pid, opts = {}) {
  state.pid = pid;
  const info = model.playerInfo(pid, SEASON);
  const team = model.currentTeam(pid, SEASON, 99);
  const valid = STATS.filter((s) => s.pos.includes(info.pos));
  state.key = opts.key && valid.some((s) => s.key === opts.key) ? opts.key : DEFAULT_STAT[info.pos];
  state.line = opts.line ?? null;

  $('statSelect').innerHTML = '';
  for (const s of valid) $('statSelect').add(new Option(s.label, s.key));
  $('statSelect').value = state.key;

  const games = teamSchedule(team);
  const sel = $('gameSelect');
  sel.innerHTML = '';
  for (const g of games) {
    const when = g.date ? new Date(`${g.date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
    const result = g.played ? ` · ${g.score[0] > g.score[1] ? 'W' : g.score[0] < g.score[1] ? 'L' : 'T'} ${g.score[0]}–${g.score[1]}` : '';
    sel.add(new Option(`Wk ${g.week} · ${g.home ? 'vs' : '@'} ${g.opp} · ${when}${result}`, g.week));
  }
  sel.add(new Option('Custom matchup…', 'custom'));
  const week = opts.week && games.some((g) => g.week === opts.week) ? opts.week
    : (games.find((g) => g.week >= NEXT_WEEK) || games[games.length - 1]).week;
  applyGame(week);

  const p = roster.find((r) => r.pid === pid) || info;
  $('playerCard').innerHTML = `
    <img src="${esc(info.headshot || '')}" alt="" onerror="this.style.visibility='hidden'">
    <div>
      <div class="name">${esc(info.name)}</div>
      <div class="meta">${info.pos} · ${TEAM_NAMES[team] || team}</div>
      <div class="meta">${(model.seasons[SEASON].byPlayer[pid] || []).length} games in ${SEASON}${p.fp ? ` · ${p.fp.toFixed(1)} PPR pts` : ''}</div>
    </div>`;
  showTab('predict');
}

function applyGame(week) {
  const team = model.currentTeam(state.pid, SEASON, 99);
  const g = model.gameFor(team, model.teamGame(SEASON, team, week));
  state.custom = false;
  state.week = week;
  state.opp = g?.opp ?? null;
  state.home = g?.home ?? null;
  state.spread = g?.spread ?? null;
  state.total = g?.total ?? null;
  $('gameSelect').value = String(week);
}

function syncControls() {
  $('oppSelect').value = state.opp || '';
  document.querySelectorAll('#venueSeg button').forEach((b) => {
    b.setAttribute('aria-pressed', String((b.dataset.v === '' ? null : +b.dataset.v) === state.home));
  });
  if (document.activeElement !== $('spreadInput')) $('spreadInput').value = state.spread ?? '';
  if (document.activeElement !== $('totalInput')) $('totalInput').value = state.total ?? '';
  if (document.activeElement !== $('lineInput')) $('lineInput').value = state.line;
  $('lineInput').step = STAT[state.key].step;
  const g = state.custom ? null : model.teamGame(SEASON, model.currentTeam(state.pid, SEASON, 99), state.week);
  $('lineHint').textContent = state.custom
    ? 'Custom matchup: edit any field to explore hypotheticals.'
    : state.total == null
      ? 'No Vegas line posted for this game yet. Enter a spread and total to include game script.'
      : g?.hs != null
        ? 'This game has been played. The prediction uses only data from before kickoff, so you can check it against the result.'
        : 'Spread and total prefilled from the betting market. Edit to explore.';
}

function defaultLine(proj) {
  const st = STAT[proj.key];
  if (proj.mean >= 0.4 * st.line) return st.line;
  const med = proj.dist.quantile(0.5);
  return Math.max(1, Math.round(med / st.step) * st.step || st.step);
}

function verdict(p) {
  if (p >= 0.75) return 'Very likely';
  if (p >= 0.6) return 'Likely';
  if (p >= 0.45) return 'Toss-up';
  if (p >= 0.25) return 'Unlikely';
  return 'Long shot';
}
const american = (p) => (p <= 0 || p >= 1 ? '–' : p >= 0.5 ? `${Math.round((-100 * p) / (1 - p))}` : `+${Math.round((100 * (1 - p)) / p)}`);

function renderPredict() {
  if (!state.pid || $('tab-predict').hidden) return;
  const info = model.playerInfo(state.pid, SEASON);
  const game = { opp: state.opp, home: state.home, spread: state.spread, total: state.total };
  const week = state.week ?? NEXT_WEEK;
  const proj = model.project(SEASON, week, state.pid, state.key, game);
  if (!proj) {
    $('hero').innerHTML = '<p class="empty">Not enough data to project this player before this week.</p>';
    return;
  }
  if (state.line == null) state.line = defaultLine(proj);
  syncControls();
  writeHash();

  const st = STAT[state.key];
  const line = state.line;
  const p = proj.dist.pAtLeast(line);
  const unit = unitOf(state.key);
  const team = proj.team;
  const where = state.home === 1 ? 'vs' : state.home === 0 ? '@' : 'vs';
  const oppTxt = state.opp ? `${where} ${state.opp}` : 'vs an average defense';
  const curGames = proj.logs.cur;
  const curHits = curGames.filter((g) => g.s[state.key] >= line).length;
  const lineTxt = `${fmtNum(line)}+ ${unit}`;

  // Was this game already played?
  const actualLog = !state.custom ? (model.seasons[SEASON].byPlayer[state.pid] || []).find((g) => g.week === week) : null;
  const sched = !state.custom ? model.teamGame(SEASON, team, week) : null;
  let actual = '';
  if (sched?.hs != null) {
    actual = actualLog
      ? `<div class="actual">Result: ${esc(info.name)} finished with <b class="${actualLog.s[state.key] >= line ? 'hit' : 'miss'}">${fmtNum(actualLog.s[state.key])} ${unit}</b> ${actualLog.s[state.key] >= line ? '✓ cleared the line' : '✗ fell short'}.</div>`
      : `<div class="actual">Result: no stats recorded for ${esc(info.name)} in this game (likely inactive).</div>`;
  }

  $('hero').innerHTML = `
    <div class="hero-prob">${pct(p).replace('%', '')}<small>%</small></div>
    <div>
      <div class="hero-q">Chance ${esc(info.name)} records ${lineTxt} ${oppTxt}
        <span class="sub">${state.custom ? 'Custom matchup' : `Week ${week}`} · Under ${fmtNum(line)}: ${pct(1 - p)} · Fair odds ${american(p)} / ${american(1 - p)}</span>
      </div>
      <span class="verdict"><i></i>${verdict(p)}</span>
    </div>
    <div class="meter" role="img" aria-label="${pct(p)} probability"><i style="width:${(p * 100).toFixed(1)}%"></i></div>
    <div class="tiles">
      <div class="tile"><div class="k">Projection</div><div class="v">${fmtNum(proj.mean, 1)}</div></div>
      <div class="tile"><div class="k">Median</div><div class="v">${fmtNum(proj.dist.quantile(0.5), st.dist === 'poisson' ? 0 : 1)}</div></div>
      <div class="tile"><div class="k">80% range</div><div class="v">${fmtNum(proj.dist.quantile(0.1), 0)}–${fmtNum(proj.dist.quantile(0.9), 0)}</div></div>
      <div class="tile"><div class="k">${SEASON} avg</div><div class="v">${proj.baseline.rawCurAvg == null ? '–' : fmtNum(proj.baseline.rawCurAvg, 1)}</div></div>
      <div class="tile"><div class="k">${SEASON} hit rate</div><div class="v">${curGames.length ? `${curHits}/${curGames.length}` : '–'}</div></div>
    </div>
    ${actual}`;

  renderWaterfall(proj, info, line, p);

  $('distSub').textContent = `Where ${info.name}'s ${unit} are likely to land. Hover a bar for its probability.`;
  distChart($('distChart'), { dist: proj.dist, line, statLabel: unit, continuous: st.continuous });

  const prevGames = proj.logs.prev;
  const prevHits = prevGames.filter((g) => g.s[state.key] >= line).length;
  $('logSub').textContent = [
    curGames.length ? `${SEASON}: cleared ${curHits} of ${curGames.length} (${pct(curHits / curGames.length)})` : `No ${SEASON} games before Week ${week}`,
    prevGames.length ? `${SEASON - 1}: ${prevHits} of ${prevGames.length} (${pct(prevHits / prevGames.length)})` : null,
  ].filter(Boolean).join(' · ');
  logChart($('logChart'), { games: [...prevGames, ...curGames], key: state.key, line, statLabel: unit, season: SEASON });

  renderOppTable(proj);
}

function renderWaterfall(proj, info, line, p) {
  const st = STAT[proj.key];
  const unit = unitOf(proj.key);
  const b = proj.baseline;
  const posName = { QB: 'QBs', RB: 'RBs', WR: 'WRs', TE: 'TEs' }[proj.pos];
  const mult = (f) => {
    const cls = f > 1.005 ? 'up' : f < 0.995 ? 'down' : '';
    return `<span class="val ${cls}">×${f.toFixed(3)}</span>`;
  };
  const rows = [];

  const parts = [];
  if (b.nCur) parts.push(`<b>${b.nCur}</b> game${b.nCur > 1 ? 's' : ''} in ${SEASON} (raw avg <b>${fmtNum(b.rawCurAvg, 1)}</b>, most recent weighted heaviest)`);
  if (b.nPrev) parts.push(`<b>${b.nPrev}</b> in ${SEASON - 1} (raw avg <b>${fmtNum(b.rawPrevAvg, 1)}</b>, each counted ${b.prevW < PARAMS.priorSeasonWeight ? 'lightly because the player changed teams' : `at ${Math.round(b.prevW * 100)}% weight`})`);
  let baseWhy = `Per-game ${unit} from ${parts.join(' and ')}. Each past game is adjusted for how hard that week's defense was. ${SEASON} games carry ${Math.round(b.curWeightShare * 100)}% of the weight.`;
  if (b.shrinkShare > 0.02) baseWhy += ` Blended ${Math.round(b.shrinkShare * 100)}% toward the typical ${proj.pos} starter (${fmtNum(b.posMean, 2)}) because scoring plays are very noisy week to week.`;
  rows.push(`<li><span class="lbl">Baseline</span><span class="val">${fmtNum(b.value, 1)}</span><span class="why">${baseWhy}</span></li>`);

  const d = proj.def;
  let defWhy;
  if (!state.opp) defWhy = 'No opponent selected, so the model assumes a league-average defense.';
  else if (d.games) {
    const diff = d.rawCur - 1;
    defWhy = `<b>${state.opp}</b> has allowed <b>${fmtNum(d.perGame, 1)}</b> ${unit} per game to ${posName} in ${SEASON}, ${Math.abs(diff * 100).toFixed(0)}% ${diff >= 0 ? 'more' : 'less'} than the league average of ${fmtNum(d.leagueAvg, 1)} (rank <b>${d.rank} of ${d.rankOf}</b>, 1 = stingiest).`;
    if (d.prevPerGame != null) defWhy += ` In ${SEASON - 1}: ${fmtNum(d.prevPerGame, 1)}/game (rank ${d.prevRank}).`;
    defWhy += ` ${d.games} games is a small sample, so the effect is regressed toward average and dampened to the strength the backtest supports.`;
  } else defWhy = `${state.opp} has no ${SEASON} games yet; using last season's numbers, heavily regressed.`;
  rows.push(`<li><span class="lbl">Opponent</span>${mult(d.applied ?? 1)}<span class="why">${defWhy}</span></li>`);

  const s = proj.script;
  let scriptWhy;
  if (state.total == null) scriptWhy = 'No spread or total entered, so game script is neutral.';
  else {
    const fav = (state.spread ?? 0) > 0 ? `favored by ${state.spread}` : (state.spread ?? 0) < 0 ? `a ${-state.spread}-point underdog` : 'a pick’em';
    const kindNote = { passYds: 'Trailing teams throw more, so underdogs get a small passing bump.', passVol: 'Trailing teams throw more.', rushYds: 'Teams protecting a lead run more, so favorites get a rushing bump.', rushVol: 'Teams protecting a lead run more.', recYds: 'Underdogs throw more.', recVol: 'Underdogs throw more.', yds: '', td: 'Touchdown chances scale with how many points the team is expected to score.', int: 'Trailing QBs force more throws into coverage.' }[st.kind];
    scriptWhy = `${proj.team} is ${fav} with a total of ${state.total}, which implies <b>${s.implied.toFixed(1)}</b> points for ${proj.team} vs a league average of ${s.league.toFixed(1)}. ${kindNote}`;
  }
  rows.push(`<li><span class="lbl">Game script</span>${mult(s.applied ?? 1)}<span class="why">${scriptWhy}</span></li>`);

  const venueWhy = state.home === 1 ? 'Small home-field boost.' : state.home === 0 ? 'Small road penalty.' : 'Neutral site.';
  rows.push(`<li><span class="lbl">Venue</span>${mult(proj.venue)}<span class="why">${venueWhy}</span></li>`);

  rows.push(`<li class="total"><span class="lbl">Projection</span><span class="val">${fmtNum(proj.mean, 1)}</span><span class="why">Expected ${unit} for this game.</span></li>`);

  const distWhy = st.dist === 'poisson'
    ? `Touchdowns and interceptions are rare events, so they're modeled as a Poisson count with mean ${proj.mean.toFixed(2)}.`
    : `Outcomes are modeled with a right-skewed gamma distribution (SD ≈ ${fmtNum(proj.dist.sd, 1)}), using ${info.name}'s own week-to-week volatility blended with the norm for ${posName}, widened to account for uncertainty in the projection itself.`;
  rows.push(`<li class="total"><span class="lbl">P(${fmtNum(line)}+)</span><span class="val">${pct(p, 1)}</span><span class="why">${distWhy} Final probabilities get a small calibration adjustment fitted on the ${SEASON - 1} backtest.</span></li>`);

  $('waterfall').innerHTML = rows.join('');
}

function renderOppTable(proj) {
  const pos = proj.pos;
  const posName = { QB: 'QBs', RB: 'RBs', WR: 'WRs', TE: 'TEs' }[pos];
  if (!state.opp) {
    $('oppTitle').textContent = 'Opponent defense';
    $('oppSub').textContent = 'Pick an opponent to see how it defends this position.';
    $('oppTable').innerHTML = '';
    return;
  }
  $('oppTitle').textContent = `${TEAM_NAMES[state.opp] || state.opp} vs ${posName}`;
  const ctx = model.context(SEASON, state.week ?? NEXT_WEEK);
  const keys = [...new Set([proj.key, ...OPP_STATS[pos]])].filter((k) => STAT[k]);
  $('oppSub').textContent = `What ${state.opp} has allowed to opposing ${posName} per game, before Week ${ctx.week}. Rank 1 = allows the least.`;
  const rows = keys.map((k) => {
    const d = model.defFactor(ctx, state.opp, pos, k);
    const diff = d.rawCur == null ? null : d.rawCur - 1;
    const tag = diff == null ? '' : diff > 0.08 ? '<span class="tag soft">Soft</span>' : diff < -0.08 ? '<span class="tag tough">Tough</span>' : '<span class="tag">Average</span>';
    return `<tr${k === proj.key ? ' style="background:var(--accent-wash)"' : ''}>
      <td>${STAT[k].label}</td>
      <td class="num">${fmtNum(d.perGame, 1)}</td>
      <td class="num">${fmtNum(d.leagueAvg, 1)}</td>
      <td class="num">${diff == null ? '–' : `${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(0)}%`}</td>
      <td class="num">${d.rank ?? '–'}</td>
      <td>${tag}</td>
      <td class="num">${fmtNum(d.prevPerGame, 1)} <span class="rank">#${d.prevRank ?? '–'}</span></td>
    </tr>`;
  });
  $('oppTable').innerHTML = `<table>
    <thead><tr><th>Stat</th><th class="num">${SEASON} allowed/g</th><th class="num">League avg</th><th class="num">vs avg</th><th class="num">Rank</th><th></th><th class="num">${SEASON - 1} /g (rank)</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>`;
}

/* ---------------- weekly board ---------------- */

function wireBoard() {
  const wk = $('boardWeek');
  const weeks = [...new Set(model.seasons[SEASON].schedule.map((g) => g.week))].sort((a, b) => a - b);
  for (const w of weeks) wk.add(new Option(`Week ${w}${w <= meta.lastCompletedWeek ? ' (played)' : w === NEXT_WEEK ? ' (next)' : ''}`, w));
  wk.value = NEXT_WEEK;
  for (const s of STATS) $('boardStat').add(new Option(s.label, s.key));
  $('boardStat').value = 'rushing_yards';
  $('boardLine').value = 100;
  $('boardStat').addEventListener('change', () => { $('boardLine').value = STAT[$('boardStat').value].line; renderBoard(); });
  for (const id of ['boardWeek', 'boardPos']) $(id).addEventListener('change', renderBoard);
  $('boardLine').addEventListener('input', debounce(renderBoard, 200));
  $('boardTable').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-pid]');
    if (tr) selectPlayer(tr.dataset.pid, { key: $('boardStat').value, line: +$('boardLine').value, week: +$('boardWeek').value });
  });
}

function renderBoard() {
  if ($('tab-board').hidden) return;
  const week = +$('boardWeek').value, key = $('boardStat').value, line = +$('boardLine').value, posF = $('boardPos').value;
  const st = STAT[key];
  const S = model.seasons[SEASON];
  const activeSince = Math.min(week - 1, meta.lastCompletedWeek) - 1;
  const rows = [];
  for (const p of roster) {
    if (!st.pos.includes(p.pos) || (posF && p.pos !== posF)) continue;
    const prior = (S.byPlayer[p.pid] || []).filter((g) => g.week < week);
    if (!prior.length || prior[prior.length - 1].week < activeSince) continue;
    const team = model.currentTeam(p.pid, SEASON, week);
    const g = model.gameFor(team, model.teamGame(SEASON, team, week));
    if (!g) continue;
    const proj = model.project(SEASON, week, p.pid, key, g);
    if (!proj || proj.mean <= 0) continue;
    const actual = (S.byPlayer[p.pid] || []).find((x) => x.week === week);
    rows.push({ p, team, g, proj, prob: proj.dist.pAtLeast(line), hits: prior.filter((x) => x.s[key] >= line).length, n: prior.length, actual });
  }
  rows.sort((a, b) => b.prob - a.prob || b.proj.mean - a.proj.mean);
  const played = week <= meta.lastCompletedWeek;
  const shown = rows.slice(0, 75);
  if (!shown.length) { $('boardTable').innerHTML = '<p class="empty">No eligible players for this selection.</p>'; return; }
  $('boardTable').innerHTML = `<table>
    <thead><tr><th>#</th><th>Player</th><th>Game</th><th class="num">Spread / total</th><th class="num">Projection</th><th class="num">P(${fmtNum(line)}+ ${esc(st.label.toLowerCase())})</th><th class="num">${SEASON} hit rate</th>${played ? '<th class="num">Actual</th>' : ''}</tr></thead>
    <tbody>${shown.map((r, i) => `
      <tr class="clickable" data-pid="${r.p.pid}">
        <td class="num">${i + 1}</td>
        <td><div class="cell-player"><img class="avatar" src="${esc(r.p.headshot || '')}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"><div>${esc(r.p.name)} <span class="rank">${r.p.pos} · ${r.team}</span></div></div></td>
        <td>${r.g.home ? 'vs' : '@'} ${r.g.opp}</td>
        <td class="num">${r.g.spread == null ? '–' : `${r.g.spread > 0 ? '−' : '+'}${Math.abs(r.g.spread)}`} / ${r.g.total ?? '–'}</td>
        <td class="num">${fmtNum(r.proj.mean, 1)}</td>
        <td class="num"><div class="pbar"><i><b style="width:${(r.prob * 100).toFixed(1)}%"></b></i><b>${pct(r.prob)}</b></div></td>
        <td class="num">${r.hits}/${r.n}</td>
        ${played ? `<td class="num">${r.actual ? `${fmtNum(r.actual.s[key])} ${r.actual.s[key] >= line ? '✓' : '✗'}` : '–'}</td>` : ''}
      </tr>`).join('')}</tbody></table>
    ${played ? boardScore(rows, line, key) : ''}`;
}

function boardScore(rows, line, key) {
  const scored = rows.filter((r) => r.actual);
  if (!scored.length) return '';
  const expected = scored.reduce((a, r) => a + r.prob, 0);
  const got = scored.filter((r) => r.actual.s[key] >= line).length;
  return `<p class="hint" style="margin-top:12px">Week check: the model expected <b>${expected.toFixed(1)}</b> of these ${scored.length} players to clear the line; <b>${got}</b> did.</p>`;
}

/* ---------------- defense tab ---------------- */

let defSort = { key: null, asc: false };
function wireDefense() {
  $('defPos').addEventListener('change', () => { defSort = { key: null, asc: false }; renderDefense(); });
  $('defTable').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-k]');
    if (!th) return;
    defSort = { key: th.dataset.k, asc: defSort.key === th.dataset.k ? !defSort.asc : false };
    renderDefense();
  });
}

function heat(raw) {
  if (raw == null) return '';
  const t = Math.max(-1, Math.min(1, (raw - 1) / 0.35));
  const pctMix = Math.round(Math.abs(t) * 55);
  return `background:color-mix(in oklab, var(${t >= 0 ? '--div-hi' : '--div-lo'}) ${pctMix}%, var(--div-mid))`;
}

function renderDefense() {
  if ($('tab-defense').hidden) return;
  const pos = $('defPos').value;
  const ctx = model.context(SEASON, NEXT_WEEK);
  const keys = OPP_STATS[pos];
  $('defSub').textContent = `Per-game production allowed to opposing ${pos}s in ${SEASON} (through Week ${meta.lastCompletedWeek}). Rank 1 = allows the least. Click a column to sort.`;
  const sortKey = defSort.key || keys[0];
  const teams = model.teams.filter((t) => ctx.cur.teams[t]?.games);
  teams.sort((a, b) => {
    const va = sortKey === 'team' ? a : ctx.cur.teams[a].pos[pos][sortKey].perGame;
    const vb = sortKey === 'team' ? b : ctx.cur.teams[b].pos[pos][sortKey].perGame;
    const c = sortKey === 'team' ? va.localeCompare(vb) : vb - va;
    return defSort.asc ? -c : c;
  });
  const th = (k, label, num = true) => `<th class="sortable ${num ? 'num' : ''} ${sortKey === k ? `sorted ${defSort.asc ? 'asc' : ''}` : ''}" data-k="${k}">${label}</th>`;
  $('defTable').innerHTML = `<table>
    <thead><tr>${th('team', 'Defense', false)}<th class="num">Games</th>${keys.map((k) => th(k, STAT[k].label)).join('')}</tr></thead>
    <tbody>${teams.map((t) => {
      const d = ctx.cur.teams[t];
      return `<tr><td><b>${t}</b> <span class="rank">${TEAM_NAMES[t] || ''}</span></td><td class="num">${d.games}</td>${keys.map((k) => {
        const c = d.pos[pos][k];
        return `<td class="num"><span class="heat" style="${heat(c.raw)}" title="${((c.raw - 1) * 100).toFixed(0)}% vs league avg">${fmtNum(c.perGame, 1)}</span><span class="rank">#${c.rank}</span></td>`;
      }).join('')}</tr>`;
    }).join('')}</tbody></table>`;
}

/* ---------------- method tab ---------------- */

function renderMethod() {
  if ($('tab-method').hidden) return;
  const c = calibration;
  const P = PARAMS;
  $('method').innerHTML = `
    <div class="card wide">
      <div class="card-head"><h2>How every prediction is built</h2></div>
      <ol>
        <li><b>Data.</b> Weekly box scores for every QB, RB, WR and TE in ${SEASON - 1} and ${SEASON} (through Week ${meta.lastCompletedWeek}), plus the full ${SEASON} schedule with Vegas spreads and totals, from the open-source nflverse project. Run <code>python3 scripts/build_data.py</code> to refresh.</li>
        <li><b>Opponent-adjusted baseline.</b> Each past game is divided by how generous that week's defense was to the position, so 90 yards against an elite run defense counts for more than 90 against a sieve. Games are recency-weighted (×${P.recencyDecay} per game back), and last season's games count ${Math.round(P.priorSeasonWeight * 100)}% each (${Math.round(P.priorSeasonTeamChangeWeight * 100)}% if the player changed teams).</li>
        <li><b>Opponent strength.</b> For the upcoming defense, the model measures what it has allowed per game to that position for that exact stat, relative to league average. Early-season samples are noisy, so it is regressed toward last season's number (${P.defPrevGames} games' worth) and toward league average (${P.defCurK} games' worth), then applied at ${Math.round(P.defStrength * 100)}% strength. That strength was chosen by the backtest.</li>
        <li><b>Game script.</b> The spread and total give each team's implied points. Higher-scoring environments raise yardage and especially TD odds. Favorites lean on the run and underdogs throw more.</li>
        <li><b>Distribution.</b> Yardage and volume stats use a gamma distribution, which is right-skewed like real box scores. Its spread comes from the player's own game-to-game volatility, blended with the positional norm and widened for uncertainty in the mean. TDs and INTs use a Poisson count, with the mean blended toward the positional average.</li>
        <li><b>Calibration.</b> The backtest showed raw probabilities ran slightly too extreme, so they are pulled toward 50% on the log-odds scale (factor ${P.temper}).</li>
      </ol>
    </div>
    ${c ? `
    <div class="card">
      <div class="card-head"><h2>Accuracy vs simpler approaches</h2>
        <p class="card-sub">Brier score: mean squared error of the probabilities. Lower is better. Walk-forward, using only data available before each game. Parameters were tuned on ${SEASON - 1}; ${SEASON} is out-of-sample.</p></div>
      ${Object.entries(c.byWindow).map(([w, s]) => `
        <h3 style="font-size:13px;margin:14px 0 6px">${w}${s.holdout ? ' · holdout' : ' · tuning set'} <span class="rank">${s.n.toLocaleString()} predictions</span></h3>
        <div class="chart" data-bars='${JSON.stringify([
          { label: 'This model', value: s.model, strong: true },
          { label: 'Model without matchup', value: s.noMatchup, note: 'Same model, but no opponent, spread/total or venue' },
          { label: 'Player hit rate so far', value: s.naive, note: 'How often the player has cleared the line this season' },
        ])}'></div>`).join('')}
      <p class="hint" style="margin-top:10px">Always guessing the overall base rate (${pct(c.baseRate)}) would score ${c.brier.climatology.toFixed(4)}.</p>
    </div>
    <div class="card">
      <div class="card-head"><h2>Calibration: when it says X%, does it happen X% of the time?</h2>
        <p class="card-sub">${c.n.toLocaleString()} backtested prop lines (${c.windows.join(', ')}). Points on the diagonal are perfectly calibrated.</p></div>
      <div class="chart" id="relChart"></div>
    </div>
    <div class="card wide">
      <div class="card-head"><h2>Accuracy by stat</h2></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Stat</th><th class="num">Predictions</th><th class="num">How often the line hit</th><th class="num">Model Brier</th><th class="num">Hit-rate Brier</th><th class="num">Improvement</th></tr></thead>
        <tbody>${Object.entries(c.byStat).map(([k, s]) => `<tr><td>${STAT[k].label}</td><td class="num">${s.n.toLocaleString()}</td><td class="num">${pct(s.hitRate)}</td><td class="num">${s.brier.toFixed(4)}</td><td class="num">${s.naive.toFixed(4)}</td><td class="num">${(((s.naive - s.brier) / s.naive) * 100).toFixed(1)}%</td></tr>`).join('')}</tbody>
      </table></div>
    </div>` : '<div class="card"><p class="empty">Run <code>node scripts/backtest.mjs</code> to generate accuracy results.</p></div>'}
    <div class="card wide">
      <div class="card-head"><h2>Known limitations</h2></div>
      <ol>
        <li><b>No injury or depth-chart feed.</b> If a starter is out or a backup is promoted, the model only learns from the box scores that follow. Adjust your expectations, or the line, for news.</li>
        <li><b>Weather isn't modeled.</b> Wind and snow mostly hurt passing.</li>
        <li><b>Future Vegas lines</b> are only available about a week ahead. For later games, enter your own spread and total.</li>
        <li>These are probabilities, not locks. A 70% call misses 3 times in 10, and the backtest shows how often it actually does.</li>
      </ol>
    </div>`;
  document.querySelectorAll('#method [data-bars]').forEach((n) => scoreBars(n, JSON.parse(n.dataset.bars)));
  if (c) reliabilityChart($('relChart'), c.calibration);
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

boot().catch((e) => {
  console.error(e);
  $('stamp').textContent = `Failed to load: ${e.message}. Serve the public/ folder over HTTP (see README).`;
});
