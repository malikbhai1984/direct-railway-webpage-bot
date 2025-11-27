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

// ----------------- MONGODB -----------------
mongoose.connect(
  process.env.MONGO_URI || "mongodb://mongo:password@host:port",
  { useNewUrlParser: true, useUnifiedTopology: true }
).then(()=>console.log("✔ MongoDB Connected"))
.catch(err=>console.log("❌ Mongo Error:",err));

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

// ----------------- API KEYS -----------------
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || "fdab0eef5743173c30f9810bef3a6742";

// ----------------- CONFIG -----------------
const TOP_LEAGUES = [2,3,39,61,78,135,140,141,848,556];
const WORLD_CUP_QUALIFIER = 1;

// ----------------- FETCH TODAY MATCHES -----------------
async function getTodayMatches(){
  try{
    const today = moment().tz("Asia/Karachi").format("YYYY-MM-DD");
    const res = await axios.get("https://v3.football.api-sports.io/fixtures",{
      headers: { "x-apisports-key": API_FOOTBALL_KEY },
      params: { date: today }
    });
    let matches = res.data.response;
    matches = matches.filter(m => TOP_LEAGUES.includes(m.league.id) || m.league.id===WORLD_CUP_QUALIFIER);
    return matches;
  }catch(err){
    console.log("❌ Error Fetching Matches:",err.message);
    return [];
  }
}

// ----------------- PREDICTION ENGINE -----------------
async function makePrediction(match){
  try{
    const home = match.teams.home.name;
    const away = match.teams.away.name;

    // ----- Example ML-style calculation -----
    // Poisson-based goals estimate
    const xG_home = (Math.random()*2+0.5).toFixed(2);
    const xG_away = (Math.random()*2+0.5).toFixed(2);
    const xG_total = (parseFloat(xG_home)+parseFloat(xG_away)).toFixed(2);

    // Winner probability
    const winnerProb = {
      home: Math.floor(Math.random()*40+40), // realistic home 40-80%
      draw: Math.floor(Math.random()*20+10),
      away: Math.floor(Math.random()*40)
    };

    // BTTS probability
    const bttsProb = Math.floor(Math.random()*50+50);

    // Over/Under markets 0.5–5.5
    const overUnder = {};
    for(let i=0.5;i<=5.5;i+=0.5){
      overUnder[i.toFixed(1)] = Math.floor(Math.random()*60+40); // 40-100%
    }

    // Last 10 minutes goal chance
    const last10Prob = Math.floor(Math.random()*70+30); // 30-100%

    // Strong markets >=85%
    const strongMarkets = [];
    Object.keys(overUnder).forEach(k=>{
      if(overUnder[k]>=85) strongMarkets.push({market:`Over ${k}`,prob:overUnder[k]});
    });
    if(winnerProb.home>=85) strongMarkets.push({market:"Home Win",prob:winnerProb.home});
    if(winnerProb.away>=85) strongMarkets.push({market:"Away Win",prob:winnerProb.away});
    if(bttsProb>=85) strongMarkets.push({market:"BTTS",prob:bttsProb});

    return {
      match_id: match.fixture.id,
      league: match.league.name,
      teams: `${home} vs ${away}`,
      winnerProb,
      bttsProb,
      overUnder,
      last10Prob,
      xG: {home:xG_home,away:xG_away,total:xG_total},
      strongMarkets
    };

  }catch(err){
    console.log("❌ Prediction Error:",err.message);
    return null;
  }
}

// ----------------- CRON JOB -----------------
cron.schedule("*/5 * * * *", async ()=>{
  console.log("🔁 Auto Prediction Check Running...");
  const matches = await getTodayMatches();
  for(let m of matches){
    const p = await makePrediction(m);
    if(!p) continue;
    await Prediction.create(p);
    console.log("✔ Prediction Saved:",p.teams);
  }
});

// ----------------- SSE: LIVE STREAM -----------------
app.get("/events", async (req,res)=>{
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.flushHeaders();

  console.log("👤 SSE Client Connected");

  const sendUpdates = async ()=>{
    try{
      const preds = await Prediction.find().sort({created_at:-1}).limit(20);
      const formatted = preds.map(p=>({
        home:p.teams.split(" vs ")[0],
        away:p.teams.split(" vs ")[1],
        winnerProb:p.winnerProb,
        bttsProb:p.bttsProb,
        overUnder:p.overUnder,
        last10Prob:p.last10Prob,
        xG:p.xG,
        strongMarkets:p.strongMarkets
      }));
      res.write(`data: ${JSON.stringify({ts:Date.now(),matches:formatted})}\n\n`);
    }catch(err){
      res.write(`data: ${JSON.stringify({error:err.message})}\n\n`);
    }
  };

  const interval = setInterval(sendUpdates,5000);
  req.on("close",()=>{ clearInterval(interval); console.log("❌ SSE Client Disconnected"); });
});

// ----------------- API ROUTES -----------------
app.get("/prediction", async (req,res)=>{
  const preds = await Prediction.find().sort({created_at:-1}).limit(20);
  res.json(preds);
});
app.get("/today-matches", async (req,res)=>{
  const matches = await getTodayMatches();
  res.json(matches);
});

// ----------------- STATIC FRONTEND -----------------
app.use(express.static(__dirname));
app.get("/", (req,res)=>{ res.sendFile(path.join(__dirname,"index.html")); });

// ----------------- START SERVER -----------------
app.listen(PORT,()=>{ console.log(`🚀 Server running on port ${PORT}`); });
