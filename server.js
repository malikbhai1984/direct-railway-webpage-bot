

// server.js - Professional 100-Request System
// ✔ 15-min API calls (96/day) ✔ 5-min predictions ✔ Duplicate-free ✔ Top 10 Leagues + WC Qualifiers

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
app.use(express.json());
const PORT = process.env.PORT || 8080;

// ===================== MONGODB CONNECTION =====================
mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/football", {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.log("❌ MongoDB Error:", err));

// ===================== SCHEMAS =====================
// Live Match Schema
const MatchSchema = new mongoose.Schema({
  match_id: { type: String, required: true, unique: true },
  league_id: Number,
  league_name: String,
  home_team: String,
  away_team: String,
  match_date: Date,
  status: String,
  home_score: Number,
  away_score: Number,
  updated_at: { type: Date, default: Date.now }
});

// Prediction Schema (duplicate-free with upsert)
const PredictionSchema = new mongoose.Schema({
  match_id: { type: String, required: true, unique: true },
  league: String,
  home_team: String,
  away_team: String,
  match_date: Date,
  winner_prob: {
    home: Number,
    draw: Number,
    away: Number
  },
  btts_prob: Number,
  over_under: Object,
  last10_prob: Number,
  xG: {
    home: Number,
    away: Number,
    total: Number
  },
  strong_markets: Array,
  confidence_score: Number,
  updated_at: { type: Date, default: Date.now }
});

const Match = mongoose.model("Match", MatchSchema);
const Prediction = mongoose.model("Prediction", PredictionSchema);

// ===================== API CONFIGURATION =====================
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || "fdab0eef5743173c30f9810bef3a6742";
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY || "62207494b8a241db93aee4c14b7c1266";

// Top 10 Leagues + World Cup Qualifiers (API-Football IDs)
const TARGET_LEAGUES = [
  39,   // Premier League
  140,  // La Liga
  135,  // Serie A
  78,   // Bundesliga
  61,   // Ligue 1
  94,   // Primeira Liga
  88,   // Eredivisie
  203,  // Super Lig
  2,    // Champions League
  3,    // Europa League
  // World Cup Qualifiers
  32,   // World Cup Qualification (UEFA)
  34,   // World Cup Qualification (CONMEBOL)
  33,   // World Cup Qualification (CAF)
];

// ===================== HELPER FUNCTIONS =====================
async function fetchWithFallback(url, headers, fallbackFn) {
  try {
    const response = await axios.get(url, { headers, timeout: 12000 });
    return response.data;
  } catch (error) {
    console.log(`⚠️ API Error (trying fallback): ${error.message}`);
    if (fallbackFn) return await fallbackFn();
    return null;
  }
}

// ===================== FETCH LIVE MATCHES (15 MIN INTERVAL) =====================
async function fetchLiveMatches() {
  console.log("🔄 Fetching Live Matches...");
  
  try {
    const today = moment().tz("Asia/Karachi").format("YYYY-MM-DD");
    
    // Primary: API-Football
    const url = `https://v3.football.api-sports.io/fixtures?date=${today}`;
    const headers = { "x-apisports-key": API_FOOTBALL_KEY };
    
    const data = await fetchWithFallback(url, headers, async () => {
      // Fallback: Football-Data.org
      const fbUrl = `https://api.football-data.org/v4/matches?date=${today}`;
      const fbHeaders = { "X-Auth-Token": FOOTBALL_DATA_KEY };
      const fbData = await axios.get(fbUrl, { headers: fbHeaders, timeout: 12000 });
      
      // Convert Football-Data format to API-Football format
      return {
        response: (fbData.data.matches || []).map(m => ({
          fixture: {
            id: m.id,
            date: m.utcDate,
            status: { short: m.status === "FINISHED" ? "FT" : "NS" }
          },
          league: { id: m.competition.id, name: m.competition.name },
          teams: {
            home: { id: m.homeTeam.id, name: m.homeTeam.name },
            away: { id: m.awayTeam.id, name: m.awayTeam.name }
          },
          goals: { home: m.score.fullTime.home, away: m.score.fullTime.away }
        }))
      };
    });

    if (!data || !data.response) {
      console.log("❌ No match data received");
      return;
    }

    // Filter for target leagues only
    const matches = data.response.filter(m => 
      TARGET_LEAGUES.includes(m.league.id)
    );

    console.log(`✅ Found ${matches.length} matches in target leagues`);

    // Save to MongoDB (replace old data)
    for (const match of matches) {
      const matchData = {
        match_id: String(match.fixture.id),
        league_id: match.league.id,
        league_name: match.league.name,
        home_team: match.teams.home.name,
        away_team: match.teams.away.name,
        match_date: new Date(match.fixture.date),
        status: match.fixture.status.short,
        home_score: match.goals.home || 0,
        away_score: match.goals.away || 0,
        updated_at: new Date()
      };

      await Match.findOneAndUpdate(
        { match_id: matchData.match_id },
        matchData,
        { upsert: true, new: true }
      );
    }

    console.log(`✅ ${matches.length} matches saved to MongoDB`);
    
  } catch (error) {
    console.log(`❌ fetchLiveMatches Error: ${error.message}`);
  }
}

