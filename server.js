const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const cron = require("node-cron");
const cors = require("cors");
const path = require("path");

// ---------- Express App ----------
const app = express();
app.use(cors());
const PORT = process.env.PORT || 8080;

// ---------- Serve STATIC index.html ----------
app.use(express.static(__dirname));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// ---------- MongoDB ----------
mongoose.connect("mongodb://mongo:oEClLGHGAdoIpZMRylyfUXPkXVgKojZq@trolley.proxy.rlwy.net:40178", {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    authSource: "admin"
})
.then(() => console.log("✔ MongoDB Connected"))
.catch(err => console.log("❌ Mongo Error:", err));


// ---------- Prediction Schema ----------
const PredictionSchema = new mongoose.Schema({
    match_id: String,
    league: String,
    teams: String,
    prediction: String,
    confidence: Number,
    created_at: { type: Date, default: Date.now }
});

const Prediction = mongoose.model("Prediction", PredictionSchema);

// ---------- API KEYS ----------
const API_FOOTBALL_KEY = "fdab0eef5743173c30f9810bef3a6742";

// Top leagues
const TOP_LEAGUES = [2, 3, 39, 61, 78, 135, 140, 141, 848, 556];
const WORLD_CUP_QUALIFIER = 1;

// ---------- FUNCTION: Get Today Matches ----------
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

// ---------- PREDICTION FUNCTION ----------
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

// ---------- CRON JOB (EVERY 5 MINUTES) ----------
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

// ---------- API: LAST 20 PREDICTIONS ----------
app.get("/prediction", async (req, res) => {
    try {
        const preds = await Prediction.find().sort({ created_at: -1 }).limit(20);
        res.json({ success: true, data: preds });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ---------- API: Today Matches ----------
app.get("/today-matches", async (req, res) => {
    const matches = await getTodayMatches();
    res.json(matches);
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
