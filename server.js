

// server.js - Final Professional 100-Request System
// Features: API-Football, League Filtering, MongoDB Upsert, 15m Fetch / 5m DB Prediction Update

import express from "express";
import axios from "axios";
import mongoose from "mongoose";
import moment from "moment-timezone";
import cron from "node-cron";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
const PORT = process.env.PORT || 8080;

// ----------------- CONFIGURATION & LEAGUES -----------------
// Top 8 Leagues + World Cup Qualifier (API-Football IDs)
// 39: Premier League, 140: La Liga, 135: Serie A, 78: Bundesliga, 61: Ligue 1, 2: Champions League, 3: Europa League, 848: Saudi Pro League (Example Top 8)
// 1: World Cup (General ID) or use current qualifier ID if known (e.g., FIFA World Cup 2026 Qualifiers: 10 or 15)
const TARGET_LEAGUES = [39, 140, 135, 78, 61, 2, 3, 848, 10]; // Example set of 9 IDs
const API_FOOTBALL_BASE_URL = "https://v3.football.api-sports.io/fixtures";

let liveMatchesCache = []; // Cache for fetched matches

// ----------------- MONGO -----------------
const MONGO_URL = process.env.MONGO_PUBLIC_URL || "mongodb://localhost:27017/footballDB"; // Fallback for local testing
if (!MONGO_URL) {
  console.error("❌ MONGO_PUBLIC_URL missing");
  process.exit(1);
}
mongoose.connect(MONGO_URL)
  .then(() => console.log("✔ MongoDB Connected"))
  .catch(err => console.error("❌ Mongo Error:", err));

// ----------------- SCHEMA -----------------
const PredictionSchema = new mongoose.Schema({
  match_id: { type: Number, unique: true, required: true }, // Changed to Number as API-Football IDs are numbers
  league: String,
  teams: String,
  winnerProb: Object,
  bttsProb: Number,
  overUnder: Object,
  last10Prob: Number,
  xG: Object,
  strongMarkets: Array,
  sourceAPI: String,
  // Store key API data for quick access without fetching
  fixture_data: Object,
  teams_data: Object,
  goals_data: Object,
  updated_at: { type: Date, default: Date.now }
});
PredictionSchema.index({ match_id: 1 }, { unique: true });
const Prediction = mongoose.model("Prediction", PredictionSchema);

// ----------------- API KEYS -----------------
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || "hy fdab0eef5743173c30f9810bef3a6742"; // Using your key as default
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY; // Fallback API key (optional)
if (!API_FOOTBALL_KEY) {
  console.error("❌ API_FOOTBALL_KEY missing");
  // We will continue using the provided key as default for demonstration
}

