


// server.js
// Professional 100-Request System for API-Football (Live Matches & Duplicate-Free Predictions)
// Uses cron jobs for controlled API calls and prediction updates.

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

// ----------------- CONFIGURATION -----------------
// 1. API-Football Key (MUST be set in Railway/Environment Variables)
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || "hy fdab0eef5743173c30f9810bef3a6742"; // Use your provided key
// 2. MongoDB URI (MUST be set in Railway/Environment Variables)
const MONGO_URI = process.env.MONGO_URI || "mongodb://mongo:password@host:port/football_predictions";

// Cache for live matches data (to serve /today-matches without hitting API)
let liveMatchesCache = [];

// ----------------- MONGODB SETUP -----------------
mongoose.connect(MONGO_URI)
  .then(() => console.log("✔ MongoDB Connected"))
  .catch(err => console.log("❌ Mongo Error:", err.message));

// ----------------- SCHEMA (Match & Prediction) -----------------
const PredictionSchema = new mongoose.Schema({
  // match_id is the unique identifier (API-Football fixture.id)
  match_id: { type: Number, unique: true, required: true }, 
  league: String,
  teams: String,
  winnerProb: Object,
  bttsProb: Number,
  overUnder: Object,
  last10Prob: Number,
  xG: Object,
  strongMarkets: Array,
  // API-Football data structure for match details, useful for frontend
  fixture: Object, 
  teams_data: Object,
  goals_data: Object,
  updated_at: { type: Date, default: Date.now }
});

// Set match_id as unique index (for efficient auto-replace)
PredictionSchema.index({ match_id: 1 }, { unique: true });

const Prediction = mongoose.model("Prediction", PredictionSchema);

// ----------------- API-FOOTBALL FETCH (1 REQUEST / 15 MIN) -----------------
// Fetches all live matches globally.
async function fetchLiveMatches() {
  try {
    const url = "https://v3.football.api-sports.io/fixtures?live=all";
    const headers = { "x-apisports-key": API_FOOTBALL_KEY };
    const r = await axios.get(url, { headers, timeout: 10000 });
    
    // API-Football response is in r.data.response
    const fixtures = r.data?.response || [];
    
    // Update cache
    liveMatchesCache = fixtures;
    console.log(`✔ API-Football: ${fixtures.length} live matches fetched (1 API call).`);
    return fixtures;
  } catch (err) {
    console.error("❌ fetchLiveMatches error:", err.message);
    return [];
  }
}

// ----------------- Prediction Engine Helpers (API-Football structure) -----------------

// Placeholder for fetching last N matches for a team (not possible in free plan easily, 
// so we'll use a simulated form for the core logic, or you'll need to upgrade/find another source)
// For Professional System, we *assume* you have the data structure to calculate form (last 15)
// since this is a high-level system logic request. We'll use a simplified xG/Form heuristic.

// Simplified helper for form data (simulates fetching/processing)
function getTeamFormStats(teamId, matchId) {
    // In a real pro system, this would fetch last N matches from your DB/external API
    // For this demonstration, we use a simple placeholder logic for AvgGoals
    const avgFor = 1.0 + Math.random() * 0.7; // 1.0 to 1.7
    const avgAgainst = 1.0 + Math.random() * 0.7; // 1.0 to 1.7
    const matchesPlayed = 15; // Assume 15 matches for a solid form
    return { avgFor, avgAgainst, matchesPlayed };
}

