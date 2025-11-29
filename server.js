// server.js - Professional Football Prediction System
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
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_PUBLIC_URL || process.env.MONGO_URL || process.env.DATABASE_URL;

if (!MONGO_URI) {
  console.error("❌ CRITICAL ERROR: MongoDB URI not found!");
  process.exit(1);
}

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected Successfully!"))
  .catch(err => {
    console.error("❌ MongoDB Connection Failed!", err.message);
    process.exit(1);
  });

mongoose.connection.on('disconnected', () => console.warn('⚠️ MongoDB Disconnected. Reconnecting...'));
mongoose.connection.on('error', err => console.error('❌ MongoDB Error:', err.message));

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
// Remove duplicate index warning by not declaring another index for match_id
MatchSchema.index({ match_date: -1 });
MatchSchema.index({ status: 1 });

const PredictionSchema = new mongoose.Schema({
  match_id: { type: String, required: true, unique: true },
  league: String,
  home_team: String,
  away_team: String,
  match_date: Date,
  match_time_pkt: String,
  winner_prob: { home: Number, draw: Number, away: Number },
  btts_prob: Number,
  over_under: Object,
  last10_prob: Number,
  xG: { home: Number, away: Number, total: Number },
  strong_markets: Array,
  confidence_score: Number,
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});
PredictionSchema.index({ updated_at: -1 });
PredictionSchema.index({ match_id: 1 });

const Match = mongoose.model("Match", MatchSchema);
const Prediction = mongoose.model("Prediction", PredictionSchema);

// ===================== API CONFIG =====================
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || "fdab0eef5743173c30f9810bef3a6742";
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY || "62207494b8a241db93aee4c14b7c1266";
const TARGET_LEAGUES = [39, 140, 135, 78, 61, 94, 88, 203, 2, 3, 32, 34, 33];

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
    let matches = [];

    // API-Football
    try {
      const response = await axios.get(`https://v3.football.api-sports.io/fixtures`, {
        headers: { "x-apisports-key": API_FOOTBALL_KEY },
        params: { date: todayPKT },
        timeout: 15000
      });
      if (response.data?.response?.length) matches = response.data.response;
    } catch (err) { console.warn("❌ API-Football Error:", err.message); }

    // Football-Data fallback
    if (!matches.length) {
      try {
        const fbResp = await axios.get(`https://api.football-data.org/v4/matches`, {
          headers: { "X-Auth-Token": FOOTBALL_DATA_KEY },
          params: { date: todayPKT },
          timeout: 15000
        });
        if (fbResp.data?.matches) {
          matches = fbResp.data.matches.map(m => ({
            fixture: { id: m.id, date: m.utcDate, venue: { name: m.venue || "Unknown" }, status: { short: m.status === "FINISHED" ? "FT" : m.status === "IN_PLAY" ? "LIVE" : m.status === "PAUSED" ? "HT" : "NS" } },
            league: { id: m.competition?.id || 0, name: m.competition?.name || "Unknown" },
            teams: { home: { id: m.homeTeam?.id || 0, name: m.homeTeam?.name || "Unknown", logo: m.homeTeam?.crest || "" }, away: { id: m.awayTeam?.id || 0, name: m.awayTeam?.name || "Unknown", logo: m.awayTeam?.crest || "" } },
            goals: { home: m.score?.fullTime?.home ?? 0, away: m.score?.fullTime?.away ?? 0 }
          }));
        }
      } catch (err) { console.warn("❌ Football-Data Error:", err.message); }
    }

    if (!matches.length) return console.log("❌ No matches found from any source!");

    const filteredMatches = TARGET_LEAGUES.length ? matches.filter(m => TARGET_LEAGUES.includes(m.league?.id)) : matches;
    let savedCount = 0;
    for (const match of filteredMatches) {
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
        await Match.findOneAndUpdate({ match_id: matchData.match_id }, matchData, { upsert: true, new: true });
        savedCount++;
      } catch (err) { console.warn("⚠️ Save error:", err.message); }
    }
    console.log(`✅ Successfully saved ${savedCount} matches to MongoDB`);
  } catch (error) { console.error("❌ CRITICAL ERROR:", error.message); }
}

// ===================== CRON JOBS =====================
cron.schedule("*/15 * * * *", fetchLiveMatches);
cron.schedule("*/5 * * * *", updatePredictions);

setTimeout(() => {
  fetchLiveMatches();
  setTimeout(updatePredictions, 20000);
}, 5000);

// ===================== START SERVER =====================
app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.listen(PORT, () => {
  console.log(`⚽ FOOTBALL PREDICTION SYSTEM LIVE at http://localhost:${PORT}`);
});