// ----------------- FETCH LIVE MATCHES (1 REQUEST / 15 MIN) -----------------
async function fetchLiveMatches() {
  const todayUTC = moment.utc().format("YYYY-MM-DD");
  let matches = [];

  // --- API-Football Primary (Filtered) ---
  try {
    // Fetch all live matches (status=Live/1H/HT/2H/ET/P) OR today's scheduled matches for target leagues
    // Strategy: Fetch live *globally* OR fetch today's *scheduled* for specific leagues to cover NS matches.
    
    // 1. Fetch ALL LIVE matches globally (using the 'live=all' method, which is generally 1 request)
    const resAF_live = await axios.get(API_FOOTBALL_BASE_URL, {
      headers: { "x-apisports-key": API_FOOTBALL_KEY },
      params: { live: "all" },
      timeout: 10000
    });
    
    const liveMatches = resAF_live.data?.response || [];
    console.log(`✔ [API-Football] Fetched ${liveMatches.length} truly live matches (1 API call).`);
    matches.push(...liveMatches);

    // 2. Fetch TODAY's SCHEDULED matches for target leagues (to capture NS/TBD status for prediction)
    // NOTE: This will use up to N requests if the API requires one call per league ID.
    // To stay strictly at 1 request/15 min, we stick to 'live=all' ONLY.
    // If you need NS matches for specific leagues, you must use league=ID&date=TODAY which takes multiple calls.
    // STICKING TO 1 REQUEST/15 MIN MANDATE:
    
    /*
    // OPTIONAL: UNCOMMENT BELOW IF YOU CAN AFFORD MULTIPLE REQUESTS (e.g., 9 calls per day total)
    for (const leagueId of TARGET_LEAGUES) {
        const resAF_scheduled = await axios.get(API_FOOTBALL_BASE_URL, {
            headers: { "x-apisports-key": API_FOOTBALL_KEY },
            params: { date: todayUTC, league: leagueId, status: "NS" },
            timeout: 10000
        });
        const scheduledMatches = resAF_scheduled.data?.response || [];
        matches.push(...scheduledMatches);
        console.log(`   Fetched ${scheduledMatches.length} scheduled matches for League ${leagueId}.`);
    }
    // Remove duplicates based on fixture ID
    const uniqueMatches = {};
    matches.forEach(m => uniqueMatches[m.fixture.id] = m);
    matches = Object.values(uniqueMatches);
    */
    
    // Filter the fetched 'live=all' list to only include target leagues for prediction/display
    const filteredMatches = matches.filter(m => TARGET_LEAGUES.includes(m.league.id));

    liveMatchesCache = filteredMatches.map(m => ({
      fixture: m.fixture,
      league: m.league,
      teams: m.teams,
      goals: m.goals,
      status: m.fixture.status.short,
      sourceAPI: "API-Football"
    }));
    
    console.log(`✔ [API-Football] Total relevant matches (Live + Target Leagues): ${liveMatchesCache.length}`);
    return liveMatchesCache;

  } catch (err) {
    console.error("❌ [API-Football] Error:", err.message);
    // Fallback is removed to strictly adhere to the professional single-source system
  }

  return liveMatchesCache; // Return last known state or empty array
}

// ----------------- INITIAL FETCH ON SERVER START -----------------
(async () => {
  console.log("🟢 Initial live match fetch on server start...");
  await fetchLiveMatches(); // Populates liveMatchesCache
  console.log(`🟢 Initial fetch matches: ${liveMatchesCache.length}`);
})();


// ----------------- PREDICTION ENGINE (DB-Based Logic) -----------------
// This function needs the full match object for detailed prediction, but for the 5-min update
// it uses the simplified data stored in the DB (name/id/league).
async function makePrediction(match) {
  try {
    const home = match.teams.home.name;
    const away = match.teams.away.name;
    
    // Simplistic xG/Form generation (replace with actual calculation)
    const xG_home = Number((Math.random() * 2 + 0.5).toFixed(2));
    const xG_away = Number((Math.random() * 2 + 0.5).toFixed(2));
    const xG_total = Number((xG_home + xG_away).toFixed(2));

    let homeProb = Math.round((xG_home / (xG_home + xG_away)) * 100);
    let awayProb = Math.round((xG_away / (xG_home + xG_away)) * 100);
    let drawProb = Math.max(0, 100 - homeProb - awayProb); // Ensure draw is non-negative
    
    // Normalize probabilities to 100%
    const sum = homeProb + awayProb + drawProb;
    homeProb = Math.round(homeProb / sum * 100);
    awayProb = Math.round(awayProb / sum * 100);
    drawProb = 100 - homeProb - awayProb; // Ensures sum is exactly 100

    const bttsProb = Math.min(95, Math.round(Math.random() * 50 + xG_total * 10));
    const overUnder = {};
    for (let t = 0.5; t <= 5.5; t += 0.5)
      overUnder[t.toFixed(1)] = Math.min(98, Math.round(Math.random() * 50 + xG_total * 10));
    const last10Prob = Math.min(95, Math.round(xG_total * 15));

    const strongMarkets = [];
    if (homeProb >= 80) strongMarkets.push({ market: "Home Win", prob: homeProb });
    if (awayProb >= 80) strongMarkets.push({ market: "Away Win", prob: awayProb });
    if (bttsProb >= 80) strongMarkets.push({ market: "BTTS", prob: bttsProb });
    Object.keys(overUnder).forEach(k => {
      if (overUnder[k] >= 80) strongMarkets.push({ market: `Over ${k}`, prob: overUnder[k] });
      if ((100 - overUnder[k]) >= 80) strongMarkets.push({ market: `Under ${k}`, prob: 100 - overUnder[k] });
    });

    return {
      match_id: match.fixture?.id || match.match_id, // Use existing ID if coming from DB
      league: match.league?.name || "Unknown",
      teams: `${home} vs ${away}`,
      winnerProb: { home: homeProb, draw: drawProb, away: awayProb },
      bttsProb,
      overUnder,
      last10Prob,
      xG: { home: xG_home, away: xG_away, total: xG_total },
      strongMarkets,
      sourceAPI: match.sourceAPI || "API-Football",
      fixture_data: match.fixture,
      teams_data: match.teams,
      goals_data: match.goals,
      updated_at: new Date()
    };
  } catch (err) {
    console.error("❌ makePrediction error:", err.message);
    return null;
  }
}


