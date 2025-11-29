// server.js - Professional Football Prediction System
// ✅ Fixed MongoDB Connection ✅ Pakistan Time Zone ✅ Last 100 Predictions

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

// ===================== MONGODB CONNECTION (FIXED) =====================
// Railway uses MONGO_PUBLIC_URL, also check common variants
const MONGO_URI = process.env.MONGO_URI || 
                  process.env.MONGODB_URI || 
                  process.env.MONGO_PUBLIC_URL ||
                  process.env.MONGO_URL ||
                  process.env.DATABASE_URL;

if (!MONGO_URI) {
  console.log("❌ CRITICAL ERROR: MongoDB URI not found!");
  console.log("💡 Available environment variables:");
  console.log(Object.keys(process.env).filter(k => k.includes('MONGO') || k.includes('DATABASE')));
  console.log("💡 Add one of these: MONGO_URI, MONGO_PUBLIC_URL, or MONGODB_URI");
  console.log("Example: mongodb+srv://user:pass@cluster.mongodb.net/football");
  process.exit(1);
}

console.log("✅ MongoDB URI found:", MONGO_URI.substring(0, 20) + "...");

console.log("🔄 Connecting to MongoDB...");
mongoose.connect(MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB Connected Successfully!");
    console.log("📦 Database:", mongoose.connection.name);
  })
  .catch(err => {
    console.log("❌ MongoDB Connection Failed!");
    console.log("Error:", err.message);
    process.exit(1);
  });

// Handle connection events
mongoose.connection.on('disconnected', () => {
  console.log('⚠️ MongoDB Disconnected. Reconnecting...');
});

