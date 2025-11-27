import express from "express";
import axios from "axios";
import moment from "moment-timezone";
import cors from "cors";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_FOOTBALL;

// Top 10 leagues (filter)
const TOP_LEAGUES = [
  39, 40,     // EPL
  140, 135,   // La Liga / Serie A
  78, 61,     // Bundesliga / Ligue 1
  2, 3,       // Champions League / Europa
  203, 848    // World Cup Qualifiers
];

// === === MAIN API CALL FUNCTION (403 FIXED) === ===
async function callAPI(endpoint, params = {}) {
  try {
    const res = await axios.get(endpoint, {
      headers: {
        "x-apisports-key": API_KEY,
        "Accept-Encoding": "gzip,deflate,compress",
      },
      params,
    });
    return res.data;
  } catch (e) {
    console.log("API ERROR:", e.response?.data || e.message);
    return null;
  }
}

// === === Today Matches (Left Panel) === ===
app.get("/today", async (req, res) => {
  const today = moment().tz("Asia/Karachi").format("YYYY-MM-DD");

  const data = await callAPI("https://v3.football.api-sports.io/fixtures", {
    date: today,
  });

  if (!data || !data.response) {
    return res.json({ success: false, error: "API Error" });
  }

  const matches = data.response
    .filter(x => TOP_LEAGUES.includes(x.league.id))
    .map(m => ({
      home: m.teams.home.name,
      away: m.teams.away.name,
      league: m.league.name,
      kickoff: moment(m.fixture.date).tz("Asia/Karachi").format("HH:mm"),
      status: m.fixture.status.short,
    }));

  res.json({ success: true, data: matches });
});


// === === Simple Prediction Engine (Live only) === ===
function predictMatch(m) {
  const homeG = m.goals.home ?? 0;
  const awayG = m.goals.away ?? 0;

  // Example ML/AI logic (simple prototype)
  const total = homeG + awayG;

  const winnerProb = {
    home: homeG > awayG ? 85 : 30,
    draw: homeG === awayG ? 88 : 20,
    away: awayG > homeG ? 85 : 25,
  };

  const bttsProb = total >= 2 ? 85 : 30; // basic logic

  return {
    winnerProb,
    bttsProb,
    last10Prob: 50 + total * 10,
    expectedGoals: {
      home: homeG + 0.3,
      away: awayG + 0.3,
      total: total + 0.6,
    },
    strongMarkets: [
      { market: "Over 0.5", prob: 92 },
      { market: "BTTS", prob: bttsProb }
    ],
  };
}

// === === LIVE PREDICTION STREAM (Right Panel) === ===
app.get("/events", async (req, res) => {
  console.log("Client connected to SSE");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ welcome: true, msg: "AUTO PREDICTION ACTIVE" })}\n\n`);

  const sendData = async () => {
    const live = await callAPI("https://v3.football.api-sports.io/fixtures", {
      live: "all",
    });

    if (!live || !live.response) return;

    const matches = live.response
      .filter(x => TOP_LEAGUES.includes(x.league.id))
      .map(x => ({
        teams: `${x.teams.home.name} vs ${x.teams.away.name}`,
        matchDate: moment(x.fixture.date).tz("Asia/Karachi").format("HH:mm"),
        prediction: predictMatch(x),
      }));

    res.write(`data: ${JSON.stringify({ ts: Date.now(), matches })}\n\n`);
  };

  // First load
  await sendData();

  // Auto repeat every 5 minutes
  const interval = setInterval(sendData, 5 * 60 * 1000);

  req.on("close", () => {
    clearInterval(interval);
    console.log("SSE Closed");
  });
});

app.listen(PORT, () => {
  console.log("SERVER RUNNING on PORT", PORT);
});