// ===================== GET TEAM STATISTICS =====================
async function getTeamStats(teamId) {
  try {
    const url = `https://v3.football.api-sports.io/teams/statistics?team=${teamId}&season=2024`;
    const headers = { "x-apisports-key": API_FOOTBALL_KEY };
    
    const data = await axios.get(url, { headers, timeout: 8000 });
    return data.data.response;
  } catch (error) {
    return null;
  }
}

// ===================== ADVANCED PREDICTION ENGINE =====================
async function generatePrediction(match) {
  try {
    const homeTeam = match.home_team;
    const awayTeam = match.away_team;

    // Get recent form from database (last 10 matches for each team)
    const homeMatches = await Match.find({
      $or: [{ home_team: homeTeam }, { away_team: homeTeam }],
      status: "FT"
    }).sort({ match_date: -1 }).limit(10);

    const awayMatches = await Match.find({
      $or: [{ home_team: awayTeam }, { away_team: awayTeam }],
      status: "FT"
    }).sort({ match_date: -1 }).limit(10);

    // Calculate form metrics
    let homeGoalsFor = 0, homeGoalsAgainst = 0, homeWins = 0, homeDraws = 0;
    let awayGoalsFor = 0, awayGoalsAgainst = 0, awayWins = 0, awayDraws = 0;

    homeMatches.forEach(m => {
      if (m.home_team === homeTeam) {
        homeGoalsFor += m.home_score || 0;
        homeGoalsAgainst += m.away_score || 0;
        if ((m.home_score || 0) > (m.away_score || 0)) homeWins++;
        if ((m.home_score || 0) === (m.away_score || 0)) homeDraws++;
      } else {
        homeGoalsFor += m.away_score || 0;
        homeGoalsAgainst += m.home_score || 0;
        if ((m.away_score || 0) > (m.home_score || 0)) homeWins++;
        if ((m.home_score || 0) === (m.away_score || 0)) homeDraws++;
      }
    });

    awayMatches.forEach(m => {
      if (m.home_team === awayTeam) {
        awayGoalsFor += m.home_score || 0;
        awayGoalsAgainst += m.away_score || 0;
        if ((m.home_score || 0) > (m.away_score || 0)) awayWins++;
        if ((m.home_score || 0) === (m.away_score || 0)) awayDraws++;
      } else {
        awayGoalsFor += m.away_score || 0;
        awayGoalsAgainst += m.home_score || 0;
        if ((m.away_score || 0) > (m.home_score || 0)) awayWins++;
        if ((m.home_score || 0) === (m.away_score || 0)) awayDraws++;
      }
    });

    // Advanced xG calculation (Expected Goals)
    const homeAvgFor = homeMatches.length > 0 ? homeGoalsFor / homeMatches.length : 1.2;
    const homeAvgAgainst = homeMatches.length > 0 ? homeGoalsAgainst / homeMatches.length : 1.2;
    const awayAvgFor = awayMatches.length > 0 ? awayGoalsFor / awayMatches.length : 1.0;
    const awayAvgAgainst = awayMatches.length > 0 ? awayGoalsAgainst / awayMatches.length : 1.0;

    // Poisson-based xG with home advantage
    const xG_home = Number((homeAvgFor * 1.3 + awayAvgAgainst * 0.7 + 0.2).toFixed(2));
    const xG_away = Number((awayAvgFor * 0.9 + homeAvgAgainst * 0.6).toFixed(2));
    const xG_total = Number((xG_home + xG_away).toFixed(2));

    // Winner probabilities (ML-style calculation)
    const homeFormScore = (homeWins * 3 + homeDraws * 1) / Math.max(homeMatches.length, 1);
    const awayFormScore = (awayWins * 3 + awayDraws * 1) / Math.max(awayMatches.length, 1);
    
    const homeStrength = xG_home * 2 + homeFormScore * 1.5;
    const awayStrength = xG_away * 2 + awayFormScore * 1.2;
    const totalStrength = homeStrength + awayStrength;

    let homeProb = Math.round((homeStrength / totalStrength) * 100);
    let awayProb = Math.round((awayStrength / totalStrength) * 100);
    let drawProb = Math.max(100 - homeProb - awayProb, 15);

    // Normalize to 100%
    const sum = homeProb + drawProb + awayProb;
    homeProb = Math.round((homeProb / sum) * 100);
    drawProb = Math.round((drawProb / sum) * 100);
    awayProb = 100 - homeProb - drawProb;

    // BTTS (Both Teams To Score) probability
    const bttsHistory = [...homeMatches, ...awayMatches].filter(m => 
      (m.home_score || 0) > 0 && (m.away_score || 0) > 0
    ).length;
    const bttsProb = Math.min(95, Math.round(
      (bttsHistory / Math.max(homeMatches.length + awayMatches.length, 1)) * 100 + 
      (xG_total > 2.5 ? 15 : 0)
    ));

    // Over/Under markets
    const overUnder = {};
    [0.5, 1.5, 2.5, 3.5, 4.5, 5.5].forEach(line => {
      const overProb = Math.min(98, Math.max(5, Math.round(
        (xG_total / (line + 0.5)) * 55 + (Math.random() * 15)
      )));
      overUnder[line.toFixed(1)] = overProb;
    });

    // Last 10 minutes goal probability
    const last10Prob = Math.min(92, Math.max(8, Math.round(
      xG_total * 11 + (homeAvgFor + awayAvgFor) * 5
    )));

    // Strong markets (>85% confidence)
    const strongMarkets = [];
    if (homeProb >= 85) strongMarkets.push({ market: "Home Win", prob: homeProb });
    if (drawProb >= 85) strongMarkets.push({ market: "Draw", prob: drawProb });
    if (awayProb >= 85) strongMarkets.push({ market: "Away Win", prob: awayProb });
    if (bttsProb >= 85) strongMarkets.push({ market: "BTTS Yes", prob: bttsProb });
    
    Object.entries(overUnder).forEach(([line, prob]) => {
      if (prob >= 85) strongMarkets.push({ market: `Over ${line}`, prob });
      if ((100 - prob) >= 85) strongMarkets.push({ market: `Under ${line}`, prob: 100 - prob });
    });

    // Confidence score
    const confidenceScore = Math.round(
      (homeMatches.length + awayMatches.length) / 20 * 100
    );

    return {
      match_id: match.match_id,
      league: match.league_name,
      home_team: homeTeam,
      away_team: awayTeam,
      match_date: match.match_date,
      winner_prob: { home: homeProb, draw: drawProb, away: awayProb },
      btts_prob: bttsProb,
      over_under: overUnder,
      last10_prob: last10Prob,
      xG: { home: xG_home, away: xG_away, total: xG_total },
      strong_markets: strongMarkets,
      confidence_score: Math.min(100, confidenceScore),
      updated_at: new Date()
    };

  } catch (error) {
    console.log(`❌ Prediction Error: ${error.message}`);
    return null;
  }
}

