

import express from "express";
import axios from "axios";
import mongoose from "mongoose";
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
const MONGO_URI = process.env.MONGO_PUBLIC_URL;
if (!MONGO_URI) { console.error("❌ MONGO_PUBLIC_URL missing"); process.exit(1); }
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✔ MongoDB Connected"))
  .catch(err => console.log("❌ Mongo Error:", err));

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

// ----------------- API-Football CONFIG -----------------
const API_FOOTBALL_KEY = process.env.API_FOOTBALL;
const API_FOOTBALL_HOST = "v3.football.api-sports.io";

// ----------------- LIVE MATCHES FETCH (1 request / 15 min) -----------------
let cachedMatches = []; // store last fetched matches
async function fetchLiveMatches() {
  try {
    const today = new Date().toISOString().split("T")[0];
    const res = await axios.get(`https://${API_FOOTBALL_HOST}/fixtures`, {
      headers: { "x-apisports-key": API_FOOTBALL_KEY },
      params: { date: today }
    });
    cachedMatches = (res.data.response || []).map(ev => ({
      fixture: {
        id: ev.fixture.id,
        date: ev.fixture.date,
        status: ev.fixture.status
      },
      teams: {
        home: { id: ev.teams.home.id, name: ev.teams.home.name },
        away: { id: ev.teams.away.id, name: ev.teams.away.name }
      },
      league: { id: ev.league.id, name: ev.league.name },
      goals: { home: ev.goals.home, away: ev.goals.away },
      raw: ev
    }));
    console.log("✔ Live matches fetched:", cachedMatches.length);
  } catch (err) {
    console.log("❌ fetchLiveMatches error:", err.message);
  }
}

// ----------------- Save matches to DB (replace old every 15 min) -----------------
async function saveMatchesToDB() {
  if (!cachedMatches.length) return;
  try {
    // optional: remove old predictions first if needed
    // await Prediction.deleteMany({});
    for (const m of cachedMatches) {
      const exists = await Prediction.findOne({ match_id: m.fixture.id });
      if (!exists) {
        await Prediction.create({
          match_id: m.fixture.id,
          league: m.league.name,
          teams: `${m.teams.home.name} vs ${m.teams.away.name}`,
          winnerProb: {},
          bttsProb: 0,
          overUnder: {},
          last10Prob: 0,
          xG: {},
          strongMarkets: []
        });
      }
    }
    console.log("✔ Matches saved to DB");
  } catch (err) {
    console.log("❌ saveMatchesToDB error:", err.message);
  }
}

// ----------------- PRO-LEVEL PREDICTION ENGINE -----------------
async function updatePredictions() {
  const matches = await Prediction.find().sort({ created_at: -1 }).limit(200);
  for (const m of matches) {
    // simple random prediction engine
    const homeProb = Math.floor(Math.random() * 50 + 25);
    const awayProb = Math.floor(Math.random() * 50 + 25);
    const drawProb = 100 - homeProb - awayProb;
    const bttsProb = Math.floor(Math.random() * 50 + 45);
    const overUnder = { "0.5": 80, "1.5": 60, "2.5": 45, "3.5": 30 };
    const last10Prob = 20;
    const xG = { home: 1.2, away: 1.0, total: 2.2 };
    const strongMarkets = [];
    if (homeProb >= 85) strongMarkets.push({ market: "Home Win", prob: homeProb });
    if (awayProb >= 85) strongMarkets.push({ market: "Away Win", prob: awayProb });
    if (bttsProb >= 85) strongMarkets.push({ market: "BTTS", prob: bttsProb });

    await Prediction.updateOne(
      { match_id: m.match_id },
      { winnerProb: { home: homeProb, draw: drawProb, away: awayProb }, bttsProb, overUnder, last10Prob, xG, strongMarkets, created_at: new Date() }
    );
  }
  console.log("✔ Predictions updated");
}

// ----------------- CRON JOBS -----------------
// 1 request every 15 min → fetch live matches
cron.schedule("*/15 * * * *", async () => {
  console.log("🔁 Fetching live matches (15 min interval)...");
  await fetchLiveMatches();
  await saveMatchesToDB();
});

// Prediction engine every 5 min (uses DB only → zero API load)
cron.schedule("*/5 * * * *", async () => {
  console.log("🔁 Updating predictions (5 min interval)...");
  await updatePredictions();
});

// ----------------- SSE endpoint -----------------
app.get("/events", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  console.log("👤 SSE Client Connected");

  const sendUpdates = async () => {
    const preds = await Prediction.find().sort({ created_at: -1 }).limit(200);
    res.write(`data: ${JSON.stringify({ ts: Date.now(), matches: preds })}\n\n`);
  };

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
app.get("/today-matches", async (req, res) => res.json(cachedMatches));

// ----------------- STATIC FRONTEND -----------------
app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ----------------- START SERVER -----------------
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