// ----------------- CRON JOBS -----------------

// 1. Fetch Live Matches (API Load: 1 Request / 15 Minutes)
cron.schedule("*/15 * * * *", async () => {
  console.log("🕒 Cron: Fetching live matches and saving predictions (1 API call)...");
  const matches = await fetchLiveMatches(); // Updates liveMatchesCache

  for (const m of matches) {
    const pred = await makePrediction(m);
    if (!pred) continue;
    
    // MongoDB UPSERT (Update or Insert/Replace): Duplicate-Free Storage
    await Prediction.replaceOne({ match_id: pred.match_id }, pred, { upsert: true });
    console.log(`✔ Prediction Saved/Updated: ${pred.teams} (ID: ${pred.match_id})`);
  }
});

// 2. Update Predictions (API Load: ZERO / 5 Minutes)
cron.schedule("*/5 * * * *", async () => {
  console.log("🕒 Cron: Updating predictions using DB data (Zero API Load)...");
  
  // Fetch the matches currently in the DB
  const existingMatches = await Prediction.find().limit(200); 

  for (const m of existingMatches) {
    // Reconstruct required input for makePrediction from DB data
    const updatedPred = await makePrediction({
      match_id: m.match_id,
      teams: m.teams_data, // Use stored teams_data
      league: { name: m.league },
      fixture: m.fixture_data,
      goals: m.goals_data,
      sourceAPI: m.sourceAPI
    });
    
    if (updatedPred) {
        // Only update prediction fields, not the original fixture data
        await Prediction.updateOne(
            { match_id: m.match_id }, 
            { $set: { 
                winnerProb: updatedPred.winnerProb, 
                bttsProb: updatedPred.bttsProb,
                overUnder: updatedPred.overUnder,
                last10Prob: updatedPred.last10Prob,
                xG: updatedPred.xG,
                strongMarkets: updatedPred.strongMarkets,
                updated_at: updatedPred.updated_at
            }}
        );
    }
  }
});


// ----------------- API ROUTES -----------------
// Serve matches from cache (Zero API Load)
app.get("/today-matches", async (req, res) => {
  res.json(liveMatchesCache);
});

// Serve predictions from DB (Zero API Load)
app.get("/prediction", async (req, res) => {
  const preds = await Prediction.find().sort({ updated_at: -1 }).limit(200);
  res.json(preds);
});

// ----------------- SSE -----------------
app.get("/events", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  
  const sendUpdates = async () => {
    // Fetches latest 200 predictions from DB
    const preds = await Prediction.find().sort({ updated_at: -1 }).limit(200);
    res.write(`data: ${JSON.stringify({ ts: Date.now(), matches: preds })}\n\n`);
  };
  
  // Send data immediately and then every 5 minutes
  await sendUpdates();
  const interval = setInterval(sendUpdates, 5 * 60 * 1000); // 5 minutes (Matches Cron)
  
  req.on("close", () => clearInterval(interval));
});

// ----------------- SERVE INDEX.HTML -----------------
app.get("/", (req, res) => {
  const filePath = path.join(__dirname, "index.html");
  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) return res.status(500).send("❌ index.html not found");
    res.setHeader("Content-Type", "text/html");
    res.send(data);
  });
});

// ----------------- START SERVER -----------------
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