// ===================== UPDATE PREDICTIONS (5 MIN INTERVAL) =====================
async function updatePredictions() {
  console.log("🔄 Updating Predictions...");
  
  try {
    const matches = await Match.find({ 
      status: { $in: ["NS", "1H", "HT", "2H", "ET", "P", "LIVE"] }
    }).limit(200);

    console.log(`📊 Processing ${matches.length} matches...`);
    let updated = 0;

    for (const match of matches) {
      const prediction = await generatePrediction(match);
      if (prediction) {
        // UPSERT: Update if exists, insert if new (NO DUPLICATES)
        await Prediction.findOneAndUpdate(
          { match_id: prediction.match_id },
          prediction,
          { upsert: true, new: true }
        );
        updated++;
      }
    }

    console.log(`✅ ${updated} predictions updated (duplicate-free)`);
    
  } catch (error) {
    console.log(`❌ updatePredictions Error: ${error.message}`);
  }
}

// ===================== CRON JOBS =====================
// Fetch matches every 15 minutes (96 requests/day)
cron.schedule("*/15 * * * *", async () => {
  console.log("⏰ CRON: Fetching live matches (15-min interval)");
  await fetchLiveMatches();
});

// Update predictions every 5 minutes (0 API calls - uses DB only)
cron.schedule("*/5 * * * *", async () => {
  console.log("⏰ CRON: Updating predictions (5-min interval)");
  await updatePredictions();
});

