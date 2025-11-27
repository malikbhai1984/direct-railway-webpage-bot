// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const moment = require('moment-timezone');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PKT = 'Asia/Karachi';
const API_KEY = process.env.API_FOOTBALL_KEY;
const TOP_LEAGUES = (process.env.TOP_LEAGUES || '').split(',').map(s => s.trim()).filter(Boolean);
const TEAM_CACHE_TTL_MIN = parseInt(process.env.TEAM_CACHE_TTL_MIN || '10', 10);
const PRED_REFRESH_MIN = parseInt(process.env.PRED_REFRESH_MIN || '5', 10);

if (!API_KEY) console.warn('⚠️ API_FOOTBALL_KEY not set. Add it to .env / Railway variables.');

const API = axios.create({
  baseURL: 'https://v3.football.api-sports.io',
  timeout: 10000,
  headers: { 'x-apisports-key': API_KEY }
});

// serve frontend static file
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- Poisson helpers ----------------
function fact(n){ let f=1; for(let i=1;i<=n;i++) f *= i; return f; }
function poissonP(lambda,k){ return Math.exp(-lambda) * Math.pow(lambda, k) / fact(k); }
function poissonProbOver(totalLambda, threshold){
  let sum = 0;
  const kMax = Math.floor(threshold);
  for (let k = 0; k <= kMax; k++) sum += poissonP(totalLambda, k);
  return (1 - sum) * 100;
}
function probAtLeastOneInWindow(totalLambda, minutes){
  const perMin = totalLambda / 90;
  const lambdaWindow = perMin * minutes;
  return (1 - Math.exp(-lambdaWindow)) * 100;
}
function bttsProb(lambdaH, lambdaA){
  const pHomeZero = poissonP(lambdaH, 0);
  const pAwayZero = poissonP(lambdaA, 0);
  return (1 - (pHomeZero * pAwayZero)) * 100;
}
function computeWinnerProb(lambdaH, lambdaA){
  const maxK = 7;
  let pH = 0, pD = 0, pA = 0;
  for (let i=0;i<=maxK;i++){
    for (let j=0;j<=maxK;j++){
      const p = poissonP(lambdaH, i) * poissonP(lambdaA, j);
      if (i>j) pH += p;
      else if (i===j) pD += p;
      else pA += p;
    }
  }
  const remainder = Math.max(0, 1 - (pH + pD + pA));
  if (remainder > 0) {
    if (lambdaH > lambdaA) pH += remainder;
    else if (lambdaA > lambdaH) pA += remainder;
    else pD += remainder;
  }
  return { home: Math.round(pH*100), draw: Math.round(pD*100), away: Math.round(pA*100) };
}

// ---------------- caching to reduce API hits ----------------
const teamCache = new Map(); // teamId -> { ts, data }
function setTeamCache(teamId, data){
  teamCache.set(teamId, { ts: Date.now(), data });
}
function getTeamCache(teamId){
  const r = teamCache.get(teamId);
  if (!r) return null;
  const ageMin = (Date.now() - r.ts) / 60000;
  if (ageMin > TEAM_CACHE_TTL_MIN) { teamCache.delete(teamId); return null; }
  return r.data;
}

// ---------------- API wrappers ----------------
async function fetchLiveFixtures(){
  try {
    const res = await API.get('/fixtures', { params: { live: 'all' } });
    return Array.isArray(res.data.response) ? res.data.response : [];
  } catch (err) {
    console.error('fetchLiveFixtures error', err.message);
    return [];
  }
}
async function fetchTodayFixtures(){
  try {
    const date = moment().tz(PKT).format('YYYY-MM-DD');
    const res = await API.get('/fixtures', { params: { date } });
    return Array.isArray(res.data.response) ? res.data.response : [];
  } catch (err) {
    console.error('fetchTodayFixtures error', err.message);
    return [];
  }
}
async function fetchTeamLastFixtures(teamId, last=5){
  try {
    const cached = getTeamCache(teamId);
    if (cached) return cached;
    const res = await API.get('/fixtures', { params: { team: teamId, last } });
    const list = Array.isArray(res.data.response) ? res.data.response : [];
    setTeamCache(teamId, list);
    return list;
  } catch (err) {
    console.error('fetchTeamLastFixtures', teamId, err.message);
    return [];
  }
}

