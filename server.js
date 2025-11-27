

const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const cron = require("node-cron");
const cors = require("cors");

// ---------- MongoDB ----------
mongoose.connect("mongodb://mongo:oEClLGHGAdoIpZMRylyfUXPkXVgKojZq@mongodb.railway.internal:27017", {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log("✔ MongoDB Connected"))
.catch(err => console.log("❌ Mongo Error:", err));

const PredictionSchema = new mongoose.Schema({
    match_id: String,
    league: String,
    teams: String,
    prediction: String,
    confidence: Number,
    created_at: { type: Date, default: Date.now }
});
const Prediction = mongoose.model("Prediction", PredictionSchema);

// ---------- Express Server ----------
const app = express();
app.use(cors());
const PORT = process.env.PORT || 8080;

const API_FOOTBALL_KEY = "fdab0eef5743173c30f9810bef3a6742";
const ALLSPORTS_KEY = "839f1988ceeaafddf8480de33d821556e29d8204b4ebdca13cb69c7a9bdcd325";

// Top 10 IMPORTANT LEAGUES
const TOP_LEAGUES = [2, 3, 39, 61, 78, 135, 140, 141, 848, 556];
const WORLD_CUP_QUALIFIER = 1;

// ---------- FUNCTION: Fetch Today Matches ----------
async function getTodayMatches() {
    try {
        const today = moment().tz("Asia/Karachi").format("YYYY-MM-DD");

        const res = await axios.get("https://v3.football.api-sports.io/fixtures", {
            headers: { "x-apisports-key": API_FOOTBALL_KEY },
            params: { date: today }
        });

        let matches = res.data.response;

        // FILTER top leagues + world cup qualifiers
        matches = matches.filter(m =>
            TOP_LEAGUES.includes(m.league.id) ||
            m.league.id === WORLD_CUP_QUALIFIER
        );

        console.log("Today Matches:", matches.length);

        return matches;

    } catch (err) {
        console.log("❌ Error Fetching Matches:", err.message);
        return [];
    }
}

// ---------- FUNCTION: Prediction Engine ----------
async function makePrediction(match) {
    try {
        const home = match.teams.home.name;
        const away = match.teams.away.name;

        // simple 85% prediction logic (will upgrade later)
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

// ---------- CRON: Auto Update Every 5 Minutes ----------
cron.schedule("*/5 * * * *", async () => {
    console.log("🔁 Running Prediction Auto Update...");

    const matches = await getTodayMatches();

    for (let m of matches) {
        const p = await makePrediction(m);
        if (!p) continue;

        await Prediction.create(p);
        console.log("✔ Saved Prediction:", p.teams);
    }
});

// ---------- API: GET LIVE PREDICTIONS ----------
app.get("/prediction", async (req, res) => {
    try {
        const preds = await Prediction.find().sort({ created_at: -1 }).limit(20);
        res.json({ success: true, data: preds });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ---------- API: CHECK TODAY MATCH ----------
app.get("/today-matches", async (req, res) => {
    const matches = await getTodayMatches();
    res.json(matches);
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
