// server.js
// Full aggregator + analyzer + MongoDB saving + SSE + 5-min cron
// Timezone: Asia/Karachi

const express = require("express");
const axios = require("axios");
const path = require("path");
const cron = require("node-cron");
const moment = require("moment-timezone");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const TIMEZONE = "Asia/Karachi";

// ----------------- MongoDB Connect -----------------
const MONGO_URL = process.env.MONGO_URL || "mongodb://mongo:oEClLGHGAdoIpZMRylyfUXPkXVgKojZq@mongodb.railway.internal:27017";
mongoose.connect(MONGO_URL, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✔ MongoDB Connected Successfully!"))
  .catch(err => console.log("❌ MongoDB Connection Error:", err));

// ----------------- Mongoose Models -----------------
const MatchSchema = new mongoose.Schema({
  sourceId: String,
  source: String,
  league: String,
  home: String,
  away: String,
  utcDate: String,
  kickoffLocal: String,
  status: String,
  odds: Object,
  stats: Object,
  analysis: Object,
  createdAt: { type: Date, default: Date.now }
});
const MatchModel = mongoose.model("Match", MatchSchema);

const SnapshotSchema = new mongoose.Schema({
  ts: { type: Date, default: Date.now },
  timezone: String,
  matchesCount: Number,
  matches: Array,
  apiUsage: Object
});
const SnapshotModel = mongoose.model("Snapshot", SnapshotSchema);

// ----------------- API Keys (Railway env vars) -----------------
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || "fdab0eef5743173c30f9810bef3a6742";
const ALL_SPORTS_KEY  = process.env.ALL_SPORTS_KEY  || "839f1988ceeaafddf8480de33d821556e29d8204b4ebdca13cb69c7a9bdcd325";
const API3_KEY = process.env.API3_KEY || "";
const API4_KEY = process.env.API4_KEY || "";
const API5_KEY = process.env.API5_KEY || "";

// ----------------- API usage tracking -----------------
const apiUsage = {
  apiFootball: { hits: 0, limit: parseInt(process.env.API_FOOTBALL_LIMIT||"10000",10) },
  allSports:  { hits: 0, limit: parseInt(process.env.ALL_SPORTS_LIMIT||"10000",10) },
  api3:       { hits: 0, limit: parseInt(process.env.API3_LIMIT||"10000",10) },
  api4:       { hits: 0, limit: parseInt(process.env.API4_LIMIT||"10000",10) },
  api5:       { hits: 0, limit: parseInt(process.env.API5_LIMIT||"10000",10) }
};
function recordHit(k){ if(apiUsage[k]) apiUsage[k].hits += 1; }

// ----------------- In-memory SSE clients & store -----------------
let sseClients = [];
let latestSnapshot = null;

// ----------------- Helpers -----------------
function oddsToProb(odds){
  if(!odds || odds <= 1) return 0;
  return (1/odds) * 100;
}
function clamp(v,min=0,max=100){ return Math.max(min, Math.min(max, v)); }

// combine odds+stats+momentum into confidence (simple weighted combiner)
function combineConfidence(oddsProb, statsProb, momentumProb, wOdds=0.55, wStats=0.30, wMom=0.15){
  const combined = (oddsProb*wOdds) + (statsProb*wStats) + (momentumProb*wMom);
  return clamp(combined,0,100);
}

// Poisson tail P(X > k)
function poissonTail(k, lambda){
  // compute cumulative P(X <= k) then 1 - that
  let p = 0;
  const factorial = n => { let f=1; for(let i=2;i<=n;i++) f*=i; return f; };
  for(let i=0;i<=k;i++){
    p += Math.exp(-lambda) * Math.pow(lambda, i) / factorial(i);
  }
  return 1 - p;
}

// small helper to compute recent form from db
async function computeTeamForm(teamName, lookbackMatches = 20){
  // returns basic stats: avgGoalsFor, avgGoalsAgainst, winRate
  const q = {
    $or: [{ home: teamName }, { away: teamName }]
  };
  const docs = await MatchModel.find(q).sort({ createdAt: -1 }).limit(lookbackMatches).lean();
  if(!docs || docs.length===0) return null;
  let gf=0, ga=0, played=0, wins=0, draws=0, losses=0;
  docs.forEach(d => {
    const s = d.score || d.stats && d.stats.score;
    if(!s) return;
    // support some formats
    let homeGoals = (s.home !== undefined)? Number(s.home) : (s.homeGoals || null);
    let awayGoals = (s.away !== undefined)? Number(s.away) : (s.awayGoals || null);
    if(homeGoals == null || awayGoals == null) return;
    played++;
    if(d.home === teamName){
      gf += homeGoals; ga += awayGoals;
      if(homeGoals > awayGoals) wins++; else if(homeGoals===awayGoals) draws++; else losses++;
    } else {
      gf += awayGoals; ga += homeGoals;
      if(awayGoals > homeGoals) wins++; else if(awayGoals===homeGoals) draws++; else losses++;
    }
  });
  if(played===0) return null;
  return {
    avgGoalsFor: +(gf/played).toFixed(2),
    avgGoalsAgainst: +(ga/played).toFixed(2),
    winRate: +((wins/played)*100).toFixed(2),
    matches: played
  };
}

// ----------------- Fetchers (5 slots) -----------------
// NOTE: These endpoints are examples. Replace to match your actual provider if needed.

async function fetchFromApiFootball(){
  try{
    recordHit("apiFootball");
    const today = moment().tz(TIMEZONE).format("YYYY-MM-DD");
    const url = `https://api-football-v1.p.rapidapi.com/v3/fixtures?date=${today}`;
    const r = await axios.get(url, {
      headers: {
        "x-rapidapi-key": API_FOOTBALL_KEY,
        "x-rapidapi-host": "api-football-v1.p.rapidapi.com"
      },
      timeout: 10000
    });
    if(r && r.data && r.data.response){
      return r.data.response.map(f => ({
        source: "api-football",
        sourceId: f.fixture && f.fixture.id,
        utcDate: f.fixture && f.fixture.date,
        league: f.league && f.league.name,
        home: f.teams && f.teams.home && f.teams.home.name,
        away: f.teams && f.teams.away && f.teams.away.name,
        status: f.fixture && f.fixture.status && f.fixture.status.short,
        score: f.goals || null,
        oddsRaw: f.odds || null,
        statsRaw: f.statistics || null
      }));
    }
    return [];
  }catch(err){
    console.log("fetchFromApiFootball error:", err.message);
    return [];
  }
}

async function fetchFromAllSportsApi(){
  try{
    recordHit("allSports");
    const today = moment().tz(TIMEZONE).format("YYYY-MM-DD");
    // example endpoint - adjust if provider differs
    const url = `https://allsportsapi.com/api/football/?met=Fixtures&APIkey=${ALL_SPORTS_KEY}&from=${today}&to=${today}`;
    const r = await axios.get(url, { timeout: 10000 });
    if(r && r.data && r.data.result){
      return r.data.result.map(f => ({
        source: "all-sports",
        sourceId: f.match_id || f.event_key,
        utcDate: f.match_date ? (f.match_date + " " + (f.match_time || "00:00")) : null,
        league: f.league || null,
        home: f.event_home_team || f.HomeTeam,
        away: f.event_away_team || f.AwayTeam,
        status: f.match_status || null,
        score: { home: f.event_final_result_home, away: f.event_final_result_away },
        oddsRaw: null,
        statsRaw: null
      }));
    }
    return [];
  }catch(err){
    console.log("fetchFromAllSportsApi error:", err.message);
    return [];
  }
}

async function fetchFromAPI3(){ recordHit("api3"); return []; } // placeholder
async function fetchFromAPI4(){ recordHit("api4"); return []; } // placeholder
async function fetchFromAPI5(){ recordHit("api5"); return []; } // placeholder

// ----------------- Match analysis -----------------
async function analyzeMatch(raw){
  // normalize kickoff
  const kickoffLocal = raw.utcDate ? moment.tz(raw.utcDate, TIMEZONE).format("YYYY-MM-DD HH:mm") : null;

  // odds parsing (best-effort); if none, use conservative defaults
  let homeOdds = null, awayOdds = null, drawOdds = null;
  try{
    if(raw.oddsRaw){
      // attempt: api-football structure: odds: [{bookmakers:[{bets:[{values:[{odd}] }]}]}]
      const first = raw.oddsRaw[0];
      if(first && first.bookmakers && first.bookmakers[0] && first.bookmakers[0].bets){
        // searching for "Match Winner" / "1X2" bet
        const bets = first.bookmakers[0].bets;
        for(const b of bets){
          if(b && b.values && b.values.length >= 2){
            // naive: assume 3 outcomes values[0]=home, [1]=draw, [2]=away
            if(b.values[0] && b.values[0].odd) homeOdds = parseFloat(b.values[0].odd);
            if(b.values[1] && b.values[1].odd) drawOdds = parseFloat(b.values[1].odd);
            if(b.values[2] && b.values[2].odd) awayOdds = parseFloat(b.values[2].odd);
            break;
          }
        }
      }
    }
  }catch(e){
    // ignore parsing errors and fallback to defaults
  }
  // fallback defaults
  homeOdds = homeOdds || 2.6;
  awayOdds = awayOdds || 2.6;
  drawOdds = drawOdds || 3.3;

  const homeProbOdds = oddsToProb(homeOdds);
  const awayProbOdds = oddsToProb(awayOdds);
  const drawProbOdds = oddsToProb(drawOdds);

  // historical team form (DB)
  const homeForm = await computeTeamForm(raw.home, 30) || { avgGoalsFor:0.9, avgGoalsAgainst:1.0, winRate:40 };
  const awayForm = await computeTeamForm(raw.away, 30) || { avgGoalsFor:0.8, avgGoalsAgainst:1.1, winRate:35 };

  // stats-based probability: simple blending from winRate and avgGoals
  const statsProbHome = clamp((homeForm.winRate * 0.6) + ((homeForm.avgGoalsFor - awayForm.avgGoalsAgainst) * 10), 5, 95);

  // momentum: if recent events show more attacking (placeholder)
  const momentumProb = raw.statsRaw && raw.statsRaw.length > 0 ? 55 : 50;

  const combinedHomeConfidence = combineConfidence(homeProbOdds, statsProbHome, momentumProb);

  // expected goals heuristic
  const expectedGoalsHome = (homeProbOdds/100) * 1.3 + (homeForm.avgGoalsFor * 0.5) + 0.6;
  const expectedGoalsAway = (awayProbOdds/100) * 1.1 + (awayForm.avgGoalsFor * 0.5) + 0.5;
  const totalExp = Math.max(0.1, expectedGoalsHome + expectedGoalsAway);

  // build Over/Under markets 0.5 -> 5.5 (0.5 increments)
  const markets = [];
  for(let x=0.5; x<=5.5; x+=0.5){
    const k = Math.floor(x);
    const probOver = poissonTail(k, totalExp) * 100; // percent
    markets.push({ market:`Over ${x}`, prob: Math.round(probOver*100)/100 });
  }

  const bttsProb = clamp( ((expectedGoalsHome>0.7?0.5:0.2) + (expectedGoalsAway>0.7?0.5:0.2)) * 50 , 5, 98);
  // last-10-min heuristic: if match is live and minute near end we can compute; else use exp goals
  const last10Prob = clamp(Math.round((totalExp/3)*30), 1, 95);

  const winnerProb = {
    home: Math.round(combinedHomeConfidence*100)/100,
    draw: Math.round(drawProbOdds),
    away: Math.round(awayProbOdds)
  };

  const strongMarkets = markets.filter(m => m.prob >= 85);

  // Save into DB for historical training
  const analysis = {
    kickoffLocal,
    expectedGoals: { home: +expectedGoalsHome.toFixed(2), away: +expectedGoalsAway.toFixed(2), total: +totalExp.toFixed(2) },
    markets, bttsProb, last10Prob, winnerProb, confidence: Math.round(combinedHomeConfidence*100)/100,
    strongMarkets, reasoning: `odds(home:${homeOdds},away:${awayOdds}) statsHome:${JSON.stringify(homeForm)}`
  };

  // Save raw match + analysis to DB (upsert by sourceId+source)
  try{
    await MatchModel.findOneAndUpdate(
      { sourceId: String(raw.sourceId || `${raw.home}_${raw.away}_${raw.utcDate}`), source: raw.source || 'unknown' },
      {
        sourceId: String(raw.sourceId || `${raw.home}_${raw.away}_${raw.utcDate}`),
        source: raw.source || 'unknown',
        league: raw.league,
        home: raw.home,
        away: raw.away,
        utcDate: raw.utcDate,
        kickoffLocal,
        status: raw.status,
        odds: raw.oddsRaw || null,
        stats: raw.statsRaw || null,
        analysis
      },
      { upsert: true, new: true }
    );
  }catch(e){
    console.log("DB save error:", e.message);
  }

  return Object.assign({ id: raw.sourceId || `${raw.home}_${raw.away}_${raw.utcDate}`, home: raw.home, away: raw.away, league: raw.league, kickoffLocal }, analysis);
}

// ----------------- Aggregation -----------------
async function aggregateAndAnalyze(){
  try{
    // fetch parallel
    const [a,b,c,d,e] = await Promise.all([
      fetchFromApiFootball(),
      fetchFromAllSportsApi(),
      fetchFromAPI3(),
      fetchFromAPI4(),
      fetchFromAPI5()
    ]);
    const raw = [...(a||[]), ...(b||[]), ...(c||[]), ...(d||[]), ...(e||[])];

    // dedupe by home+away+utcDate
    const seen = new Map();
    for(const m of raw){
      const key = `${(m.league||'')}:${(m.home||'')}:${(m.away||'')}:${(m.utcDate||'')}`;
      if(!seen.has(key)) seen.set(key, m);
    }
    const unique = Array.from(seen.values());

    // keep only today's matches in local timezone
    const todayStr = moment().tz(TIMEZONE).format("YYYY-MM-DD");
    const todays = unique.filter(u => {
      if(!u.utcDate) return true;
      const local = moment.tz(u.utcDate, TIMEZONE).format("YYYY-MM-DD");
      return local === todayStr;
    });

    const analyzed = [];
    for(const m of todays){
      const an = await analyzeMatch(m);
      analyzed.push(an);
    }

    const snapshot = {
      ts: new Date().toISOString(),
      timezone: TIMEZONE,
      matchesCount: analyzed.length,
      matches: analyzed,
      apiUsage
    };

    // save snapshot to DB
    await SnapshotModel.create(snapshot);
    latestSnapshot = snapshot;

    // push via SSE
    const data = JSON.stringify(snapshot);
    sseClients.forEach(res => {
      try { res.write(`data: ${data}\n\n`); } catch(e){}
    });

    console.log("Aggregate complete:", analyzed.length, "matches at", snapshot.ts);
    return snapshot;
  }catch(err){
    console.log("aggregateAndAnalyze error:", err.message);
    return null;
  }
}

// ----------------- Cron -----------------
cron.schedule("*/5 * * * *", async () => {
  console.log("[CRON] Running aggregate at", new Date().toLocaleString());
  await aggregateAndAnalyze();
});

// ----------------- Routes -----------------
app.use(express.static(path.join(__dirname))); // serve your index.html (single page)

// SSE endpoint
app.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  res.flushHeaders && res.flushHeaders();

  // send latest snapshot immediately
  if(latestSnapshot) res.write(`data: ${JSON.stringify(latestSnapshot)}\n\n`);

  sseClients.push(res);
  console.log("SSE client connected. Total:", sseClients.length);

  req.on("close", () => {
    sseClients = sseClients.filter(r => r !== res);
    console.log("SSE client disconnected. Total:", sseClients.length);
  });
});

// Prediction endpoint (last snapshot simplified)
app.get("/prediction", (req, res) => {
  if(!latestSnapshot) return res.json({ ok:false, message:"No predictions yet" });
  res.json({ ok:true, snapshot: latestSnapshot });
});

// Run now trigger
app.get("/run-now", async (req, res) => {
  const snap = await aggregateAndAnalyze();
  if(!snap) return res.status(500).json({ ok:false });
  res.json({ ok:true, snap });
});

// API usage
app.get("/api-usage", (req, res) => res.json({ ok:true, apiUsage }));

// health/home route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ----------------- Start -----------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