// ----------------- PRO-LEVEL PREDICTION ENGINE (DB ONLY / 5 MIN) -----------------
// Uses the simplified form/xG heuristic
async function makePrediction(match) {
  try {
    const home = match.teams.home.name;
    const away = match.teams.away.name;
    const homeId = match.teams.home.id;
    const awayId = match.teams.away.id;

    // 1) Get Form Data (simulated for simplicity, should use real data)
    const homeForm = getTeamFormStats(homeId, match.fixture.id);
    const awayForm = getTeamFormStats(awayId, match.fixture.id);

    // Get Averages
    const avgHomeFor = homeForm.avgFor;
    const avgAwayFor = awayForm.avgFor;
    const avgHomeAgainst = homeForm.avgAgainst;
    const avgAwayAgainst = awayForm.avgAgainst;

    // 2) xG estimate (Simplified Poisson-ish heuristic)
    // Attack Strength (AS) = avgFor / LeagueAvgFor (simplified to avgFor)
    // Defense Strength (DS) = avgAgainst / LeagueAvgAgainst (simplified to 1 / avgAgainst)
    const AS_home = avgHomeFor;
    const DS_home = 1 / avgHomeAgainst;
    const AS_away = avgAwayFor;
    const DS_away = 1 / avgAwayAgainst;

    // xG_home = AS_home * DS_away * LeagueAvgGoals (simplified)
    const xG_home = Number((AS_home * DS_away * 1.5 + Math.random() * 0.2).toFixed(2));
    const xG_away = Number((AS_away * DS_home * 1.4 + Math.random() * 0.2).toFixed(2));
    const xG_total = Number((xG_home + xG_away).toFixed(2));

    // 3) Winner probabilities (Heuristic)
    // Use xG to find winner factor
    let homeFactor = xG_home * 1.5 + (homeForm.matchesPlayed ? 0.5 : 0);
    let awayFactor = xG_away * 1.5 + (awayForm.matchesPlayed ? 0.5 : 0);
    
    const totalFactor = homeFactor + awayFactor + 0.5; // +0.5 for draw buffer
    
    let homeProb = Math.round(homeFactor / totalFactor * 100);
    let awayProb = Math.round(awayFactor / totalFactor * 100);
    let drawProb = 100 - homeProb - awayProb;
    
    // Normalize if needed
    if (drawProb < 0) { // Should not happen with +0.5 buffer, but safe check
        const excess = -drawProb;
        drawProb = 0;
        homeProb = Math.round(homeProb / (homeProb + awayProb) * (100 - drawProb));
        awayProb = 100 - homeProb;
    }

    // 4) BTTS probability
    let bttsProb = Math.min(95, Math.round(xG_home * 15 + xG_away * 15 + Math.random() * 10)); // Heuristic
    bttsProb = Math.max(5, bttsProb);

    // 5) Over/Under markets
    const overUnder = {};
    for (let t = 0.5; t <= 5.5; t += 0.5) {
      // higher xG_total -> higher chance Over t
      const base = Math.min(98, Math.round((xG_total / (t + 0.1)) * 40 + (Math.random() * 15)));
      overUnder[t.toFixed(1)] = Math.max(2, base);
    }

    // 6) Last 10 minutes probability (General late-goal tendency based on xG total)
    const last10Base = Math.round(xG_total * 10 + Math.random() * 20);
    const last10Prob = Math.min(95, Math.max(5, last10Base));

    // 7) Strong markets >=80%
    const strongMarkets = [];
    Object.keys(overUnder).forEach(k => {
      if (overUnder[k] >= 80) strongMarkets.push({ market: `Over ${k}`, prob: overUnder[k] });
      if ((100 - overUnder[k]) >= 80) strongMarkets.push({ market: `Under ${k}`, prob: 100 - overUnder[k] });
    });
    if (homeProb >= 80) strongMarkets.push({ market: "Home Win", prob: homeProb });
    if (awayProb >= 80) strongMarkets.push({ market: "Away Win", prob: awayProb });
    if (bttsProb >= 80) strongMarkets.push({ market: "BTTS", prob: bttsProb });
    if (drawProb >= 80) strongMarkets.push({ market: "Draw", prob: drawProb });


    // final object
    return {
      match_id: match.fixture.id,
      league: match.league?.name || "Unknown",
      teams: `${home} vs ${away}`,
      winnerProb: { home: homeProb, draw: drawProb, away: awayProb },
      bttsProb,
      overUnder,
      last10Prob,
      xG: { home: xG_home, away: xG_away, total: xG_total },
      strongMarkets,
      fixture: match.fixture, // Full fixture object from API-Football
      teams_data: match.teams, // Full teams object
      goals_data: match.goals, // Full goals object
      updated_at: Date.now()
    };

  } catch (err) {
    console.error("❌ makePrediction error:", err.message);
    return null;
  }
}

