


// server.js - Final Debug + Correct Syntax + Fallback API
import express from "express";
import axios from "axios";
import mongoose from "mongoose";
import cron from "node-cron";
import cors from "cors";
import fs from "fs";
import path from "path";

const app = express();
app.use(cors());
const PORT = process.env.PORT || 8080;

// ----------------- MONGO -----------------
const MONGO_URL = process.env.MONGO_PUBLIC_URL;
if (!MONGO_URL) {
  console.error("❌ MONGO_PUBLIC_URL missing");
  process.exit(1);
}
mongoose.connect(MONGO_URL, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✔ MongoDB Connected"))
  .catch(err => console.error("❌ Mongo Error:", err));

// ----------------- SCHEMA -----------------
const PredictionSchema = new mongoose.Schema({
  match_id: { type: String, unique: true },
  league: String,
  teams: String,
  winnerProb: Object,
  bttsProb: Number,
  overUnder: Object,
  last10Prob: Number,
  xG: Object,
  strongMarkets: Array,
  sourceAPI: String,
  updated_at: { type: Date, default: Date.now }
});
const Prediction = mongoose.model("Prediction", PredictionSchema);

// ----------------- API KEYS -----------------
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY;
if (!API_FOOTBALL_KEY || !FOOTBALL_DATA_KEY) {
  console.error("❌ API keys missing");
  process.exit(1);
}

// ----------------- FETCH LIVE MATCHES -----------------
async function fetchLiveMatches() {
  const todayUTC = new Date().toISOString().split("T")[0];
  let matches = [];

  // ----- API-Football Primary -----
  try {
    const resAF = await axios.get("https://v3.football.api-sports.io/fixtures", {
      headers: { "x-apisports-key": API_FOOTBALL_KEY },
      params: { date: todayUTC, live: "all" },
      timeout: 10000
    });
    console.log("🔹 [API-Football] Raw Response:", JSON.stringify(resAF.data, null, 2));

    const afMatches = resAF.data.response || [];
    if (afMatches.length > 0) {
      matches.push(...afMatches.map(m => ({
        fixture: m.fixture,
        league: m.league || { name: "Unknown League" },
        teams: m.teams,
        goals: m.goals,
        status: m.fixture.status.short,
        sourceAPI: "API-Football"
      })));
      console.log(`✔ [API-Football] Fetched ${afMatches.length} live matches`);
      return matches;
    } else {
      console.warn("⚠ [API-Football] No live matches, falling back to football-data.org");
    }
  } catch (err) {
    console.warn("⚠ [API-Football] Error:", err.message);
  }

  // ----- football-data.org Fallback -----
  try {
    const resFD = await axios.get("https://api.football-data.org/v4/matches", {
      headers: { "X-Auth-Token": FOOTBALL_DATA_KEY },
      params: { dateFrom: todayUTC, dateTo: todayUTC },
      timeout: 10000
    });
    console.log("🔹 [football-data.org] Raw Response:", JSON.stringify(resFD.data, null, 2));

    const fdMatches = resFD.data.matches || [];
    if (fdMatches.length > 0) {
      matches.push(...fdMatches.map(m => ({
        fixture: { id: m.id, status: m.status },
        league: { name: m.competition.name },
        teams: { home: { name: m.homeTeam.name }, away: { name: m.awayTeam.name } },
        goals: { home: m.score.fullTime.home, away: m.score.fullTime.away },
        status: m.status,
        sourceAPI: "football-data.org"
      })));
      console.log(`✔ [football-data.org] Fetched ${fdMatches.length} live matches`);
    } else {
      console.warn("⚠ [football-data.org] No live matches today");
    }
  } catch (err) {
    console.error("❌ [football-data.org] Error:", err.message);
  }

  console.log(`📊 Total matches fetched: ${matches.length}`);
  matches.forEach(m => console.log(`[${m.sourceAPI}] ${m.teams.home.name} vs ${m.teams.away.name}`));
  return matches;
}

// ----------------- INITIAL FETCH ON SERVER START -----------------
(async () => {
  console.log("🟢 Initial live match fetch on server start...");
  const initialMatches = await fetchLiveMatches();
  console.log(`🟢 Initial fetch matches: ${initialMatches.length}`);
})();

// ----------------- PREDICTION ENGINE -----------------
async function makePrediction(match) {
  try {
    const home = match.teams.home.name;
    const away = match.teams.away.name;
    const xG_home = Number((Math.random() * 2 + 0.5).toFixed(2));
    const xG_away = Number((Math.random() * 2 + 0.5).toFixed(2));
    const xG_total = Number((xG_home + xG_away).toFixed(2));

    const homeProb = Math.round((xG_home / (xG_home + xG_away)) * 100);
    const awayProb = Math.round((xG_away / (xG_home + xG_away)) * 100);
    const drawProb = 100 - homeProb - awayProb;

    const bttsProb = Math.min(95, Math.round(Math.random() * 50 + xG_total * 10));
    const overUnder = {};
    for (let t = 0.5; t <= 5.5; t += 0.5)
      overUnder[t.toFixed(1)] = Math.min(98, Math.round(Math.random() * 50 + xG_total * 10));
    const last10Prob = Math.min(95, Math.round(xG_total * 15));

    const strongMarkets = [];
    if (homeProb >= 85) strongMarkets.push({ market: "Home Win", prob: homeProb });
    if (awayProb >= 85) strongMarkets.push({ market: "Away Win", prob: awayProb });
    if (bttsProb >= 85) strongMarkets.push({ market: "BTTS", prob: bttsProb });
    Object.keys(overUnder).forEach(k => {
      if (overUnder[k] >= 85) strongMarkets.push({ market: `Over ${k}`, prob: overUnder[k] });
      if ((100 - overUnder[k]) >= 85) strongMarkets.push({ market: `Under ${k}`, prob: 100 - overUnder[k] });
    });

    return {
      match_id: String(match.fixture.id),
      league: match.league.name,
      teams: `${home} vs ${away}`,
      winnerProb: { home: homeProb, draw: drawProb, away: awayProb },
      bttsProb,
      overUnder,
      last10Prob,
      xG: { home: xG_home, away: xG_away, total: xG_total },
      strongMarkets,
      sourceAPI: match.sourceAPI,
      updated_at: new Date()
    };
  } catch (err) {
    console.error("❌ makePrediction error:", err.message);
    return null;
  }
}

// ----------------- CRON JOBS -----------------
cron.schedule("*/15 * * * *", async () => {
  console.log("🕒 Cron: Fetching live matches...");
  const matches = await fetchLiveMatches();
  for (const m of matches) {
    const existing = await Prediction.findOne({ match_id: m.fixture.id });
    const pred = await makePrediction(m);
    if (!pred) continue;
    if (existing) await Prediction.updateOne({ match_id: m.fixture.id }, pred);
    else await Prediction.create(pred);
  }
});

cron.schedule("*/5 * * * *", async () => {
  console.log("🕒 Cron: Updating predictions...");
  const matches = await Prediction.find();
  for (const m of matches) {
    const updatedPred = await makePrediction({
      fixture: { id: m.match_id },
      teams: { home: { name: m.teams.split(" vs ")[0] }, away: { name: m.teams.split(" vs ")[1] } },
      league: { name: m.league },
      sourceAPI: m.sourceAPI
    });
    if (updatedPred) await Prediction.updateOne({ match_id: m.match_id }, updatedPred);
  }
});

// ----------------- DEBUG ROUTE -----------------
app.get("/debug-fetch", async (req, res) => {
  console.log("🟢 Manual debug: fetching live matches...");
  const matches = await fetchLiveMatches();
  console.log("🟢 Matches fetched:", matches.length);
  res.json({ total: matches.length, matches });
});

// ----------------- SSE -----------------
app.get("/events", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const sendUpdates = async () => {
    const preds = await Prediction.find().sort({ updated_at: -1 }).limit(200);
    res.write(`data: ${JSON.stringify({ ts: Date.now(), matches: preds })}\n\n`);
  };
  await sendUpdates();
  const interval = setInterval(sendUpdates, 5 * 60 * 1000);
  req.on("close", () => clearInterval(interval));
});

// ----------------- API ROUTES -----------------
app.get("/prediction", async (req, res) => {
  const preds = await Prediction.find().sort({ updated_at: -1 }).limit(200);
  res.json(preds);
});
app.get("/today-matches", async (req, res) => {
  const matches = await fetchLiveMatches();
  res.json(matches);
});

// ----------------- SERVE INDEX.HTML -----------------
app.get("/", (req, res) => {
  const filePath = path.join(process.cwd(), "index.html");
  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) return res.status(500).send("❌ index.html not found");
    res.setHeader("Content-Type", "text/html");
    res.send(data);
  });
});

// ----------------- START SERVER -----------------
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
