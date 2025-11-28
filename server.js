

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

// MongoDB connection (use your env MONGO_URI or default)
mongoose.connect(process.env.MONGO_URI || "mongodb://mongo:password@host:port", {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log("✔ MongoDB Connected"))
  .catch(err => console.log("❌ Mongo Error:", err));

// Prediction schema with unique match_id for duplicate-free storage
const PredictionSchema = new mongoose.Schema({
  match_id: { type: String, unique: true, index: true },
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

// API-Football Key (use your own environment variable)
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || "fdab0eef5743173c30f9810bef3a6742";

// Helper for API-Football requests (15 min limit, 1 request covers all live matches)
async function getLiveMatches() {
  try {
    const todayDate = moment().tz("Asia/Karachi").format("YYYY-MM-DD");
    const url = `https://v3.football.api-sports.io/fixtures?live=all&date=${todayDate}`;
    const res = await axios.get(url, {
      headers: { "x-apisports-key": API_FOOTBALL_KEY },
      timeout: 10000
    });
    const fixtures = res.data?.response || [];
    // Normalize to your format
    return fixtures.map(match => ({
      fixture: {
        id: String(match.fixture.id),
        date: match.fixture.date,
        status: { short: match.fixture.status.short, elapsed: match.fixture.status.elapsed || 0 }
      },
      teams: {
        home: { id: match.teams.home.id, name: match.teams.home.name },
        away: { id: match.teams.away.id, name: match.teams.away.name }
      },
      league: { id: match.league.id, name: match.league.name },
      goals: { home: match.goals.home, away: match.goals.away },
      raw: match
    }));
  } catch (err) {
    console.error("❌ getLiveMatches error:", err.message);
    return [];
  }
}

// Prediction engine: uses lightweight heuristics and last 15 matches for stats
async function makePrediction(match) {
  try {
    // Simplified: Fetch last 15 matches for home and away using API-Football (or DB fallback)
    // For brevity, here prediction uses random logic around xG and probabilities
    // You can replace with your detailed logic (like your TSDB example but adapted for API-Football)

    const home = match.teams.home.name;
    const away = match.teams.away.name;

    // Dummy stats and predictions (demo purpose)
    const xG_home = Number((Math.random() * 2).toFixed(2));
    const xG_away = Number((Math.random() * 2).toFixed(2));
    const xG_total = Number((xG_home + xG_away).toFixed(2));

    let homeProb = Math.round(50 + (xG_home - xG_away) * 20);
    let awayProb = Math.round(50 + (xG_away - xG_home) * 20);
    let drawProb = 100 - homeProb - awayProb;

    homeProb = Math.max(5, Math.min(90, homeProb));
    awayProb = Math.max(5, Math.min(90, awayProb));
    drawProb = Math.max(5, Math.min(90, drawProb));

    // Normalize probabilities to 100
    const sum = homeProb + awayProb + drawProb;
    homeProb = Math.round((homeProb / sum) * 100);
    awayProb = Math.round((awayProb / sum) * 100);
    drawProb = 100 - homeProb - awayProb;

    // BTTS probability (random demo)
    const bttsProb = Math.round(50 + Math.random() * 40);

    // Over/Under markets
    const overUnder = {};
    for (let t = 0.5; t <= 5.5; t += 0.5) {
      overUnder[t.toFixed(1)] = Math.round(20 + Math.random() * 75);
    }

    // Last 10 min probability
    const last10Prob = Math.round(10 + Math.random() * 85);

    // Strong markets
    const strongMarkets = [];
    if (homeProb >= 85) strongMarkets.push({ market: "Home Win", prob: homeProb });
    if (awayProb >= 85) strongMarkets.push({ market: "Away Win", prob: awayProb });
    if (bttsProb >= 85) strongMarkets.push({ market: "BTTS", prob: bttsProb });

    return {
      match_id: match.fixture.id,
      league: match.league.name,
      teams: `${home} vs ${away}`,
      winnerProb: { home: homeProb, draw: drawProb, away: awayProb },
      bttsProb,
      overUnder,
      last10Prob,
      xG: { home: xG_home, away: xG_away, total: xG_total },
      strongMarkets
    };
  } catch (err) {
    console.error("❌ makePrediction error:", err.message);
    return null;
  }
}

// Cron job: fetch live matches every 15 mins & save/update predictions every 5 mins
cron.schedule("*/15 * * * *", async () => {
  console.log("🔁 Fetching live matches (every 15 mins)...");
  const matches = await getLiveMatches();

  // Save or update matches in DB - this will clean old predictions automatically
  for (const match of matches) {
    let prediction = await makePrediction(match);
    if (!prediction) continue;

    try {
      // Upsert to avoid duplicates: if match_id exists, replace
      await Prediction.findOneAndUpdate(
        { match_id: prediction.match_id },
        { $set: prediction, created_at: new Date() },
        { upsert: true }
      );
      console.log("✔ Prediction Upserted:", prediction.teams);
    } catch (e) {
      console.error("❌ MongoDB upsert error:", e.message);
    }
  }
});

// Cron job: update predictions every 5 mins using DB data (simulate prediction engine)
// To respect 100 request limit, no separate API calls here
cron.schedule("*/5 * * * *", async () => {
  console.log("🔁 Prediction update every 5 mins using DB data...");
  const matches = await Prediction.find();

  for (const match of matches) {
    // simulate prediction update (could call makePrediction again or adjust data)
    // Here just updating created_at to indicate refresh for SSE
    try {
      await Prediction.updateOne({ match_id: match.match_id }, { $set: { created_at: new Date() } });
      console.log("✔ Prediction refreshed:", match.teams);
    } catch (e) {
      console.error("❌ MongoDB update error:", e.message);
    }
  }
});

// SSE endpoint for pushing last 200 predictions every 5 minutes
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
      res.write(`data: ${JSON.stringify({ ts: Date.now(), matches: formatted })}\n\n`);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    }
  };

  await sendUpdates();
  const interval = setInterval(sendUpdates, 5 * 60 * 1000);

  req.on("close", () => {
    clearInterval(interval);
    console.log("❌ SSE Client Disconnected");
  });
});

// API Routes
app.get("/prediction", async (req, res) => {
  const preds = await Prediction.find().sort({ created_at: -1 }).limit(200);
  res.json(preds);
});
app.get("/today-matches", async (req, res) => {
  const matches = await getLiveMatches();
  res.json(matches);
});

// Static frontend
app.use(express.static(__dirname));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
