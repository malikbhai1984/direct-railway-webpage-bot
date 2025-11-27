

// ----------------- REQUIRED PACKAGES -----------------
const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const cron = require("node-cron");
const cors = require("cors");
const path = require("path");

// ----------------- EXPRESS APP -----------------
const app = express();
app.use(cors());
const PORT = process.env.PORT || 8080;

// ----------------- MONGODB CONNECT -----------------
mongoose.connect(
    "mongodb://mongo:oEClLGHGAdoIpZMRylyfUXPkXVgKojZq@trolley.proxy.rlwy.net:40178",
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
    created_at: { type: Date, default: Date.now }
});
const Prediction = mongoose.model("Prediction", PredictionSchema);

// ----------------- API KEYS -----------------
const API_FOOTBALL_KEY = "fdab0eef5743173c30f9810bef3a6742";

// TOP LEAGUES + WORLD CUP QUALIFIER
const TOP_LEAGUES = [2, 3, 39, 61, 78, 135, 140, 141, 848, 556];
const WORLD_CUP_QUALIFIER = 1;

// ----------------------------------------------------
// 🔍 FUNCTION: Fetch Today Matches
// ----------------------------------------------------
async function getTodayMatches() {
    try {
        const today = moment().tz("Asia/Karachi").format("YYYY-MM-DD");

        const res = await axios.get("https://v3.football.api-sports.io/fixtures", {
            headers: { "x-apisports-key": API_FOOTBALL_KEY },
            params: { date: today }
        });

        let matches = res.data.response;

        matches = matches.filter(m =>
            TOP_LEAGUES.includes(m.league.id) ||
            m.league.id === WORLD_CUP_QUALIFIER
        );

        console.log("✔ Today Matches:", matches.length);

        return matches;

    } catch (err) {
        console.log("❌ Error Fetching Matches:", err.message);
        return [];
    }
}

// ----------------------------------------------------
// 🔮 FUNCTION: Prediction Engine
// ----------------------------------------------------
async function makePrediction(match) {
    try {
        const home = match.teams.home.name;
        const away = match.teams.away.name;

        const confidence = Math.floor(Math.random() * (90 - 80) + 80);

        return {
            match_id: match.fixture.id,
            league: match.league.name,
            teams: `${home} vs ${away}`,
            prediction: confidence > 85 ? "Over 2.5 Goals" : "BTTS",
            confidence
        };

    } catch (err) {
        console.log("❌ Prediction Error:", err.message);
        return null;
    }
}

// ----------------------------------------------------
// ⏳ CRON JOB (EVERY 5 MINUTES)
// ----------------------------------------------------
cron.schedule("*/5 * * * *", async () => {
    console.log("🔁 Auto Prediction Check Running...");

    const matches = await getTodayMatches();

    for (let m of matches) {
        const p = await makePrediction(m);
        if (!p) continue;

        await Prediction.create(p);
        console.log("✔ Prediction Saved:", p.teams);
    }
});

// ----------------------------------------------------
// 📡 SSE: LIVE PREDICTIONS STREAM
// ----------------------------------------------------
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
                ts: p.created_at
            }));

            res.write(`data: ${JSON.stringify({
                ts: Date.now(),
                matchesCount: formatted.length,
                matches: formatted
            })}\n\n`);

        } catch (err) {
            res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        }
    };

    const interval = setInterval(sendUpdates, 5000);

    req.on("close", () => {
        clearInterval(interval);
        console.log("❌ SSE Client Disconnected");
    });
});

// ----------------------------------------------------
// API Routes
// ----------------------------------------------------
app.get("/prediction", async (req, res) => {
    const preds = await Prediction.find().sort({ created_at: -1 }).limit(20);
    res.json(preds);
});

app.get("/today-matches", async (req, res) => {
    const matches = await getTodayMatches();
    res.json(matches);
});

// ----------------------------------------------------
// STATIC FRONT-END (YOUR index.html)
// ----------------------------------------------------
app.use(express.static(__dirname));
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// ----------------------------------------------------
// START SERVER
// ----------------------------------------------------
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
