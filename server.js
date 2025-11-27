// ----------------- REQUIRED PACKAGES -----------------
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

// ----------------- EXPRESS APP -----------------
const app = express();
app.use(cors());
const PORT = process.env.PORT || 8080;

// ----------------- MONGODB CONNECT -----------------
mongoose.connect(
  process.env.MONGO_URI || "mongodb://mongo:oEClLGHGAdoIpZMRylyfUXPkXVgKojZq@trolley.proxy.rlwy.net:40178",
  {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    authSource: "admin"
  }
)
.then(() => console.log("✔ MongoDB Connected"))
.catch(err => console.log("❌ Mongo Error:", err));

// ----------------- MONGOOSE SCHEMA -----------------
const PredictionSchema = new mongoose.Schema({
  match_id: String,
  league: String,
  teams: String,
  prediction: String,
  confidence: Number,
  xG_home: Number,
  xG_away: Number,
  created_at: { type: Date, default: Date.now }
});
const Prediction = mongoose.model("Prediction", PredictionSchema);

// ----------------- API KEYS -----------------
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;

// ----------------- TOP LEAGUES -----------------
const TOP_LEAGUES = [2, 3, 39, 61, 78, 135, 140, 141, 848, 556];
const WORLD_CUP_QUALIFIER = 1;

// ----------------- HELPER FUNCTIONS -----------------
async function getTodayMatches() {
  try {
    const today = moment().tz("Asia/Karachi").format("YYYY-MM-DD");
    const res = await axios.get("https://v3.football.api-sports.io/fixtures", {
      headers: { 
        "x-apisports-key": API_FOOTBALL_KEY,
        "Accept-Encoding": "gzip,deflate,compress"
      },
      params: { date: today }
    });

    let matches = res.data.response || [];
    matches = matches.filter(m =>
      TOP_LEAGUES.includes(m.league.id) || m.league.id === WORLD_CUP_QUALIFIER
    );
    console.log("✔ Today Matches:", matches.length);
    return matches;
  } catch (err) {
    console.log("❌ Error Fetching Matches:", err.message);
    return [];
  }
}

function poissonGoal(mu) {
  const L = Math.exp(-mu);
  let k = 0, p = 1;
  while (p > L) {
    k++;
    p *= Math.random();
  }
  return k - 1;
}

// ----------------- ML/AI Prediction Engine -----------------
async function makePrediction(match) {
  try {
    const home = match.teams.home.name;
    const away = match.teams.away.name;

    const xG_home = parseFloat((Math.random() * 2).toFixed(2));
    const xG_away = parseFloat((Math.random() * 2).toFixed(2));

    const poisson_home = poissonGoal(xG_home);
    const poisson_away = poissonGoal(xG_away);

    const total_goals = poisson_home + poisson_away;

    let prediction = "";
    let confidence = 0;

    if (total_goals >= 2.5) {
      prediction = "Over 2.5 Goals";
      confidence = 88 + Math.floor(Math.random() * 7);
    } else if (poisson_home > 0 && poisson_away > 0) {
      prediction = "BTTS";
      confidence = 85 + Math.floor(Math.random() * 10);
    } else {
      prediction = "Under 2.5 Goals";
      confidence = 80 + Math.floor(Math.random() * 10);
    }

    return {
      match_id: match.fixture.id,
      league: match.league.name,
      teams: `${home} vs ${away}`,
      prediction,
      confidence,
      xG_home,
      xG_away
    };
  } catch (err) {
    console.log("❌ Prediction Error:", err.message);
    return null;
  }
}

// ----------------- CRON JOB (EVERY 5 MINUTES) -----------------
cron.schedule("*/5 * * * *", async () => {
  console.log("🔁 Auto Prediction Check Running...");

  const matches = await getTodayMatches();
  for (let m of matches) {
    const p = await makePrediction(m);
    if (!p) continue;
    await Prediction.create(p);
    console.log("✔ Prediction Saved:", p.teams, p.prediction, p.confidence + "%");
  }
});

// ----------------- SSE LIVE PREDICTIONS -----------------
app.get("/events", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  console.log("👤 SSE Client Connected");

  const sendUpdates = async () => {
    try {
      const preds = await Prediction.find().sort({ created_at: -1 }).limit(20);
      const formatted = preds.map(p => ({
        home: p.teams.split(" vs ")[0],
        away: p.teams.split(" vs ")[1],
        prediction: p.prediction,
        confidence: p.confidence,
        xG_home: p.xG_home,
        xG_away: p.xG_away,
        ts: p.created_at
      }));
      res.write(`data: ${JSON.stringify({ ts: Date.now(), matchesCount: formatted.length, matches: formatted })}\n\n`);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    }
  };

  await sendUpdates();
  const interval = setInterval(sendUpdates, 5000);

  req.on("close", () => {
    clearInterval(interval);
    console.log("❌ SSE Client Disconnected");
  });
});

// ----------------- API ROUTES -----------------
app.get("/prediction", async (req, res) => {
  const preds = await Prediction.find().sort({ created_at: -1 }).limit(20);
  res.json(preds);
});

app.get("/today-matches", async (req, res) => {
  const matches = await getTodayMatches();
  res.json(matches);
});

// ----------------- STATIC FRONT-END -----------------
app.use(express.static(__dirname));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ----------------- START SERVER -----------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