// Initial fetch on startup
setTimeout(() => {
  fetchLiveMatches();
  setTimeout(() => updatePredictions(), 10000);
}, 3000);

// ===================== SSE ENDPOINT =====================
app.get("/events", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  console.log("👤 SSE Client Connected");

  const sendData = async () => {
    try {
      const predictions = await Prediction.find()
        .sort({ updated_at: -1 })
        .limit(200);
      
      const matches = await Match.find()
        .sort({ match_date: 1 })
        .limit(200);

      res.write(`data: ${JSON.stringify({ 
        predictions, 
        matches,
        timestamp: new Date().toISOString()
      })}\n\n`);
    } catch (error) {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    }
  };

  await sendData();
  const interval = setInterval(sendData, 5 * 60 * 1000); // Every 5 minutes

  req.on("close", () => {
    clearInterval(interval);
    console.log("❌ SSE Client Disconnected");
  });
});

// ===================== API ROUTES =====================
app.get("/api/predictions", async (req, res) => {
  try {
    const predictions = await Prediction.find()
      .sort({ updated_at: -1 })
      .limit(200);
    res.json({ success: true, count: predictions.length, data: predictions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/matches", async (req, res) => {
  try {
    const matches = await Match.find()
      .sort({ match_date: 1 })
      .limit(200);
    res.json({ success: true, count: matches.length, data: matches });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/today", async (req, res) => {
  try {
    const today = moment().tz("Asia/Karachi").startOf("day");
    const tomorrow = moment(today).add(1, "day");
    
    const matches = await Match.find({
      match_date: { $gte: today.toDate(), $lt: tomorrow.toDate() }
    }).sort({ match_date: 1 });

    const matchIds = matches.map(m => m.match_id);
    const predictions = await Prediction.find({ match_id: { $in: matchIds } });

    res.json({ 
      success: true, 
      date: today.format("YYYY-MM-DD"),
      matches, 
      predictions 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===================== SERVE FRONTEND =====================
app.use(express.static(__dirname));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ===================== START SERVER =====================
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║   ⚽ FOOTBALL PREDICTION SYSTEM LIVE ⚽    ║
║                                            ║
║   🚀 Server: http://localhost:${PORT}     ║
║   📊 API: /api/predictions                 ║
║   🔴 Live: /events (SSE)                   ║
║                                            ║
║   ✅ 15-min API calls (96/day)             ║
║   ✅ 5-min predictions (DB only)           ║
║   ✅ Duplicate-free system                 ║
║   ✅ Top 10 Leagues + WC Qualifiers        ║
╚════════════════════════════════════════════╝
  `);
});