// normalize fixture for client use
function normalizeForClient(f){
  return {
    matchId: String(f.fixture.id),
    kickoffUTC: f.fixture.date,
    kickoffPKT: moment.utc(f.fixture.date).tz(PKT).format('YYYY-MM-DD HH:mm'),
    home: { id: f.teams.home.id, name: f.teams.home.name },
    away: { id: f.teams.away.id, name: f.teams.away.name },
    league: f.league ? f.league.name : '',
    status: f.fixture.status.short,
    elapsed: f.fixture.status.elapsed || 0,
    goals: { home: f.goals.home === null ? 0 : f.goals.home, away: f.goals.away === null ? 0 : f.goals.away }
  };
}

// compute avg goals for team from fixtures array
function avgGoalsForTeam(teamId, fixtures){
  if (!fixtures || fixtures.length === 0) return 1.05;
  let sum = 0, n = 0;
  for (const fi of fixtures){
    const hId = fi.teams.home.id, aId = fi.teams.away.id;
    if (hId === teamId && typeof fi.goals.home === 'number'){ sum += fi.goals.home; n++; }
    else if (aId === teamId && typeof fi.goals.away === 'number'){ sum += fi.goals.away; n++; }
  }
  return n === 0 ? 1.05 : (sum / n);
}

// find strong markets across 0.5..5.5
function findStrongMarkets(totalLambda){
  const strong = [];
  for (let t=0.5; t<=5.5; t+=1.0){
    const pOver = Math.round(poissonProbOver(totalLambda, t));
    const pUnder = Math.round(100 - pOver);
    if (pOver >= 85) strong.push({ market: `Over ${t}`, prob: pOver });
    if (pUnder >= 85) strong.push({ market: `Under ${t}`, prob: pUnder });
  }
  return strong;
}

// build prediction for a single fixture (live only)
async function buildPrediction(fixture){
  try {
    // normalize wrapper to ensure fields
    const f = fixture;
    const norm = normalizeForClient(f);

    // try to get last fixtures for both teams (cached)
    const [homeLast, awayLast] = await Promise.all([
      fetchTeamLastFixtures(norm.home.id, 5),
      fetchTeamLastFixtures(norm.away.id, 5)
    ]);

    const avgHome = avgGoalsForTeam(norm.home.id, homeLast);
    const avgAway = avgGoalsForTeam(norm.away.id, awayLast);

    // consider current match goals already scored as partial evidence
    const currentHomeGoals = norm.goals.home;
    const currentAwayGoals = norm.goals.away;

    // home advantage factor for expected remaining goals (but we want total expectation)
    const homeAdv = 1.06;

    // expected goals (lambda) heuristics: blend last-average with current partial
    // This yields an estimate for full-match expected (not remaining) — okay for Poisson math here
    const lambdaH = Number(((avgHome * 0.8 * homeAdv) + (currentHomeGoals * 0.6)).toFixed(2));
    const lambdaA = Number(((avgAway * 0.8) + (currentAwayGoals * 0.6)).toFixed(2));
    const totalLambda = Number((lambdaH + lambdaA).toFixed(2));

    // Winner probabilities via truncated Poisson conv
    const winnerProb = computeWinnerProb(lambdaH, lambdaA);

    // BTTS probability
    const btts = Math.round(bttsProb(lambdaH, lambdaA));

    // Last-10 minute probability: scale by remaining minute dynamics — if match already late, use heavier weight
    const elapsed = norm.elapsed || 0;
    const last10 = Math.round(probAtLeastOneInWindow(totalLambda, 10));

    // strong markets
    const strongMarkets = findStrongMarkets(totalLambda);

    return {
      matchId: norm.matchId,
      teams: `${norm.home.name} vs ${norm.away.name}`,
      matchDate: norm.kickoffPKT,
      league: norm.league,
      elapsed,
      status: norm.status,
      prediction: {
        expectedGoals: { home: lambdaH, away: lambdaA, total: totalLambda },
        winnerProb,
        bttsProb: btts,
        last10Prob: last10,
        strongMarkets
      }
    };
  } catch (err) {
    console.error('buildPrediction error', err.message);
    return null;
  }
}

