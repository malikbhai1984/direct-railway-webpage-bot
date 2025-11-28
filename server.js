


// server.js - Dual-API Fully Fixed (Live + Scheduled + League Display)
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

// ----------------- MONGODB -----------------
const MONGO_URL = process.env.MONGO_PUBLIC_URL;
if (!MONGO_URL) {
  console.error("❌ MONGO_PUBLIC_URL missing");
  process.exit(1);
}
mongoose.connect(MONGO_URL, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log("✔ MongoDB Connected"))
.catch(err => console.log("❌ Mongo Error:", err));

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
  sourceAPI: String,            // API source log
  updated_at: { type: Date, default: Date.now }
});
const Prediction = mongoose.model("Prediction", PredictionSchema);

// ----------------- API KEYS -----------------
const ALLSPORTS_KEY = process.env.ALL_SPORTS_KEY;
if (!ALLSPORTS_KEY) {
  console.error("❌ ALL_SPORTS_KEY missing");
  process.exit(1);
}
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
if (!API_FOOTBALL_KEY) {
  console.error("❌ API_FOOTBALL_KEY missing");
  process.exit(1);
}

const ALLSPORTS_URL = "https://api.allsportsapi.com/football/";
const API_FOOTBALL_URL = "https://v3.football.api-sports.io/fixtures";

// ----------------- FETCH LIVE + TODAY MATCHES -----------------
async function fetchLiveMatches() {
  try {
    // UTC date
    const todayUTC = new Date().toISOString().split("T")[0];
    // PKT timezone conversion
    const todayPKT = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Karachi" }))
      .toISOString().split("T")[0];

    let matches = [];

    // --- ALLSPORTSAPI: Premier League + LaLiga ---
    const allSportsLeagues = { "Premier League": 39, "LaLiga": 140 };
    for (const [name, id] of Object.entries(allSportsLeagues)) {
      const res = await axios.get(`${ALLSPORTS_URL}?met=Fixtures&APIkey=${ALLSPORTS_KEY}&leagueId=${id}&from=${todayUTC}&to=${todayUTC}`);
      const data = res.data.result || [];
      const leagueMatches = data.map(m => ({
        fixture: { id: m.event_key, date: m.event_date, status: m.event_status },
        league: { name },
        teams: { home: { name: m.event_home_team }, away: { name: m.event_away_team } },
        goals: { home: m.event_final_result.split("-")[0], away: m.event_final_result.split("-")[1] },
        sourceAPI: "AllSportsAPI"
      }));
      console.log(`🔹 [AllSportsAPI] ${name} matches fetched: ${leagueMatches.length}`);
      matches.push(...leagueMatches);
    }

    // --- API-FOOTBALL: All other leagues ---
    const resAF = await axios.get(API_FOOTBALL_URL, {
      headers: { "x-apisports-key": API_FOOTBALL_KEY },
      params: {
        date: todayUTC,       // use UTC date
        season: 2025          // current season
      },
      timeout: 10000
    });
    const afMatches = resAF.data.response || [];
    const afFiltered = afMatches.map(m => ({
      fixture: m.fixture,
      league: m.league,
      teams: m.teams,
      goals: m.goals,
      status: m.fixture.status.short,
      sourceAPI: "API-Football"
    }));
    console.log(`🔹 [API-Football] Other leagues matches fetched: ${afFiltered.length}`);
    matches.push(...afFiltered);

    console.log(`✔ Total matches fetched for today: ${matches.length}`);
    return matches;
  } catch (err) {
    console.error("❌ fetchLiveMatches error:", err.message);
    return [];
  }
}

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
    for (let t = 0.5; t <= 5.5; t += 0.5) {
      overUnder[t.toFixed(1)] = Math.min(98, Math.round(Math.random() * 50 + xG_total * 10));
    }
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
      sourceAPI: match.sourceAPI || "Unknown",
      updated_at: new Date()
    };
  } catch (err) {
    console.error("❌ makePrediction error:", err.message);
    return null;
  }
}

// ----------------- CRON -----------------
cron.schedule("*/15 * * * *", async () => {
  const matches = await fetchLiveMatches();
  for (const m of matches) {
    const existing = await Prediction.findOne({ match_id: m.fixture.id });
    const pred = await makePrediction(m);
    if (!pred) continue;
    if (existing) {
      await Prediction.updateOne({ match_id: m.fixture.id }, pred);
    } else {
      await Prediction.create(pred);
    }
  }
});

cron.schedule("*/5 * * * *", async () => {
  const matches = await Prediction.find();
  for (const m of matches) {
    const updatedPred = await makePrediction({
      fixture: { id: m.match_id },
      teams: { home: { name: m.teams.split(" vs ")[0] }, away: { name: m.teams.split(" vs ")[1] } },
      league: { name: m.league },
      sourceAPI: m.sourceAPI
    });
    if (updatedPred) {
      await Prediction.updateOne({ match_id: m.match_id }, updatedPred);
    }
  }
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
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
