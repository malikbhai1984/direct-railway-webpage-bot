// server.js - PRO with Duplicate-free Predictions
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
mongoose.connect(process.env.MONGO_URI || "mongodb://mongo:password@host:port", {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(()=>console.log("✔ MongoDB Connected"))
.catch(err=>console.log("❌ Mongo Error:",err));

// ----------------- SCHEMA -----------------
const PredictionSchema = new mongoose.Schema({
  match_id: { type: String, unique: true }, // unique match identifier
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

// ----------------- CONFIG -----------------
const THESPORTSDB_KEY = process.env.THESPORTSDB_KEY || "";
let latestMatches = []; // store last fetched matches

// ----------------- TheSportsDB URL helper -----------------
function tsdbUrl(pathname, params = {}) {
  const key = THESPORTSDB_KEY || "1";
  const base = `https://www.thesportsdb.com/api/v1/json/${key}/${pathname}.php`;
  const qs = new URLSearchParams(params).toString();
  return qs ? `${base}?${qs}` : base;
}

// ----------------- FETCH LIVE MATCHES -----------------
async function fetchLiveMatches() {
  try {
    const todayPKT = moment().tz("Asia/Karachi").format("YYYY-MM-DD");
    const url = tsdbUrl("eventsday", { d: todayPKT, s: "Soccer" });
    const r = await axios.get(url, { timeout: 10000 });
    const matches = r.data?.events || [];
    latestMatches = matches.map(ev => ({
      fixture: {
        id: ev.idEvent || `${ev.idHomeTeam}_${ev.idAwayTeam}_${ev.dateEvent}`,
        date: ev.dateEvent ? `${ev.dateEvent} ${ev.strTime || "00:00:00"}` : ev.dateEvent,
        status: { short: ev.strStatus || (ev.intHomeScore==null && ev.intAwayScore==null ? "NS" : "FT"), elapsed: ev.intTime || 0 }
      },
      teams: {
        home: { id: ev.idHomeTeam || ev.idHome, name: ev.strHomeTeam || ev.strEvent?.split(" vs ")[0] || ev.strEvent },
        away: { id: ev.idAwayTeam || ev.idAway, name: ev.strAwayTeam || ev.strEvent?.split(" vs ")[1] || ev.strEvent }
      },
      league: { id: ev.idLeague || ev.idCompetition || null, name: ev.strLeague || ev.strCompetition || "Unknown" },
      goals: { home: ev.intHomeScore ?? null, away: ev.intAwayScore ?? null },
      raw: ev
    }));
    console.log(`✔ Live matches fetched: ${latestMatches.length}`);
  } catch (err) {
    console.log("❌ fetchLiveMatches error:", err.message);
  }
}

// ----------------- GET LAST EVENTS -----------------
async function getTeamLastEvents(teamId) {
  try {
    if (!teamId) return [];
    const url = tsdbUrl("eventslast", { id: teamId });
    const r = await axios.get(url, { timeout: 10000 });
    return r.data?.results || r.data?.events || [];
  } catch {
    return [];
  }
}

async function getLastNMatches(match, N = 15) {
  const [homeLast, awayLast] = await Promise.all([
    getTeamLastEvents(match.teams.home.id),
    getTeamLastEvents(match.teams.away.id)
  ]);
  const norm = evt => ({
    id: evt.idEvent || evt.id,
    date: evt.dateEvent || evt.date,
    home: { id: evt.idHomeTeam || evt.idHomeTeam },
    away: { id: evt.idAwayTeam || evt.idAwayTeam },
    homeScore: evt.intHomeScore ?? evt.intHome,
    awayScore: evt.intAwayScore ?? evt.intAway
  });
  const combined = [...(homeLast||[]).map(norm), ...(awayLast||[]).map(norm)];
  const uniq = {};
  combined.forEach(c => { if (c && c.id) uniq[c.id] = c; });
  return Object.values(uniq).sort((a,b)=> (b.date||"").localeCompare(a.date||"")).slice(0,N);
}

// ----------------- PREDICTION ENGINE -----------------
async function makePrediction(match) {
  try {
    const home = match.teams.home.name;
    const away = match.teams.away.name;
    const lastMatches = await getLastNMatches(match, 15);

    let homeGoalsFor=0, homeGoalsAgainst=0, homeMatches=0;
    let awayGoalsFor=0, awayGoalsAgainst=0, awayMatches=0;
    for (const m of lastMatches) {
      if (!m) continue;
      if (String(m.home.id) === String(match.teams.home.id)) { homeGoalsFor += m.homeScore ?? 0; homeGoalsAgainst += m.awayScore ?? 0; homeMatches++; }
      if (String(m.away.id) === String(match.teams.home.id)) { homeGoalsFor += m.awayScore ?? 0; homeGoalsAgainst += m.homeScore ?? 0; homeMatches++; }
      if (String(m.home.id) === String(match.teams.away.id)) { awayGoalsFor += m.homeScore ?? 0; awayGoalsAgainst += m.awayScore ?? 0; awayMatches++; }
      if (String(m.away.id) === String(match.teams.away.id)) { awayGoalsFor += m.awayScore ?? 0; awayGoalsAgainst += m.homeScore ?? 0; awayMatches++; }
    }

    const avgHomeFor = homeMatches ? (homeGoalsFor/homeMatches) : 1.05;
    const avgAwayFor = awayMatches ? (awayGoalsFor/awayMatches) : 1.05;
    const avgHomeAgainst = homeMatches ? (homeGoalsAgainst/homeMatches) : 1.05;
    const avgAwayAgainst = awayMatches ? (awayGoalsAgainst/awayMatches) : 1.05;

    const xG_home = Number(((avgHomeFor*0.7)+(((1.2)*(1/(avgAwayAgainst||1)))*0.3)+Math.random()*0.4).toFixed(2));
    const xG_away = Number(((avgAwayFor*0.7)+(((1.1)*(1/(avgHomeAgainst||1)))*0.3)+Math.random()*0.4).toFixed(2));
    const xG_total = Number((xG_home+xG_away).toFixed(2));

    let homeScoreFactor = xG_home*1.3 + (homeMatches ? (homeGoalsFor/homeMatches) : 0.5);
    let awayScoreFactor = xG_away*1.3 + (awayMatches ? (awayGoalsFor/awayMatches) : 0.5);

    let homeProb = Math.round((homeScoreFactor/(homeScoreFactor+awayScoreFactor))*100);
    let awayProb = Math.round((awayScoreFactor/(homeScoreFactor+awayScoreFactor))*100);
    let drawProb = Math.max(100-homeProb-awayProb,3);
    const sum = homeProb+awayProb+drawProb;
    homeProb=Math.round(homeProb/sum*100); drawProb=Math.round(drawProb/sum*100); awayProb=Math.round(awayProb/sum*100);

    let bttsCount=0, bttsTotal=0;
    for(const m of lastMatches){
      if(typeof m.homeScore==="number" && typeof m.awayScore==="number"){ bttsTotal++; if(m.homeScore>0 && m.awayScore>0) bttsCount++; }
    }
    const historicBtts = bttsTotal ? (bttsCount/bttsTotal) : 0.6;
    let bttsProb = Math.min(95, Math.round(historicBtts*100*0.6 + xG_total*10*0.4 + Math.random()*10));

    const overUnder={};
    for(let t=0.5; t<=5.5; t+=0.5){
      const base = Math.min(98, Math.round((xG_total/(t+0.1))*50 + Math.random()*20));
      overUnder[t.toFixed(1)] = Math.max(2, base);
    }

    const last10Base = Math.round((xG_home+xG_away)*12+Math.random()*20);
    const last10Prob = Math.min(95, Math.max(5,last10Base));

    const strongMarkets=[];
    Object.keys(overUnder).forEach(k=>{
      if(overUnder[k]>=85) strongMarkets.push({market:`Over ${k}`,prob:overUnder[k]});
      if((100-overUnder[k])>=85) strongMarkets.push({market:`Under ${k}`,prob:100-overUnder[k]});
    });
    if(homeProb>=85) strongMarkets.push({market:"Home Win",prob:homeProb});
    if(awayProb>=85) strongMarkets.push({market:"Away Win",prob:awayProb});
    if(bttsProb>=85) strongMarkets.push({market:"BTTS",prob:bttsProb});

    return {
      match_id: match.fixture.id,
      league: match.league?.name||"Unknown",
      teams:`${home} vs ${away}`,
      winnerProb:{home:homeProb,draw:drawProb,away:awayProb},
      bttsProb,
      overUnder,
      last10Prob,
      xG:{home:xG_home,away:xG_away,total:xG_total},
      strongMarkets
    };
  } catch(err){
    console.log("❌ makePrediction error:",err.message);
    return null;
  }
}

// ----------------- CRON JOBS -----------------
cron.schedule("*/15 * * * *", fetchLiveMatches); // 15-min API fetch
cron.schedule("*/5 * * * *", async ()=>{
  for(const m of latestMatches){
    const p = await makePrediction(m);
    if(!p) continue;
    // upsert - update existing prediction or create new
    await Prediction.findOneAndUpdate({match_id:p.match_id}, p, {upsert:true});
    console.log("✔ Prediction upserted:",p.teams);
  }
});

// ----------------- SSE / API -----------------
app.get("/events", async (req,res)=>{
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.flushHeaders();

  const sendUpdates = async ()=>{
    const preds = await Prediction.find().sort({created_at:-1}).limit(200);
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
  };

  await sendUpdates();
  const interval = setInterval(sendUpdates,5*60*1000);
  req.on("close",()=> clearInterval(interval));
});

app.get("/prediction", async (req,res)=>res.json(await Prediction.find().sort({created_at:-1}).limit(200)));
app.get("/today-matches", async (req,res)=>res.json(latestMatches));

app.use(express.static(__dirname));
app.get("/", (req,res)=>res.sendFile(path.join(__dirname,"index.html")));

app.listen(PORT,()=>console.log(`🚀 Server running on port ${PORT}`));
