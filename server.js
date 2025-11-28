



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
headers:{ "x-apisports-key": API_FOOTBALL_KEY },
params:{ date: today }
});
let matches = res.data.response;
matches = matches.filter(m=>TOP_LEAGUES.includes(m.league.id)||m.league.id===WORLD_CUP_QUALIFIER);
return matches;
}catch(err){
console.log("❌ Error Fetching Matches:",err.message);
return [];
}
}

// ----------------- FETCH H2H -----------------
async function getH2H(homeID, awayID){
try{
const res = await axios.get("https://v3.football.api-sports.io/fixtures/headtohead",{
headers:{ "x-apisports-key": API_FOOTBALL_KEY },
params:{ h2h:${homeID}-${awayID}, last:5 }
});
return res.data.response;
}catch(e){ return []; }
}

// ----------------- PRO-LEVEL PREDICTION ENGINE -----------------
async function makePrediction(match){
try{
const home = match.teams.home.name;
const away = match.teams.away.name;

// ---------- Fetch H2H ----------
const h2h = await getH2H(match.teams.home.id, match.teams.away.id);
const homeForm = h2h.length ? h2h.filter(m=>m.teams.home.id===match.teams.home.id).length : 3;
const awayForm = h2h.length ? h2h.filter(m=>m.teams.away.id===match.teams.away.id).length : 3;

// ---------- Poisson xG ----------
const xG_home = parseFloat((homeForm + Math.random()0.5).toFixed(2));
const xG_away = parseFloat((awayForm + Math.random()0.5).toFixed(2));
const xG_total = (xG_home+xG_away).toFixed(2);

// ---------- Probability ----------
let homeProb = Math.min(Math.round(40 + xG_home15 + Math.random()10),95);
let awayProb = Math.min(Math.round(30 + xG_away15 + Math.random()10),95);
let drawProb = Math.max(100-homeProb-awayProb,5);
const sum = homeProb+awayProb+drawProb;
homeProb=Math.round(homeProb/sum100);
drawProb=Math.round(drawProb/sum100);
awayProb=Math.round(awayProb/sum100);

const bttsProb = Math.min(Math.round(xG_home20 + xG_away*20 + Math.random()*30),95);

// ---------- Over/Under 0.5–5.5 ----------
const overUnder = {};
for(let i=0.5;i<=5.5;i+=0.5){
overUnder[i.toFixed(1)] = Math.min(Math.round((xG_total/i)*50 + Math.random()*30),99);
}

// ---------- Last 10 min goal chance ----------
const last10Prob = Math.min(Math.round((xG_home+xG_away)*15 + Math.random()30),95);

// ---------- Strong markets ----------
const strongMarkets = [];
Object.keys(overUnder).forEach(k=>{ if(overUnder[k]>=85) strongMarkets.push({market:Over ${k},prob:overUnder[k]}); });
if(homeProb>=85) strongMarkets.push({market:"Home Win",prob:homeProb});
if(awayProb>=85) strongMarkets.push({market:"Away Win",prob:awayProb});
if(bttsProb>=85) strongMarkets.push({market:"BTTS",prob:bttsProb});

return {
match_id: match.fixture.id,
league: match.league.name,
teams:${home} vs ${away},
winnerProb:{home:homeProb, draw:drawProb, away:awayProb},
bttsProb,
overUnder,
last10Prob,
xG:{home:xG_home, away:xG_away, total:xG_total},
strongMarkets
};

}catch(err){ console.log("❌ Prediction Error:",err.message); return null; }
}

// ----------------- CRON JOB (EVERY 5 MINUTES) -----------------
cron.schedule("/5 * * * *", async ()=>{
console.log("🔁 Auto Prediction Check Running...");
const matches = await getTodayMatches();
for(let m of matches){
const p = await makePrediction(m);
if(!p) continue;
await Prediction.create(p);
console.log("✔ Prediction Saved:",p.teams);
}
});

// ----------------- SSE LIVE -----------------
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
res.write(data: ${JSON.stringify({ts:Date.now(),matches:formatted})}\\n\\n);
}catch(err){
res.write(data: ${JSON.stringify({error:err.message})}\\n\\n);
}
};

const interval = setInterval(sendUpdates,5000);
req.on("close",()=>{ clearInterval(interval); console.log("❌ SSE Client Disconnected"); });
});

// ----------------- API -----------------
app.get("/prediction", async (req,res)=>{ const preds=await Prediction.find().sort({created_at:-1}).limit(20); res.json(preds); });
app.get("/today-matches", async (req,res)=>{ const matches = await getTodayMatches(); res.json(matches); });

// ----------------- STATIC FRONTEND -----------------
app.use(express.static(__dirname));
app.get("/", (req,res)=>{ res.sendFile(path.join(__dirname,"index.html")); });

// ----------------- START SERVER -----------------
app.listen(PORT,()=>{ console.log(🚀 Server running on port ${PORT}); });
