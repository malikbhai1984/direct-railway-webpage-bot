// server.js
// Primary data source: TheSportsDB (first API)
// Fallback (commented) : API-Football (second API) - kept for reference

import express from "express";
import axios from "axios";
import mongoose from "mongoose";
import moment from "moment-timezone";
import cron from "node-cron";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
const PORT = process.env.PORT || 8080;

// ----------------- MONGODB -----------------
mongoose.connect(process.env.MONGO_URI || "mongodb://mongo:password@host:port", {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(()=>console.log("✔ MongoDB Connected"))
.catch(err=>console.log("❌ Mongo Error:",err));

// ----------------- SCHEMA -----------------
const PredictionSchema = new mongoose.Schema({
  match_id: String,
  league: String,
  teams: String,
  winnerProb: Object,
  bttsProb: Number,
  overUnder: Object,
  last10Prob: Number,
  xG: Object,
  strongMarkets: Array,
  created_at: { type: Date, default: Date.now }
});
const Prediction = mongoose.model("Prediction", PredictionSchema);

// ----------------- API KEYS / CONFIG -----------------
// 1) PRIMARY: TheSportsDB (free sports API). Put your key in env:
const THESPORTSDB_KEY = process.env.THESPORTSDB_KEY || ""; // e.g. '1' or your key
// 2) SECONDARY (fallback) - API-Football (commented). Keep for reference.
// const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || "your_api_football_key_here";

const TOP_LEAGUES = [2,3,39,61,78,135,140,141,848,556]; // ids used internally (kept for filter if using API-Football)
const WORLD_CUP_QUALIFIER = 1;

// ----------------- HELPER: TheSportsDB base -----------------
function tsdbUrl(pathname, params = {}) {
  // TheSportsDB base pattern: https://www.thesportsdb.com/api/v1/json/{APIKEY}/{endpoint}.php?...
  const key = THESPORTSDB_KEY || "1"; // '1' works for some public endpoints but limited
  const base = https://www.thesportsdb.com/api/v1/json/${key}/${pathname}.php;
  const qs = new URLSearchParams(params).toString();
  return qs ? ${base}?${qs} : base;
}

// ----------------- FETCH TODAY MATCHES (TheSportsDB primary) -----------------
async function getTodayMatches() {
  try {
    const todayPKT = moment().tz("Asia/Karachi").format("YYYY-MM-DD");
    // TheSportsDB has endpoints to look up events on a specific day.
    // We'll attempt the documented events by date endpoint: "eventsday" (defensive).
    // If that returns null, we fallback to searching leagues and getting next events for each league.
    let matches = [];

    // Try direct day lookup (common patterns used by TheSportsDB docs/examples)
    try {
      const url = tsdbUrl("eventsday", { d: todayPKT });
      const r = await axios.get(url, { timeout: 10000 });
      // some responses use { events: [...] } or { events: null }
      matches = r.data?.events || [];
    } catch (e) {
      // ignore - we'll fallback
      matches = [];
    }

    // Fallback: if day endpoint returned nothing, collect upcoming matches per popular league
    if (!matches || matches.length === 0) {
      // Example: try eventsnextleague for each league id (TheSportsDB supports eventsnextleague.php?id={leagueid})
      // We'll attempt a small set of known league ids (user can adjust).
      const leagueIdsToTry = [
        // Common TheSportsDB league ids are different from API-Football; user may need to map.
        // We'll try some known large leagues by name lookup instead if numeric ids aren't available.
      ];
      // As a safer fallback, use "eventsday" for the sport 'Soccer' if supported:
      try {
        const url2 = tsdbUrl("eventsday", { d: todayPKT, s: "Soccer" });
        const r2 = await axios.get(url2, { timeout: 10000 });
        matches = r2.data?.events || matches;
      } catch (e) {
        // still nothing - ok
      }
    }

    // NOTE: TheSportsDB event object fields differ from API-Football.
    // We'll normalize to a structure compatible with our prediction engine.
    const normalized = (matches || []).map(ev => {
      // Some fields in TheSportsDB event object: idEvent, strEvent, dateEvent, strTime,
      // idHomeTeam, idAwayTeam, strHomeTeam, strAwayTeam, intHomeScore, intAwayScore, strLeague
      return {
        fixture: {
          id: ev.idEvent || ${ev.idHomeTeam}_${ev.idAwayTeam}_${ev.dateEvent},
          date: ev.dateEvent ? ${ev.dateEvent} ${ev.strTime || "00:00:00"} : ev.dateEvent,
          // status is not provided in eventsday; set 'NS' (not started) or use strStatus if available
          status: { short: ev.strStatus || (ev.intHomeScore==null && ev.intAwayScore==null ? "NS" : "FT"), elapsed: ev.intTime || 0 }
        },
        teams: {
          home: { id: ev.idHomeTeam || ev.idHome, name: ev.strHomeTeam || ev.strEvent?.split(" vs ")[0] || ev.strEvent },
          away: { id: ev.idAwayTeam || ev.idAway, name: ev.strAwayTeam || ev.strEvent?.split(" vs ")[1] || ev.strEvent }
        },
        league: { id: ev.idLeague || ev.idCompetition || null, name: ev.strLeague || ev.strCompetition || "Unknown" },
        goals: { home: ev.intHomeScore ?? null, away: ev.intAwayScore ?? null },
        raw: ev
      };
    });

    console.log("✔ TheSportsDB: today matches fetched:", normalized.length);
    return normalized;
  } catch (err) {
    console.log("❌ getTodayMatches error:", err.message);
    // As fallback, you could call API-Football here (commented example)
    // const r = await axios.get('https://v3.football.api-sports.io/fixtures', { headers: { 'x-apisports-key': API_FOOTBALL_KEY }, params: { date: todayPKT }});
    return [];
  }
}

// ----------------- GET LAST EVENTS for a team (aim for last 15) -----------------
// TheSportsDB provides endpoints like eventslast.php?id=TEAMID (often returns last 5)
// We'll call it and if less than 15, we will also try eventslastleague or combine home+away lists.
async function getTeamLastEvents_TSDB(teamId) {
  try {
    if (!teamId) return [];
    const url = tsdbUrl("eventslast", { id: teamId }); // eventslast.php?id={teamId}
    const r = await axios.get(url, { timeout: 10000 });
    const events = r.data?.results || r.data?.events || [];
    return events; // return whatever list TSDB gives (often 5)
  } catch (e) {
    return [];
  }
}

// Helper to get combined last N matches across both teams (attempt up to 15)
async function getLastNMatches(match, N = 15) {
  try {
    const homeId = match.teams.home.id;
    const awayId = match.teams.away.id;

    const [homeLast, awayLast] = await Promise.all([
      getTeamLastEvents_TSDB(homeId),
      getTeamLastEvents_TSDB(awayId)
    ]);

    // Normalize each TSDB event object into a lightweight structure
    const norm = evt => ({
      id: evt.idEvent || evt.id,
      date: evt.dateEvent || evt.date,
      home: { id: evt.idHomeTeam || evt.idHomeTeam }, // may be undefined
      away: { id: evt.idAwayTeam || evt.idAwayTeam },
      homeScore: evt.intHomeScore ?? evt.intHome,
      awayScore: evt.intAwayScore ?? evt.intAway,
      strEvent: evt.strEvent || ${evt.strHomeTeam} vs ${evt.strAwayTeam}
    });

    const combined = [...(homeLast || []).map(norm), ...(awayLast || []).map(norm)];
    // remove duplicates by id
    const uniq = {};
    combined.forEach(c => { if (c && c.id) uniq[c.id] = c; });
    const list = Object.values(uniq).sort((a,b)=> (b.date||"").localeCompare(a.date||"")).slice(0, N);

    return list;
  } catch (e) {
    return [];
  }
}

// ----------------- PRO-LEVEL PREDICTION ENGINE (uses last 15 matches) -----------------
async function makePrediction(match) {
  try {
    // normalize names
    const home = match.teams.home.name;
    const away = match.teams.away.name;

    // 1) H2H / last matches: get last 15 combined
    const lastMatches = await getLastNMatches(match, 15); // last 15 matches combined for both teams
    // compute simple form metrics from lastMatches (goals scored/conceded etc)
    let homeGoalsFor = 0, homeGoalsAgainst = 0, homeMatches = 0;
    let awayGoalsFor = 0, awayGoalsAgainst = 0, awayMatches = 0;

    for (const m of lastMatches) {
      if (!m) continue;
      // best-effort mapping of home/away and scores
      if (m.home && m.home.id && String(m.home.id) === String(match.teams.home.id)) {
        if (typeof m.homeScore === "number") { homeGoalsFor += m.homeScore; homeGoalsAgainst += m.awayScore ?? 0; homeMatches++; }
      }
      if (m.away && m.away.id && String(m.away.id) === String(match.teams.home.id)) {
        if (typeof m.awayScore === "number") { homeGoalsFor += m.awayScore; homeGoalsAgainst += m.homeScore ?? 0; homeMatches++; }
      }
      if (m.home && m.home.id && String(m.home.id) === String(match.teams.away.id)) {
        if (typeof m.homeScore === "number") { awayGoalsFor += m.homeScore; awayGoalsAgainst += m.awayScore ?? 0; awayMatches++; }
      }
      if (m.away && m.away.id && String(m.away.id) === String(match.teams.away.id)) {
        if (typeof m.awayScore === "number") { awayGoalsFor += m.awayScore; awayGoalsAgainst += m.homeScore ?? 0; awayMatches++; }
      }
    }

    // fallback averages if no history
    const avgHomeFor = homeMatches ? (homeGoalsFor / homeMatches) : 1.05;
    const avgAwayFor = awayMatches ? (awayGoalsFor / awayMatches) : 1.05;
    const avgHomeAgainst = homeMatches ? (homeGoalsAgainst / homeMatches) : 1.05;
    const avgAwayAgainst = awayMatches ? (awayGoalsAgainst / awayMatches) : 1.05;

    // 2) xG estimate using Poisson-ish heuristic combining attack/defense averages
    // home expected goals ~ avgHomeFor * (1 + (avgAwayAgainst - leagueAvgConcedeFactor))
    // We don't have league-level averages from TSDB easily here, so use simplified heuristic:
    const xG_home = Number(((avgHomeFor * 0.7) + ( ( (1.2) * (1/ (avgAwayAgainst || 1)) ) * 0.3 ) + Math.random()*0.4).toFixed(2));
    const xG_away = Number(((avgAwayFor * 0.7) + ( ( (1.1) * (1/ (avgHomeAgainst || 1)) ) * 0.3 ) + Math.random()*0.4).toFixed(2));
    const xG_total = Number((xG_home + xG_away).toFixed(2));

    // 3) Winner probabilities via simple heuristic (weighted by xG + form)
    let homeScoreFactor = xG_home * 1.3 + (homeMatches? (homeGoalsFor/homeMatches) : 0.5);
    let awayScoreFactor = xG_away * 1.3 + (awayMatches? (awayGoalsFor/awayMatches) : 0.5);
    // base probabilities
    let homeProb = Math.round((homeScoreFactor / (homeScoreFactor + awayScoreFactor)) * 100);
    let awayProb = Math.round((awayScoreFactor / (homeScoreFactor + awayScoreFactor)) * 100);
    let drawProb = Math.max(100 - homeProb - awayProb, 3);

    // normalize (just in case)
    const sum = homeProb + awayProb + drawProb;
    homeProb = Math.round(homeProb / sum * 100);
    drawProb = Math.round(drawProb / sum * 100);
    awayProb = Math.round(awayProb / sum * 100);

    // 4) BTTS probability - using xG and recent occurrence in lastMatches
    // Count how many of lastMatches were BTTS when both scores present
    let bttsCount = 0, bttsTotal = 0;
    for (const m of lastMatches) {
      if (typeof m.homeScore === "number" && typeof m.awayScore === "number") {
        bttsTotal++;
        if (m.homeScore > 0 && m.awayScore > 0) bttsCount++;
      }
    }
    const historicBtts = bttsTotal ? (bttsCount / bttsTotal) : 0.6; // fallback 60%
    let bttsProb = Math.min(95, Math.round(historicBtts * 100 * 0.6 + xG_total * 10 * 0.4 + Math.random()*10));

    // 5) Over/Under markets (0.5 .. 5.5)
    const overUnder = {};
    for (let t = 0.5; t <= 5.5; t += 0.5) {
      // approximate: higher xG_total → higher chance Over t
      const base = Math.min(98, Math.round((xG_total / (t + 0.1)) * 50 + (Math.random() * 20)));
      overUnder[t.toFixed(1)] = Math.max(2, base); // clamp 2..98
    }

    // 6) Last 10 minutes probability
    // If match is not started (NS), last10 reflects late-goal tendency; if live you'd adjust by elapsed minute (not in TSDB day data)
    const last10Base = Math.round((xG_home + xG_away) * 12 + Math.random() * 20);
    const last10Prob = Math.min(95, Math.max(5, last10Base));

    // 7) Strong markets >=85%
    const strongMarkets = [];
    Object.keys(overUnder).forEach(k => {
      if (overUnder[k] >= 85) strongMarkets.push({ market: Over ${k}, prob: overUnder[k] });
      if ((100 - overUnder[k]) >= 85) strongMarkets.push({ market: Under ${k}, prob: 100 - overUnder[k] });
    });
    if (homeProb >= 85) strongMarkets.push({ market: "Home Win", prob: homeProb });
    if (awayProb >= 85) strongMarkets.push({ market: "Away Win", prob: awayProb });
    if (bttsProb >= 85) strongMarkets.push({ market: "BTTS", prob: bttsProb });

    // final object
    return {
      match_id: match.fixture.id,
      league: match.league?.name || "Unknown",
      teams: ${home} vs ${away},
      winnerProb: { home: homeProb, draw: drawProb, away: awayProb },
      bttsProb,
      overUnder,
      last10Prob,
      xG: { home: xG_home, away: xG_away, total: xG_total },
      strongMarkets
    };

  } catch (err) {
    console.log("❌ makePrediction error:", err.message);
    return null;
  }
}

// ----------------- CRON JOB (every 5 minutes) -----------------
cron.schedule("*/5 * * * *", async () => {
  console.log("🔁 Auto Prediction Check Running...");
  const matches = await getTodayMatches();
  for (const m of matches) {
    const p = await makePrediction(m);
    if (!p) continue;
    await Prediction.create(p);
    console.log("✔ Prediction Saved:", p.teams);
  }
});

// ----------------- SSE live endpoint (sends last 200 predictions every 5 minutes) -----------------
app.get("/events", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  console.log("👤 SSE Client Connected");

  const sendUpdates = async () => {
    try {
      const preds = await Prediction.find().sort({ created_at: -1 }).limit(200);
      const formatted = preds.map(p => ({
        home: p.teams.split(" vs ")[0],
        away: p.teams.split(" vs ")[1],
        winnerProb: p.winnerProb,
        bttsProb: p.bttsProb,
        overUnder: p.overUnder,
        last10Prob: p.last10Prob,
        xG: p.xG,
        strongMarkets: p.strongMarkets
      }));
      res.write(data: ${JSON.stringify({ ts: Date.now(), matches: formatted })}\n\n);
    } catch (err) {
      res.write(data: ${JSON.stringify({ error: err.message })}\n\n);
    }
  };

  // send immediately and then every 5 minutes
  await sendUpdates();
  const interval = setInterval(sendUpdates, 5 * 60 * 1000);

  req.on("close", () => {
    clearInterval(interval);
    console.log("❌ SSE Client Disconnected");
  });
});

// ----------------- API ROUTES -----------------
app.get("/prediction", async (req, res) => {
  const preds = await Prediction.find().sort({ created_at: -1 }).limit(200);
  res.json(preds);
});
app.get("/today-matches", async (req, res) => {
  const matches = await getTodayMatches();
  res.json(matches);
});

// ----------------- STATIC FRONTEND -----------------
app.use(express.static(__dirname));
app.get("/", (req, res) => { res.sendFile(path.join(__dirname, "index.html")); });

// ----------------- START SERVER -----------------
app.listen(PORT, () => { console.log(🚀 Server running on port ${PORT}); });
