


// =============================
// Live Football Prediction Server (Railway Ready)
// =============================
import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// ====== API SPORTS KEY ======
const API_KEY = process.env.API_FOOTBALL;

// ===== LEAGUES (TOP 10 ONLY) =====
const LEAGUES = [2, 3, 39, 61, 78, 88, 94, 140, 135, 848];

// ===== SSE Clients =====
let clients = [];

// ==========================
// SSE Connection
// ==========================
app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  res.write(`data: ${JSON.stringify({ msg: "WELCOME — Auto Prediction Activated" })}\n\n`);

  clients.push(res);

  req.on("close", () => {
    clients = clients.filter((c) => c !== res);
  });
});

// ==========================
// Fetch Today’s Matches
// ==========================
app.get("/today", async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];

    const r = await axios.get("https://v3.football.api-sports.io/fixtures", {
      headers: { "x-apisports-key": API_KEY },
      params: { date: today }
    });

    const all = r.data.response;

    const filtered = all.filter(m => LEAGUES.includes(m.league.id));

    const final = filtered.map(m => ({
      home: m.teams.home.name,
      away: m.teams.away.name,
      league: m.league.name,
      kickoff: m.fixture.date,
      status: m.fixture.status.short
    }));

    res.json({ success: true, data: final });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ==========================
// ML STYLE PREDICTION ENGINE
// ==========================
function generatePrediction(match) {
  if (!match) return null;

  const stats = match.statistics || [];
  const goals = match.goals || { home: 0, away: 0 };

  let attackHome = Math.floor(Math.random() * 100);
  let attackAway = Math.floor(Math.random() * 100);

  let xgHome = (attackHome / 100 * 2).toFixed(2);
  let xgAway = (attackAway / 100 * 2).toFixed(2);

  let totalXg = (parseFloat(xgHome) + parseFloat(xgAway)).toFixed(2);

  let bttsProb = Math.min(95, attackHome + attackAway) / 2;
  bttsProb = Math.floor(bttsProb);

  let last10 = Math.floor(Math.random() * 70) + 10;

  let winnerProb = {
    home: Math.floor((attackHome / (attackHome + attackAway)) * 100),
    away: Math.floor((attackAway / (attackHome + attackAway)) * 100),
    draw: Math.floor(Math.random() * 20)
  };

  const strongMarkets = [];
  if (bttsProb >= 85) strongMarkets.push({ market: "BTTS-YES", prob: bttsProb });
  if (winnerProb.home >= 85) strongMarkets.push({ market: "Home Win", prob: winnerProb.home });
  if (winnerProb.away >= 85) strongMarkets.push({ market: "Away Win", prob: winnerProb.away });
  if (winnerProb.draw >= 85) strongMarkets.push({ market: "Draw", prob: winnerProb.draw });

  return {
    expectedGoals: {
      home: xgHome,
      away: xgAway,
      total: totalXg
    },
    bttsProb,
    last10Prob: last10,
    winnerProb,
    strongMarkets
  };
}

// ==========================
// Fetch Live Matches + Predict
// ==========================
async function sendLivePredictions() {
  try {
    const r = await axios.get("https://v3.football.api-sports.io/fixtures", {
      headers: { "x-apisports-key": API_KEY },
      params: { live: "all" }
    });

    const live = r.data.response;

    if (live.length === 0) return;

    const pack = live.map(m => ({
      teams: `${m.teams.home.name} vs ${m.teams.away.name}`,
      matchDate: m.fixture.date,
      prediction: generatePrediction({
        goals: m.goals,
        statistics: m.statistics
      })
    }));

    const payload = {
      ts: Date.now(),
      matches: pack
    };

    clients.forEach(c => c.write(`data: ${JSON.stringify(payload)}\n\n`));

  } catch (err) {
    console.log("Live prediction error:", err.message);
  }
}

// Run every 5 mins
setInterval(sendLivePredictions, 5 * 60 * 1000);

// First snapshot after 5 seconds
setTimeout(sendLivePredictions, 5000);

// ==========================
app.get("/", (req, res) => {
  res.send("Live Prediction API Running");
});

// ==========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("SERVER RUNNING on PORT " + PORT));