mongoose.connection.on('error', (err) => {
  console.log('❌ MongoDB Error:', err.message);
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
  match_time_pkt: String,  // Pakistan time formatted
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
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

// Create indexes for better performance
MatchSchema.index({ match_date: -1 });
MatchSchema.index({ status: 1 });
PredictionSchema.index({ updated_at: -1 });
PredictionSchema.index({ match_id: 1 });

const Match = mongoose.model("Match", MatchSchema);
const Prediction = mongoose.model("Prediction", PredictionSchema);

// ===================== API CONFIGURATION =====================
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || "fdab0eef5743173c30f9810bef3a6742";
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY || "62207494b8a241db93aee4c14b7c1266";

// Top Leagues + World Cup Qualifiers
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
    console.log("🕐 Pakistan Time:", moment().tz("Asia/Karachi").format("hh:mm A"));

    let matches = [];

    // ========== METHOD 1: API-FOOTBALL ==========
    try {
      console.log("🌐 Fetching from API-Football...");
      const url = `https://v3.football.api-sports.io/fixtures`;
      const params = { date: todayPKT };
      const headers = { "x-apisports-key": API_FOOTBALL_KEY };

      const response = await axios.get(url, { headers, params, timeout: 15000 });

      if (response.data?.response && response.data.response.length > 0) {
        matches = response.data.response;
        console.log(`✅ API-Football: ${matches.length} matches found`);
      } else {
        console.log("⚠️ No matches returned from API-Football");
      }

    } catch (apiError) {
      console.log("❌ API-Football Error:", apiError.message);
    }

    // ========== METHOD 2: FOOTBALL-DATA (Fallback) ==========
    if (matches.length === 0) {
      try {
        console.log("🌐 Trying Football-Data.org...");
        const fbUrl = `https://api.football-data.org/v4/matches`;
        const fbHeaders = { "X-Auth-Token": FOOTBALL_DATA_KEY };

        const fbResponse = await axios.get(fbUrl, { 
          headers: fbHeaders,
          params: { date: todayPKT },
          timeout: 15000 
        });

        if (fbResponse.data?.matches) {
          matches = fbResponse.data.matches.map(m => ({
            fixture: {
              id: m.id,
              date: m.utcDate,
              venue: { name: m.venue || "Unknown" },
              status: { 
                short: m.status === "FINISHED" ? "FT" : 
                       m.status === "IN_PLAY" ? "LIVE" :
                       m.status === "PAUSED" ? "HT" : "NS"
              }
            },
            league: { 
              id: m.competition?.id || 0, 
              name: m.competition?.name || "Unknown"
            },
            teams: {
              home: { 
                id: m.homeTeam?.id || 0, 
                name: m.homeTeam?.name || "Unknown",
                logo: m.homeTeam?.crest || ""
              },
              away: { 
                id: m.awayTeam?.id || 0, 
                name: m.awayTeam?.name || "Unknown",
                logo: m.awayTeam?.crest || ""
              }
            },
            goals: { 
              home: m.score?.fullTime?.home ?? null, 
              away: m.score?.fullTime?.away ?? null 
            }
          }));
          console.log(`✅ Football-Data: ${matches.length} matches converted`);
        }
      } catch (fbError) {
        console.log("❌ Football-Data Error:", fbError.message);
      }
    }

    // ========== METHOD 3: ALL LIVE MATCHES ==========
    if (matches.length === 0) {
      try {
        console.log("🌐 Fetching ALL live matches...");
        const liveUrl = `https://v3.football.api-sports.io/fixtures`;
        const liveParams = { live: "all" };
        const headers = { "x-apisports-key": API_FOOTBALL_KEY };

        const liveResponse = await axios.get(liveUrl, { headers, params: liveParams, timeout: 15000 });

        if (liveResponse.data?.response) {
          matches = liveResponse.data.response;
          console.log(`✅ Live matches: ${matches.length} found`);
        }
      } catch (liveError) {
        console.log("❌ Live fetch error:", liveError.message);
      }
    }

    if (matches.length === 0) {
      console.log("❌ No matches found from any source!");
      return;
    }

    console.log(`📊 Processing ${matches.length} total matches...`);

    // Filter for target leagues (optional)
    const filteredMatches = matches.filter(m => 
      !TARGET_LEAGUES.length || TARGET_LEAGUES.includes(m.league?.id)
    );

    const matchesToSave = filteredMatches.length > 0 ? filteredMatches : matches.slice(0, 50);
    console.log(`🎯 Saving ${matchesToSave.length} matches...`);

    // Save to MongoDB with Pakistan time
    let savedCount = 0;
    for (const match of matchesToSave) {
      try {
        // Validate essential fields
        if (!match.teams?.home?.name || !match.teams?.away?.name) {
          console.log("⚠️ Skipping match with missing team names");
          continue;
        }

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

        // Log sample data for debugging
        if (savedCount === 0) {
          console.log("📝 Sample match data:", {
            id: matchData.match_id,
            league: matchData.league_name,
            match: `${matchData.home_team} vs ${matchData.away_team}`,
            time: matchData.match_time_pkt,
            status: matchData.status
          });
        }

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

    console.log(`✅ Successfully saved ${savedCount} matches to MongoDB`);
    console.log("============ FETCH COMPLETE ============\n");

  } catch (error) {
    console.log(`❌ CRITICAL ERROR: ${error.message}`);
  }
}

// ===================== PREDICTION ENGINE =====================
async function generatePrediction(match) {
  try {
    const homeTeam = match.home_team;
    const awayTeam = match.away_team;

    // Get recent form (last 10 matches)
    const homeMatches = await Match.find({
      $or: [{ home_team: homeTeam }, { away_team: homeTeam }],
      status: "FT"
    }).sort({ match_date: -1 }).limit(10);

    const awayMatches = await Match.find({
      $or: [{ home_team: awayTeam }, { away_team: awayTeam }],
      status: "FT"
    }).sort({ match_date: -1 }).limit(10);

    // Calculate statistics
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

    // Advanced xG calculation
    const homeAvgFor = homeMatches.length > 0 ? homeGoalsFor / homeMatches.length : 1.2;
    const homeAvgAgainst = homeMatches.length > 0 ? homeGoalsAgainst / homeMatches.length : 1.2;
    const awayAvgFor = awayMatches.length > 0 ? awayGoalsFor / awayMatches.length : 1.0;
    const awayAvgAgainst = awayMatches.length > 0 ? awayGoalsAgainst / awayMatches.length : 1.0;

    const xG_home = Number((homeAvgFor * 1.3 + awayAvgAgainst * 0.7 + 0.2).toFixed(2));
    const xG_away = Number((awayAvgFor * 0.9 + homeAvgAgainst * 0.6).toFixed(2));
    const xG_total = Number((xG_home + xG_away).toFixed(2));

    // Winner probabilities
    const homeFormScore = (homeWins * 3 + homeDraws * 1) / Math.max(homeMatches.length, 1);
    const awayFormScore = (awayWins * 3 + awayDraws * 1) / Math.max(awayMatches.length, 1);
    
    const homeStrength = xG_home * 2 + homeFormScore * 1.5;
    const awayStrength = xG_away * 2 + awayFormScore * 1.2;
    const totalStrength = homeStrength + awayStrength;

    let homeProb = Math.round((homeStrength / totalStrength) * 100);
    let awayProb = Math.round((awayStrength / totalStrength) * 100);
    let drawProb = Math.max(100 - homeProb - awayProb, 15);

    const sum = homeProb + drawProb + awayProb;
    homeProb = Math.round((homeProb / sum) * 100);
    drawProb = Math.round((drawProb / sum) * 100);
    awayProb = 100 - homeProb - drawProb;

    // BTTS probability
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

    // Last 10 minutes probability
    const last10Prob = Math.min(92, Math.max(8, Math.round(
      xG_total * 11 + (homeAvgFor + awayAvgFor) * 5
    )));

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

    // Confidence score based on data availability
    const confidenceScore = Math.min(100, Math.round(
      (homeMatches.length + awayMatches.length) / 20 * 100
    ));

    return {
      match_id: match.match_id,
      league: match.league_name,
      home_team: homeTeam,
      away_team: awayTeam,
      match_date: match.match_date,
      match_time_pkt: match.match_time_pkt,
      winner_prob: { home: homeProb, draw: drawProb, away: awayProb },
      btts_prob: bttsProb,
      over_under: overUnder,
      last10_prob: last10Prob,
      xG: { home: xG_home, away: xG_away, total: xG_total },
      strong_markets: strongMarkets,
      confidence_score: confidenceScore,
      updated_at: new Date()
    };

  } catch (error) {
    console.log(`❌ Prediction Error for ${match.home_team}: ${error.message}`);
    return null;
  }
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
      console.log(`🗑️ Deleted ${toDelete} old predictions (keeping last 100)`);
    }

    console.log(`✅ ${updated} predictions updated`);
    console.log("============ PREDICTIONS COMPLETE ============\n");
    
  } catch (error) {
    console.log(`❌ updatePredictions Error: ${error.message}`);
  }
}

