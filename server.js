

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

// ================= MONGODB =================
mongoose.connect(process.env.MONGO_PUBLIC_URL, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => console.log("✔ MongoDB Connected"))
  .catch(err => console.log("❌ Mongo Error:", err.message));

// ================== SCHEMA ==================
const PredictionSchema = new mongoose.Schema({
    match_id: { type: String, required: true, unique: true },
    league: String,
    teams: String,
    winnerProb: Object,
    bttsProb: Number,
    overUnder: Object,
    last10Prob: Number,
    xG: Object,
    strongMarkets: Array,
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now }
});

const Prediction = mongoose.model("Prediction", PredictionSchema);

// ================= API CONFIG =================
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = "https://v3.football.api-sports.io";
const TOP_LEAGUES = [2, 3, 39, 61, 78, 135, 140, 141, 848, 556];
const WORLD_CUP_QUALIFIER = 1;

// ================= TODAY MATCHES =================
async function getTodayMatches() {
    try {
        const today = moment().tz("Asia/Karachi").format("YYYY-MM-DD");

        const res = await axios.get(`${API_BASE}/fixtures`, {
            headers: { "x-apisports-key": API_FOOTBALL_KEY },
            params: { date: today }
        });

        let matches = res.data.response || [];

        matches = matches.filter(
            m => TOP_LEAGUES.includes(m.league.id) || m.league.id === WORLD_CUP_QUALIFIER
        );

        return matches;
    } catch (e) {
        console.log("❌ Error Fetching Matches:", e.message);
        return [];
    }
}

// ============== H2H FETCH (SAFE) ==============
async function getH2H(homeID, awayID) {
    try {
        const res = await axios.get(`${API_BASE}/fixtures/headtohead`, {
            headers: { "x-apisports-key": API_FOOTBALL_KEY },
            params: { h2h: `${homeID}-${awayID}`, last: 5 }
        });

        return res.data.response || [];
    } catch {
        return [];
    }
}

// ============== PREDICTION ENGINE ==============
async function makePrediction(match) {
    try {
        const home = match.teams.split(" vs ")[0];
        const away = match.teams.split(" vs ")[1];

        const xG_home = (Math.random() * 2 + 0.5).toFixed(2);
        const xG_away = (Math.random() * 2 + 0.5).toFixed(2);
        const xG_total = (parseFloat(xG_home) + parseFloat(xG_away)).toFixed(2);

        const homeProb = Math.round(Math.random() * 70 + 10);
        const awayProb = Math.round(Math.random() * 60 + 5);
        const drawProb = 100 - homeProb - awayProb;

        const bttsProb = Math.round((xG_total * 20) + Math.random() * 20);

        const overUnder = {};
        for (let i = 0.5; i <= 5.5; i += 0.5) {
            overUnder[i.toFixed(1)] = Math.round((xG_total / i) * 40 + Math.random() * 30);
        }

        const strongMarkets = [];
        for (let key in overUnder) {
            if (overUnder[key] >= 85) strongMarkets.push({ market: "Over " + key, prob: overUnder[key] });
        }

        return {
            ...match,
            winnerProb: { home: homeProb, draw: drawProb, away: awayProb },
            bttsProb,
            overUnder,
            xG: { home: xG_home, away: xG_away, total: xG_total },
            strongMarkets,
            updated_at: new Date()
        };
    } catch (e) {
        console.log("❌ Prediction Engine Error:", e.message);
        return null;
    }
}

// ============== CRON JOBS ==============
cron.schedule("*/15 * * * *", async () => {
    const matches = await getTodayMatches();
    if (matches.length === 0) return;

    await Prediction.deleteMany({});
    for (let m of matches) {
        await Prediction.create({
            match_id: m.fixture.id,
            league: m.league.name,
            teams: `${m.teams.home.name} vs ${m.teams.away.name}`
        });
    }

    console.log("✔ Matches Fetched:", matches.length);
});

cron.schedule("*/5 * * * *", async () => {
    const matches = await Prediction.find();
    for (let m of matches) {
        const p = await makePrediction(m);
        if (!p) continue;

        await Prediction.updateOne({ _id: m._id }, p);
    }
    console.log("✔ Predictions Updated");
});

// ============== SSE STREAM ==============
app.get("/events", async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = async () => {
        const data = await Prediction.find().limit(20).lean();
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    await send();
    const timer = setInterval(send, 10000);

    req.on("close", () => clearInterval(timer));
});

// ============== REST API ==============
app.get("/prediction", async (req, res) => {
    const data = await Prediction.find().limit(20).lean();
    res.json({ success: true, data });
});

// ============== STATIC FRONTEND ==============
// 👉 NOTE: Yahan public/index.html hona zaroori hai
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public/index.html"));
});

// ============== START SERVER ==============
app.listen(PORT, () => {
    console.log(`🚀 Running on PORT ${PORT}`);
});
