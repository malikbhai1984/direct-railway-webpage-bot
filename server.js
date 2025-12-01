// server.js - Enhanced Football Prediction System
// ✅ Correct Score Predictions ✅ Top Goal Minutes ✅ H2H Analysis ✅ Odds Suggestions

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
const MONGO_URI = process.env.MONGO_URI || 
                  process.env.MONGODB_URI || 
                  process.env.MONGO_PUBLIC_URL ||
                  process.env.MONGO_URL ||
                  process.env.DATABASE_URL;

if (!MONGO_URI) {
  console.log("❌ CRITICAL ERROR: MongoDB URI not found!");
  console.log("💡 Available environment variables:");
  console.log(Object.keys(process.env).filter(k => k.includes('MONGO') || k.includes('DATABASE')));
  process.exit(1);
}

console.log("✅ MongoDB URI found");
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected Successfully!"))
  .catch(err => {
    console.log("❌ MongoDB Connection Failed:", err.message);
    process.exit(1);
  });

// ===================== SCHEMAS =====================
const MatchSchema = new mongoose.Schema({
  match_id: { type: String, required: true, unique: true },
  league_id: Number,
  league_name: String,
  home_team: String,
  away_team: String,
  home_logo: String,
  away_logo: String,
  match_date: Date,
  match_time_pkt: String,
  status: String,
  home_score: Number,
  away_score: Number,
  venue: String,
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

const PredictionSchema = new mongoose.Schema({
  match_id: { type: String, required: true, unique: true },
  league: String,
  home_team: String,
  away_team: String,
  match_date: Date,
  match_time_pkt: String,
  
  // Enhanced predictions
  winner_prob: {
    home: Number,
    draw: Number,
    away: Number
  },
  correct_scores: Array,  // NEW: Top 2 most likely scores
  btts_prob: Number,
  over_under: Object,
  last10_prob: Number,
  top_goal_minutes: Array,  // NEW: Most likely goal time periods
  xG: {
    home: Number,
    away: Number,
    total: Number
  },
  h2h_stats: Object,  // NEW: Head-to-head analysis
  suggested_odds: Object,  // NEW: Fair odds ranges
  strong_markets: Array,
  risk_notes: Array,  // NEW: Risk warnings
  confidence_score: Number,
  
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

MatchSchema.index({ match_date: -1 });
MatchSchema.index({ status: 1 });
PredictionSchema.index({ updated_at: -1 });
PredictionSchema.index({ match_id: 1 });

const Match = mongoose.model("Match", MatchSchema);
const Prediction = mongoose.model("Prediction", PredictionSchema);

// ===================== API CONFIGURATION =====================
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || "fdab0eef5743173c30f9810bef3a6742";
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY || "62207494b8a241db93aee4c14b7c1266";
const TARGET_LEAGUES = [39, 140, 135, 78, 61, 94, 88, 203, 2, 3, 32, 34, 33];

// ===================== HELPER: Pakistan Time =====================
function formatPakistanTime(dateStr) {
  const pktTime = moment(dateStr).tz("Asia/Karachi");
  return {
    date: pktTime.format("DD MMM YYYY"),
    time: pktTime.format("hh:mm A"),
    fullDateTime: pktTime.format("DD MMM YYYY, hh:mm A"),
    isoDate: pktTime.toISOString()
  };
}

// ===================== FETCH LIVE MATCHES =====================
async function fetchLiveMatches() {
  console.log("\n🔄 ============ FETCHING LIVE MATCHES ============");
  
  try {
    const todayPKT = moment().tz("Asia/Karachi").format("YYYY-MM-DD");
    console.log("📅 Pakistan Date:", todayPKT);

    let matches = [];

    // Fetch from API-Football
    try {
      const response = await axios.get(`https://v3.football.api-sports.io/fixtures`, {
        headers: { "x-apisports-key": API_FOOTBALL_KEY },
        params: { date: todayPKT },
        timeout: 15000
      });

      if (response.data?.response?.length > 0) {
        matches = response.data.response;
        console.log(`✅ API-Football: ${matches.length} matches found`);
      }
    } catch (apiError) {
      console.log("❌ API-Football Error:", apiError.message);
    }

    // Fallback: Fetch all live matches
    if (matches.length === 0) {
      try {
        const liveResponse = await axios.get(`https://v3.football.api-sports.io/fixtures`, {
          headers: { "x-apisports-key": API_FOOTBALL_KEY },
          params: { live: "all" },
          timeout: 15000
        });

        if (liveResponse.data?.response) {
          matches = liveResponse.data.response;
          console.log(`✅ Live matches: ${matches.length} found`);
        }
      } catch (liveError) {
        console.log("❌ Live fetch error:", liveError.message);
      }
    }

    if (matches.length === 0) {
      console.log("❌ No matches found!");
      return;
    }

    console.log(`📊 Processing ${matches.length} matches...`);

    const matchesToSave = matches.slice(0, 100);
    let savedCount = 0;

    for (const match of matchesToSave) {
      try {
        if (!match.teams?.home?.name || !match.teams?.away?.name) continue;

        const pktTime = formatPakistanTime(match.fixture?.date);
        
        const matchData = {
          match_id: String(match.fixture?.id),
          league_id: match.league?.id || 0,
          league_name: match.league?.name || "Unknown League",
          home_team: match.teams.home.name,
          away_team: match.teams.away.name,
          home_logo: match.teams?.home?.logo || "",
          away_logo: match.teams?.away?.logo || "",
          match_date: new Date(match.fixture?.date),
          match_time_pkt: pktTime.fullDateTime,
          status: match.fixture?.status?.short || "NS",
          home_score: match.goals?.home ?? 0,
          away_score: match.goals?.away ?? 0,
          venue: match.fixture?.venue?.name || "Unknown",
          updated_at: new Date()
        };

        await Match.findOneAndUpdate(
          { match_id: matchData.match_id },
          matchData,
          { upsert: true, new: true }
        );
        savedCount++;
      } catch (saveError) {
        console.log(`⚠️ Save error: ${saveError.message}`);
      }
    }

    console.log(`✅ Successfully saved ${savedCount} matches`);
    console.log("============ FETCH COMPLETE ============\n");

  } catch (error) {
    console.log(`❌ CRITICAL ERROR: ${error.message}`);
  }
}

// ===================== ENHANCED PREDICTION ENGINE =====================
async function generatePrediction(match) {
  try {
    const homeTeam = match.home_team;
    const awayTeam = match.away_team;

    // Get last 10 matches for each team
    const homeMatches = await Match.find({
      $or: [{ home_team: homeTeam }, { away_team: homeTeam }],
      status: "FT"
    }).sort({ match_date: -1 }).limit(10);

    const awayMatches = await Match.find({
      $or: [{ home_team: awayTeam }, { away_team: awayTeam }],
      status: "FT"
    }).sort({ match_date: -1 }).limit(10);

    // NEW: Get H2H (Head-to-Head) matches
    const h2hMatches = await Match.find({
      $or: [
        { home_team: homeTeam, away_team: awayTeam, status: "FT" },
        { home_team: awayTeam, away_team: homeTeam, status: "FT" }
      ]
    }).sort({ match_date: -1 }).limit(5);

    // Calculate basic statistics
    let homeGoalsFor = 0, homeGoalsAgainst = 0, homeWins = 0, homeDraws = 0;
    let awayGoalsFor = 0, awayGoalsAgainst = 0, awayWins = 0, awayDraws = 0;
    let homeCleanSheets = 0, awayCleanSheets = 0;

    homeMatches.forEach(m => {
      const isHome = m.home_team === homeTeam;
      const scored = isHome ? (m.home_score || 0) : (m.away_score || 0);
      const conceded = isHome ? (m.away_score || 0) : (m.home_score || 0);
      
      homeGoalsFor += scored;
      homeGoalsAgainst += conceded;
      if (scored > conceded) homeWins++;
      if (scored === conceded) homeDraws++;
      if (conceded === 0) homeCleanSheets++;
    });

    awayMatches.forEach(m => {
      const isHome = m.home_team === awayTeam;
      const scored = isHome ? (m.home_score || 0) : (m.away_score || 0);
      const conceded = isHome ? (m.away_score || 0) : (m.home_score || 0);
      
      awayGoalsFor += scored;
      awayGoalsAgainst += conceded;
      if (scored > conceded) awayWins++;
      if (scored === conceded) awayDraws++;
      if (conceded === 0) awayCleanSheets++;
    });

    // NEW: H2H Analysis
    let h2h_home_wins = 0, h2h_draws = 0, h2h_away_wins = 0;
    let h2h_total_goals = 0;
    
    h2hMatches.forEach(m => {
      const homeIsHome = m.home_team === homeTeam;
      const homeScore = homeIsHome ? (m.home_score || 0) : (m.away_score || 0);
      const awayScore = homeIsHome ? (m.away_score || 0) : (m.home_score || 0);
      
      h2h_total_goals += homeScore + awayScore;
      if (homeScore > awayScore) h2h_home_wins++;
      else if (homeScore === awayScore) h2h_draws++;
      else h2h_away_wins++;
    });

    const h2h_stats = {
      total_meetings: h2hMatches.length,
      home_wins: h2h_home_wins,
      draws: h2h_draws,
      away_wins: h2h_away_wins,
      avg_goals: h2hMatches.length > 0 ? (h2h_total_goals / h2hMatches.length).toFixed(2) : 0
    };

    // Enhanced xG calculation (using H2H data)
    const homeAvgFor = homeMatches.length > 0 ? homeGoalsFor / homeMatches.length : 1.2;
    const homeAvgAgainst = homeMatches.length > 0 ? homeGoalsAgainst / homeMatches.length : 1.2;
    const awayAvgFor = awayMatches.length > 0 ? awayGoalsFor / awayMatches.length : 1.0;
    const awayAvgAgainst = awayMatches.length > 0 ? awayGoalsAgainst / awayMatches.length : 1.0;

    // Add H2H weight to xG
    const h2h_weight = h2hMatches.length > 0 ? 0.3 : 0;
    const h2h_avg_goals = parseFloat(h2h_stats.avg_goals);
    
    const xG_home = Number((
      homeAvgFor * 1.3 + 
      awayAvgAgainst * 0.7 + 
      (h2h_avg_goals * h2h_weight) +
      0.2
    ).toFixed(2));
    
    const xG_away = Number((
      awayAvgFor * 0.9 + 
      homeAvgAgainst * 0.6 + 
      (h2h_avg_goals * h2h_weight * 0.8)
    ).toFixed(2));
    
    const xG_total = Number((xG_home + xG_away).toFixed(2));

    // Winner probabilities (with H2H boost)
    const homeFormScore = (homeWins * 3 + homeDraws * 1) / Math.max(homeMatches.length, 1);
    const awayFormScore = (awayWins * 3 + awayDraws * 1) / Math.max(awayMatches.length, 1);
    
    let homeStrength = xG_home * 2 + homeFormScore * 1.5;
    let awayStrength = xG_away * 2 + awayFormScore * 1.2;
    
    // H2H boost
    if (h2hMatches.length >= 3) {
      homeStrength += h2h_home_wins * 0.5;
      awayStrength += h2h_away_wins * 0.5;
    }
    
    const totalStrength = homeStrength + awayStrength;

    let homeProb = Math.round((homeStrength / totalStrength) * 100);
    let awayProb = Math.round((awayStrength / totalStrength) * 100);
    let drawProb = Math.max(100 - homeProb - awayProb, 15);

    const sum = homeProb + drawProb + awayProb;
    homeProb = Math.round((homeProb / sum) * 100);
    drawProb = Math.round((drawProb / sum) * 100);
    awayProb = 100 - homeProb - drawProb;

    // NEW: CORRECT SCORE PREDICTIONS (Top 2 most likely)
    const possibleScores = [];
    for (let h = 0; h <= 4; h++) {
      for (let a = 0; a <= 4; a++) {
        const homeGoalProb = Math.exp(-xG_home) * Math.pow(xG_home, h) / factorial(h);
        const awayGoalProb = Math.exp(-xG_away) * Math.pow(xG_away, a) / factorial(a);
        const scoreProb = homeGoalProb * awayGoalProb;
        possibleScores.push({ 
          score: `${h}-${a}`, 
          probability: Math.round(scoreProb * 100 * 10) / 10 
        });
      }
    }
    
    possibleScores.sort((a, b) => b.probability - a.probability);
    const correct_scores = possibleScores.slice(0, 2);

    // BTTS probability (deterministic)
    const btts_home_rate = homeMatches.length > 0 ? 
      homeMatches.filter(m => {
        const conceded = m.home_team === homeTeam ? m.away_score : m.home_score;
        return (conceded || 0) > 0;
      }).length / homeMatches.length : 0.5;
    
    const btts_away_rate = awayMatches.length > 0 ? 
      awayMatches.filter(m => {
        const scored = m.home_team === awayTeam ? m.home_score : m.away_score;
        return (scored || 0) > 0;
      }).length / awayMatches.length : 0.5;

    const bttsProb = Math.min(95, Math.round(
      (btts_home_rate * btts_away_rate) * 100 + (xG_total > 2.5 ? 15 : 0)
    ));

    // Over/Under markets (FIXED: No randomness)
    const overUnder = {};
    [0.5, 1.5, 2.5, 3.5, 4.5, 5.5].forEach(line => {
      const lambda = xG_total;
      let overProb = 0;
      
      // Poisson distribution for goals
      for (let k = Math.floor(line) + 1; k <= 10; k++) {
        overProb += (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
      }
      
      overUnder[line.toFixed(1)] = Math.min(98, Math.max(5, Math.round(overProb * 100)));
    });

    // NEW: TOP GOAL MINUTES (Most likely scoring periods)
    const top_goal_minutes = [
      { period: "0-15 min", probability: Math.round(xG_total * 8 + 12) },
      { period: "16-30 min", probability: Math.round(xG_total * 9 + 10) },
      { period: "31-45 min", probability: Math.round(xG_total * 10 + 15) },
      { period: "46-60 min", probability: Math.round(xG_total * 9 + 8) },
      { period: "61-75 min", probability: Math.round(xG_total * 10 + 12) },
      { period: "76-90 min", probability: Math.round(xG_total * 12 + 20) }
    ].sort((a, b) => b.probability - a.probability);

    // Last 10 minutes probability
    const last10Prob = Math.min(92, Math.max(8, top_goal_minutes[0].probability));

    // NEW: SUGGESTED ODDS (Fair betting odds)
    const suggested_odds = {
      home_win: homeProb > 0 ? (100 / homeProb).toFixed(2) : "N/A",
      draw: drawProb > 0 ? (100 / drawProb).toFixed(2) : "N/A",
      away_win: awayProb > 0 ? (100 / awayProb).toFixed(2) : "N/A",
      btts_yes: bttsProb > 0 ? (100 / bttsProb).toFixed(2) : "N/A",
      over_2_5: overUnder['2.5'] > 0 ? (100 / overUnder['2.5']).toFixed(2) : "N/A"
    };

    // Strong markets (≥85% confidence)
    const strongMarkets = [];
    if (homeProb >= 85) strongMarkets.push({ market: "Home Win", prob: homeProb });
    if (drawProb >= 85) strongMarkets.push({ market: "Draw", prob: drawProb });
    if (awayProb >= 85) strongMarkets.push({ market: "Away Win", prob: awayProb });
    if (bttsProb >= 85) strongMarkets.push({ market: "BTTS Yes", prob: bttsProb });
    
    Object.entries(overUnder).forEach(([line, prob]) => {
      if (prob >= 85) strongMarkets.push({ market: `Over ${line}`, prob });
      if ((100 - prob) >= 85) strongMarkets.push({ market: `Under ${line}`, prob: 100 - prob });
    });

    // NEW: RISK NOTES (Warnings for bettors)
    const risk_notes = [];
    if (homeMatches.length < 5 || awayMatches.length < 5) {
      risk_notes.push("⚠️ Limited historical data - lower confidence");
    }
    if (h2hMatches.length === 0) {
      risk_notes.push("⚠️ No head-to-head history available");
    }
    if (xG_total < 1.5) {
      risk_notes.push("⚠️ Low-scoring match expected - unpredictable");
    }
    if (Math.abs(homeProb - awayProb) < 10) {
      risk_notes.push("⚠️ Very close match - high risk");
    }

    // Confidence score (90%+ requires good data)
    let confidenceScore = Math.min(100, Math.round(
      (homeMatches.length + awayMatches.length) / 20 * 100
    ));
    
    if (h2hMatches.length >= 3) confidenceScore = Math.min(100, confidenceScore + 10);

    return {
      match_id: match.match_id,
      league: match.league_name,
      home_team: homeTeam,
      away_team: awayTeam,
      match_date: match.match_date,
      match_time_pkt: match.match_time_pkt,
      winner_prob: { home: homeProb, draw: drawProb, away: awayProb },
      correct_scores,
      btts_prob: bttsProb,
      over_under: overUnder,
      last10_prob: last10Prob,
      top_goal_minutes: top_goal_minutes.slice(0, 3),
      xG: { home: xG_home, away: xG_away, total: xG_total },
      h2h_stats,
      suggested_odds,
      strong_markets: strongMarkets,
      risk_notes,
      confidence_score: confidenceScore,
      updated_at: new Date()
    };

  } catch (error) {
    console.log(`❌ Prediction Error for ${match.home_team}: ${error.message}`);
    return null;
  }
}

// Helper: Factorial function
function factorial(n) {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

// ===================== UPDATE PREDICTIONS =====================
async function updatePredictions() {
  console.log("\n🔄 ============ UPDATING PREDICTIONS ============");
  
  try {
    const matches = await Match.find({ 
      status: { $in: ["NS", "1H", "HT", "2H", "ET", "P", "LIVE"] }
    }).sort({ match_date: 1 }).limit(100);

    console.log(`📊 Processing ${matches.length} matches...`);
    let updated = 0;

    for (const match of matches) {
      const prediction = await generatePrediction(match);
      if (prediction) {
        await Prediction.findOneAndUpdate(
          { match_id: prediction.match_id },
          prediction,
          { upsert: true, new: true }
        );
        updated++;
      }
    }

    // Keep only last 100 predictions
    const totalPredictions = await Prediction.countDocuments();
    if (totalPredictions > 100) {
      const toDelete = totalPredictions - 100;
      const oldPredictions = await Prediction.find()
        .sort({ updated_at: 1 })
        .limit(toDelete)
        .select('_id');
      
      await Prediction.deleteMany({ 
        _id: { $in: oldPredictions.map(p => p._id) } 
      });
      console.log(`🗑️ Deleted ${toDelete} old predictions`);
    }

    console.log(`✅ ${updated} predictions updated`);
    console.log("============ PREDICTIONS COMPLETE ============\n");
    
  } catch (error) {
    console.log(`❌ updatePredictions Error: ${error.message}`);
  }
}

// ===================== CRON JOBS =====================
cron.schedule("*/15 * * * *", fetchLiveMatches);
cron.schedule("*/5 * * * *", updatePredictions);

setTimeout(() => {
  fetchLiveMatches();
  setTimeout(updatePredictions, 20000);
}, 5000);

// ===================== API ROUTES =====================
app.get("/events", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const sendData = async () => {
    try {
      const predictions = await Prediction.find().sort({ updated_at: -1 }).limit(100);
      const matches = await Match.find().sort({ match_date: 1 }).limit(100);
      res.write(`data: ${JSON.stringify({ predictions, matches })}\n\n`);
    } catch (error) {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    }
  };

  await sendData();
  const interval = setInterval(sendData, 5 * 60 * 1000);
  req.on("close", () => clearInterval(interval));
});

app.get("/api/predictions", async (req, res) => {
  try {
    const predictions = await Prediction.find().sort({ updated_at: -1 }).limit(100);
    res.json({ success: true, count: predictions.length, data: predictions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/matches", async (req, res) => {
  try {
    const matches = await Match.find().sort({ match_date: 1 }).limit(100);
    res.json({ success: true, count: matches.length, data: matches });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/fetch-now", async (req, res) => {
  try {
    await fetchLiveMatches();
    res.json({ success: true, message: "Fetch triggered" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║   ⚽ ENHANCED PREDICTION SYSTEM LIVE ⚽     ║
║                                            ║
║   🚀 Server: http://localhost:${PORT}     ║
║   🎯 NEW: Correct Scores                   ║
║   🎯 NEW: Top Goal Minutes                 ║
║   🎯 NEW: H2H Analysis                     ║
║   🎯 NEW: Odds Suggestions                 ║
║   🎯 NEW: Risk Warnings                    ║
║   ✅ Deterministic Calculations            ║
╚════════════════════════════════════════════╝
  `);
});