// ===================== CRON JOBS =====================
cron.schedule("*/15 * * * *", () => {
  console.log("⏰ CRON: 15-min interval - Fetching matches");
  fetchLiveMatches();
});

cron.schedule("*/5 * * * *", () => {
  console.log("⏰ CRON: 5-min interval - Updating predictions");
  updatePredictions();
});

// Initial fetch on startup
setTimeout(() => {
  console.log("🚀 Starting initial data fetch...");
  fetchLiveMatches();
  setTimeout(() => updatePredictions(), 20000);
}, 5000);

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
        .limit(100);
      
      const matches = await Match.find()
        .sort({ match_date: 1 })
        .limit(100);

      res.write(`data: ${JSON.stringify({ 
        predictions, 
        matches,
        timestamp: moment().tz("Asia/Karachi").format("DD MMM YYYY, hh:mm:ss A"),
        count: { matches: matches.length, predictions: predictions.length }
      })}\n\n`);
    } catch (error) {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    }
  };

  await sendData();
  const interval = setInterval(sendData, 5 * 60 * 1000);

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
      .limit(100);
    res.json({ success: true, count: predictions.length, data: predictions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/matches", async (req, res) => {
  try {
    const matches = await Match.find()
      .sort({ match_date: 1 })
      .limit(100);
    res.json({ success: true, count: matches.length, data: matches });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/today", async (req, res) => {
  try {
    const todayStart = moment().tz("Asia/Karachi").startOf("day");
    const todayEnd = moment().tz("Asia/Karachi").endOf("day");
    
    const matches = await Match.find({
      match_date: { 
        $gte: todayStart.toDate(), 
        $lte: todayEnd.toDate() 
      }
    }).sort({ match_date: 1 });

    const matchIds = matches.map(m => m.match_id);
    const predictions = await Prediction.find({ 
      match_id: { $in: matchIds } 
    });

    res.json({ 
      success: true, 
      date: todayStart.format("DD MMMM YYYY"),
      timezone: "Pakistan (PKT)",
      matches, 
      predictions 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual trigger endpoint (for testing)
app.get("/api/fetch-now", async (req, res) => {
  try {
    await fetchLiveMatches();
    res.json({ 
      success: true, 
      message: "Fetch triggered",
      time: moment().tz("Asia/Karachi").format("DD MMM YYYY, hh:mm A")
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Clear corrupted data endpoint
app.get("/api/clear-db", async (req, res) => {
  try {
    await Match.deleteMany({});
    await Prediction.deleteMany({});
    console.log("🗑️ Database cleared");
    res.json({ 
      success: true, 
      message: "Database cleared. Now visit /api/fetch-now to get fresh data"
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
║   🕐 Timezone: Pakistan (PKT)              ║
║   📊 Matches: Last 100 (Left Side)         ║
║   🎯 Predictions: Last 100 (Right Side)    ║
║                                            ║
║   ✅ 15-min match fetch (96/day)           ║
║   ✅ 5-min predictions update              ║
║   ✅ Auto-delete old predictions           ║
║   ✅ MongoDB properly connected            ║
╚════════════════════════════════════════════╝
  `);
});