// ---------------- SSE: clients ----------------
const clients = new Set();

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // send immediate welcome
  const welcome = { ts: moment().tz(PKT).format(), welcome: 'Auto predictions active — welcome', note: 'Live-only predictions' };
  res.write(`data: ${JSON.stringify(welcome)}\n\n`);

  clients.add(res);
  console.log('SSE connected:', clients.size);

  req.on('close', () => {
    clients.delete(res);
    console.log('SSE disconnected:', clients.size);
  });
});

// broadcast helper
function broadcast(obj){
  const s = JSON.stringify(obj);
  for (const r of clients) {
    try { r.write(`data: ${s}\n\n`); } catch(e){ /* ignore */ }
  }
  console.log('Broadcasted to', clients.size, 'clients @', new Date().toISOString());
}

// endpoint: frontend list today's matches (top leagues)
app.get('/today', async (req, res) => {
  try {
    const all = await fetchTodayFixtures();
    const normalized = all.map(f => ({
      matchId: String(f.fixture.id),
      home: f.teams.home.name,
      away: f.teams.away.name,
      league: f.league ? f.league.name : '',
      kickoff: moment.utc(f.fixture.date).tz(PKT).format('YYYY-MM-DD HH:mm'),
      status: f.fixture.status.short
    }));
    // if TOP_LEAGUES present filter
    const filtered = TOP_LEAGUES.length ? normalized.filter(m => TOP_LEAGUES.includes(m.league)) : normalized;
    res.json({ success: true, data: filtered.slice(0, 200) });
  } catch (err) {
    console.error('/today err', err.message);
    res.json({ success: false, error: err.message });
  }
});

// endpoint: simple status
app.get('/api-status', (req,res) => {
  res.json({ success: true, connectedClients: clients.size, teamCacheSize: teamCache.size });
});

// ---------------- CORE: fetch live matches, predict, broadcast ----------------
let isRunning = false;
async function fetchPredictBroadcast(){
  if (isRunning) return;
  isRunning = true;
  try {
    // fetch live fixtures
    const live = await fetchLiveFixtures();
    if (!live || live.length === 0) {
      // if no live, do not broadcast predictions (or send empty)
      const payload = { ts: moment().tz(PKT).format(), matches: [] };
      broadcast(payload);
      isRunning = false;
      return;
    }

    // build predictions in parallel with limited concurrency (map -> Promise.all)
    const preds = [];
    for (const f of live) {
      // only predict for matches flagged in our top leagues if TOP_LEAGUES configured
      if (TOP_LEAGUES.length && (!f.league || !TOP_LEAGUES.includes(f.league.name))) continue;
      const p = await buildPrediction(f);
      if (p) preds.push(p);
    }

    // sort by elapsed minute descending or kickoff
    preds.sort((a,b) => (b.elapsed||0) - (a.elapsed||0));

    const payload = { ts: moment().tz(PKT).format(), matches: preds, note: 'live-only' };
    broadcast(payload);
  } catch (err) {
    console.error('fetchPredictBroadcast err', err.message);
  } finally {
    isRunning = false;
  }
}

// initial run
fetchPredictBroadcast().catch(e=>console.error(e));

// schedule periodic run (every PRED_REFRESH_MIN minutes)
cron.schedule(`*/${Math.max(1,PRED_REFRESH_MIN)} * * * *`, () => {
  console.log('Cron tick: fetchPredictBroadcast');
  fetchPredictBroadcast().catch(e => console.error(e));
});

// optional: also run every 30s if there are connected clients to increase "live feeling" (be careful with quota)
setInterval(() => {
  if (clients.size > 0) fetchPredictBroadcast().catch(() => {});
}, 30 * 1000); // 30 seconds; reduce or remove if hitting rate limits

// fallback: serve index.html on root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