// ----------------- CRON JOBS -----------------

// 1. Fetch Live Matches (1 API Request / 15 Minutes)
cron.schedule("*/15 * * * *", async () => {
  console.log("🔁 Cron Job: Fetching Live Matches...");
  await fetchLiveMatches(); // Updates liveMatchesCache
});

// 2. Run Prediction Engine & Save (DB ONLY / 5 Minutes)
cron.schedule("*/5 * * * *", async () => {
  console.log("🔁 Cron Job: Running Prediction Engine...");
  
  // Use the cached live matches data (Zero API load here)
  const matches = liveMatchesCache; 
  
  for (const m of matches) {
    // Only predict on matches that are 'Live' or not started 'NS' / '1H' / 'HT' / '2H' / 'ET' / 'P'
    const status = m.fixture?.status?.short;
    if (["FT", "AET", "PEN", "CANC", "PSTP"].includes(status)) continue; // Skip finished/cancelled

    const p = await makePrediction(m);
    if (!p) continue;
    
    // Save to DB (match_id is unique, so this will REPLACE/UPDATE the old prediction)
    await Prediction.replaceOne({ match_id: p.match_id }, p, { upsert: true }); 
    console.log(`✔ Prediction Saved/Updated: ${p.teams} (ID: ${p.match_id})`);
  }
});

// Start fetching immediately on server start (if the API allows for the first call)
fetchLiveMatches(); 

// ----------------- SSE live endpoint (sends last 200 predictions every 5 minutes) -----------------
app.get("/events", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  console.log("👤 SSE Client Connected");

  const sendUpdates = async () => {
    try {
      // Fetch latest 200 predictions from DB
      const preds = await Prediction.find().sort({ updated_at: -1 }).limit(200);
      
      const formatted = preds.map(p => ({
        id: p.match_id,
        teams: p.teams,
        league: p.league,
        winnerProb: p.winnerProb,
        bttsProb: p.bttsProb,
        overUnder: p.overUnder,
        last10Prob: p.last10Prob,
        xG: p.xG,
        strongMarkets: p.strongMarkets,
        // Match status and score for live update
        status: p.fixture?.status?.short,
        elapsed: p.fixture?.status?.elapsed,
        score: p.goals_data,
        date: moment(p.fixture?.date).tz("Asia/Karachi").format("YYYY-MM-DD HH:mm:ss")
      }));
      
      res.write(`data: ${JSON.stringify({ ts: Date.now(), matches: formatted })}\n\n`);
    } catch (err) {
      console.error("❌ SSE sendUpdates error:", err.message);
      // Optional: res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    }
  };

  // Send immediately and then every 5 minutes (matches cron job update)
  await sendUpdates();
  const interval = setInterval(sendUpdates, 5 * 60 * 1000); // 5 minutes

  req.on("close", () => {
    clearInterval(interval);
    console.log("❌ SSE Client Disconnected");
  });
});

// ----------------- API ROUTES -----------------
// Route to get all predictions (for testing or non-SSE users)
app.get("/prediction", async (req, res) => {
  const preds = await Prediction.find().sort({ updated_at: -1 }).limit(200);
  res.json(preds);
});

// Route to get live matches (from cache, zero API load)
app.get("/today-matches", async (req, res) => {
  res.json(liveMatchesCache);
});

// ----------------- STATIC FRONTEND -----------------
app.use(express.static(__dirname));
app.get("/", (req, res) => { res.sendFile(path.join(__dirname, "index.html")); });

// ----------------- START SERVER -----------------
app.listen(PORT, () => { console.log(`🚀 Server running on port ${PORT}. API Key: ${API_FOOTBALL_KEY ? 'Set' : 'MISSING'}`); });
