// server.js
// Complete aggregator + heuristic+ML predictions + MongoDB saving + SSE + 5-min cron
// Timezone: Asia/Karachi (PKT)

const express = require("express");
const axios = require("axios");
const path = require("path");
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const cron = require("node-cron");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const TIMEZONE = "Asia/Karachi";

// ----------------- CONFIG / KEYS -----------------
// Replace these in Railway Variables if you want
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || "fdab0eef5743173c30f9810bef3a6742";
const ALL_SPORTS_KEY  = process.env.ALL_SPORTS_KEY  || "839f1988ceeaafddf8480de33d821556e29d8204b4ebdca13cb69c7a9bdcd325";

// MongoDB connect (use your Railway public connection)
const MONGO_URL = process.env.MONGO_URL || "mongodb://mongo:oEClLGHGAdoIpZMRylyfUXPkXVgKojZq@trolley.proxy.rlwy.net:40178";
mongoose.connect(MONGO_URL, { useNewUrlParser: true, useUnifiedTopology: true, authSource: "admin" })
  .then(() => console.log("✔ MongoDB Connected"))
  .catch(err => { console.log("❌ Mongo Error:", err); });

// ----------------- MODELS -----------------
const MatchSchema = new mongoose.Schema({
  sourceId: String,
  source: String,
  leagueId: Number,
  league: String,
  home: String,
  away: String,
  utcDate: String,
  kickoffLocal: String,
  status: String,
  score: Object,   // {home, away}
  odds: Object,
  stats: Object,
  savedAt: { type: Date, default: Date.now }
});
const MatchModel = mongoose.model("Match", MatchSchema);

const PredictionSchema = new mongoose.Schema({
  sourceId: String,
  teams: String,
  matchDate: String,
  prediction: Object, // structured prediction
  createdAt: { type: Date, default: Date.now }
});
const PredictionModel = mongoose.model("Prediction", PredictionSchema);

// ----------------- API USAGE TRACKER -----------------
const apiUsage = {
  apiFootball: { hits: 0, limit: parseInt(process.env.API_FOOTBALL_LIMIT||"10000",10) },
  allSports: { hits: 0, limit: parseInt(process.env.ALL_SPORTS_LIMIT||"10000",10) }
};
function recordHit(name){ if(apiUsage[name]) apiUsage[name].hits += 1; }

// ----------------- HELPERS (math/stats) -----------------
function oddsToProb(odds){
  if(!odds || odds <= 1) return 0;
  return (1/odds) * 100;
}
function clamp(v, a=0, b=100){ return Math.max(a, Math.min(b, v)); }

// Poisson tail P(X > k)
function poissonTail(k, lambda){
  // compute P(X > k) = 1 - sum_{i=0..k} e^-λ λ^i / i!
  let p = 0;
  const factorial = n => { if(n<=1) return 1; let f=1; for(let i=2;i<=n;i++) f*=i; return f; };
  for(let i=0;i<=k;i++){
    p += Math.exp(-lambda) * Math.pow(lambda, i) / factorial(i);
  }
  return Math.max(0, 1 - p);
}

// Simple logistic regression trainer & predictor (vanilla gradient descent)
function trainLogistic(features, labels, epochs=2000, lr=0.01){
  if(!features.length) return null;
  const m = features.length, n = features[0].length;
  let w = new Array(n).fill(0), b = 0;
  const sigmoid = x => 1/(1+Math.exp(-x));
  for(let e=0;e<epochs;e++){
    let dw = new Array(n).fill(0), db = 0;
    for(let i=0;i<m;i++){
      const x = features[i], y = labels[i];
      let z = b;
      for(let j=0;j<n;j++) z += w[j]*x[j];
      const pred = sigmoid(z);
      const err = pred - y;
      for(let j=0;j<n;j++) dw[j] += err * x[j];
      db += err;
    }
    // update
    for(let j=0;j<n;j++) w[j] -= lr * (dw[j]/m);
    b -= lr * (db/m);
  }
  return { w, b, predict: (x) => { let z = b; for(let j=0;j<x.length;j++) z += w[j]*x[j]; return 1/(1+Math.exp(-z)); } };
}

// ----------------- DATA INGEST: fetch & store historical (past N days) -----------------
// This will fetch past fixtures (results) and store them to MatchModel for training
// Run manually or schedule as needed
async function ingestPastResults(daysBack=60){
  try{
    recordHit("apiFootball");
    // fetch fixtures for past days (one call per day for simplicity)
    for(let d=1; d<=Math.min(daysBack,60); d++){
      const date = moment().tz(TIMEZONE).subtract(d, 'days').format("YYYY-MM-DD");
      const r = await axios.get("https://v3.football.api-sports.io/fixtures", {
        headers: { "x-apisports-key": API_FOOTBALL_KEY },
        params: { date }
      });
      if(!r.data || !r.data.response) continue;
      for(const f of r.data.response){
        // only completed matches with scores
        if(!f.goals || f.fixture.status.short !== 'FT') continue;
        const doc = {
          sourceId: f.fixture.id,
          source: "api-football",
          leagueId: f.league.id,
          league: f.league.name,
          home: f.teams.home.name,
          away: f.teams.away.name,
          utcDate: f.fixture.date,
          kickoffLocal: moment.tz(f.fixture.date, TIMEZONE).format("YYYY-MM-DD HH:mm"),
          status: f.fixture.status.short,
          score: { home: f.goals.home, away: f.goals.away },
          odds: f.odds || null,
          stats: f.statistics || null
        };
        await MatchModel.updateOne({ sourceId: doc.sourceId }, { $set: doc }, { upsert:true });
      }
    }
    console.log("✔ Ingested past results");
  }catch(err){
    console.log("❌ ingestPastResults error:", err.message);
  }
}

// ----------------- FEATURE BUILDERS -----------------
async function computeTeamForm(team, lookback=20){
  // returns avgGoalsFor, avgGoalsAgainst, winRate (0-100)
  const docs = await MatchModel.find({ $or: [{home:team}, {away:team}], "score.home": {$exists:true} }).sort({ savedAt: -1 }).limit(lookback).lean();
  if(!docs.length) return null;
  let played=0, gf=0, ga=0, wins=0;
  for(const d of docs){
    if(!d.score) continue;
    let hg = Number(d.score.home), ag = Number(d.score.away);
    if(isNaN(hg) || isNaN(ag)) continue;
    played++;
    if(d.home === team){ gf += hg; ga += ag; if(hg>ag) wins++; }
    else { gf += ag; ga += hg; if(ag>hg) wins++; }
  }
  if(played===0) return null;
  return { avgGF: +(gf/played).toFixed(2), avgGA: +(ga/played).toFixed(2), winRate: +(wins/played*100).toFixed(2) };
}

// ----------------- MODEL TRAINING (BTTS & HOME_WIN) -----------------
async function trainModelsIfPossible(){
  try{
    // gather labeled matches (completed with score)
    const docs = await MatchModel.find({ "score.home": { $exists: true } }).limit(10000).lean();
    if(docs.length < 80){
      console.log("ℹ Not enough labeled history to train models (need >=80). Using heuristics.");
      return null;
    }

    // build dataset
    const featsBTTS = [], labelsBTTS = [];
    const featsHome = [], labelsHome = [];

    for(const d of docs){
      // features: home_avgGF, home_avgGA, away_avgGF, away_avgGA, home_winrate, away_winrate, dayOfWeek, month
      const homeForm = await computeTeamForm(d.home, 20) || {avgGF:1, avgGA:1, winRate:45};
      const awayForm = await computeTeamForm(d.away, 20) || {avgGF:1, avgGA:1, winRate:40};

      const x = [
        homeForm.avgGF, homeForm.avgGA,
        awayForm.avgGF, awayForm.avgGA,
        homeForm.winRate/100, awayForm.winRate/100,
        (new Date(d.utcDate)).getUTCDay()/6
      ];

      // BTTS label: did both teams score?
      const btts = (d.score.home > 0 && d.score.away > 0)?1:0;
      featsBTTS.push(x); labelsBTTS.push(btts);

      // Home win label
      let homeWin = 0;
      if(d.score.home > d.score.away) homeWin = 1;
      else homeWin = 0;
      featsHome.push(x); labelsHome.push(homeWin);
    }

    // train logistic models
    console.log("🔁 Training models on", docs.length, "matches...");
    const modelBTTS = trainLogistic(featsBTTS, labelsBTTS, 2000, 0.02);
    const modelHome = trainLogistic(featsHome, labelsHome, 2000, 0.02);
    console.log("✔ Models trained");

    return { modelBTTS, modelHome };

  }catch(err){
    console.log("❌ trainModelsIfPossible error:", err.message);
    return null;
  }
}

// ----------------- PREDICTION ENGINE (combines heuristic + models) -----------------
let trainedModels = null;
(async()=>{ trainedModels = await trainModelsIfPossible(); })(); // attempt train at startup (async)

async function predictForMatch(raw){
  // raw is api fixture object normalized
  // We'll build features and compute:
  // - BTTS probability (from model if available else heuristic)
  // - winner probabilities (home/draw/away) - model gives home prob, draw via odds or symmetric
  // - expected goals from team forms
  const home = raw.teams.home.name;
  const away = raw.teams.away.name;
  const kickoffLocal = moment.tz(raw.fixture.date, TIMEZONE).format("YYYY-MM-DD HH:mm");

  // compute forms
  const homeForm = await computeTeamForm(home, 30) || {avgGF:1, avgGA:1, winRate:45};
  const awayForm = await computeTeamForm(away, 30) || {avgGF:1, avgGA:1, winRate:40};

  // build feature vector as in training
  const feat = [homeForm.avgGF, homeForm.avgGA, awayForm.avgGF, awayForm.avgGA, homeForm.winRate/100, awayForm.winRate/100, (new Date(raw.fixture.date)).getUTCDay()/6];

  // model predictions
  let bttsProbModel = null, homeProbModel = null;
  if(trainedModels && trainedModels.modelBTTS){
    bttsProbModel = trainedModels.modelBTTS.predict(feat) * 100; // %
    homeProbModel = trainedModels.modelHome.predict(feat) * 100;
  }

  // heuristic BTTS
  // expected goals heuristic
  const egHome = +(homeForm.avgGF*0.6 + awayForm.avgGA*0.4 + 0.7).toFixed(2);
  const egAway = +(awayForm.avgGF*0.6 + homeForm.avgGA*0.4 + 0.6).toFixed(2);
  const totalExp = +(egHome + egAway).toFixed(2);

  // Poisson-based BTTS approximate: P(home>0 and away>0) ≈ (1 - P(home=0) - P(away=0) + P(both zero))
  const pHomeZero = Math.exp(-egHome);
  const pAwayZero = Math.exp(-egAway);
  const heurBTTS = clamp((1 - pHomeZero - pAwayZero + pHomeZero*pAwayZero) * 100, 1, 99);

  // Combine model + heuristic (if model exists give it weight)
  let bttsProb = bttsProbModel ? (bttsProbModel*0.6 + heurBTTS*0.4) : heurBTTS;

  // Winner probs: use odds if available else use forms
  let homeOdds=null, drawOdds=null, awayOdds=null;
  try {
    if(raw.odds && raw.odds.length && raw.odds[0].bookmakers && raw.odds[0].bookmakers[0].bets){
      // best-effort parse: look for 1X2
      const bets = raw.odds[0].bookmakers[0].bets;
      for(const b of bets){
        if(b.values && b.values.length>=3){
          homeOdds = parseFloat(b.values[0].odd); drawOdds = parseFloat(b.values[1].odd); awayOdds = parseFloat(b.values[2].odd);
          break;
        }
      }
    }
  } catch(e){}

  // fallback odds from forms
  if(!homeOdds) homeOdds = +(2.6 - (homeForm.winRate - awayForm.winRate)/100).toFixed(2);
  if(!awayOdds) awayOdds = +(2.6 + (homeForm.winRate - awayForm.winRate)/100).toFixed(2);
  if(!drawOdds) drawOdds = 3.3;

  const homeProbOdds = oddsToProb(homeOdds);
  const awayProbOdds = oddsToProb(awayOdds);
  const drawProbOdds = oddsToProb(drawOdds);

  // model home prob blended
  let homeProb = homeProbModel ? (homeProbModel*0.6 + homeProbOdds*0.4) : homeProbOdds;
  let awayProb = awayProbOdds;
  let drawProb = drawProbOdds;

  // normalize to sum approx 100
  const sum = homeProb + drawProb + awayProb;
  homeProb = +(homeProb / sum * 100).toFixed(2);
  drawProb = +(drawProb / sum * 100).toFixed(2);
  awayProb = +(awayProb / sum * 100).toFixed(2);

  // Over/Under markets 0.5..5.5
  const markets = [];
  for(let x=0.5; x<=5.5; x+=0.5){
    const k = Math.floor(x);
    const pOver = poissonTail(k, totalExp) * 100;
    markets.push({ market:`Over ${x}`, prob: Math.round(pOver*100)/100 });
  }
  const strongMarkets = markets.filter(m => m.prob >= 85);

  // last 10 min heuristic (use totalExp and status if live)
  let last10Prob = clamp(Math.round((totalExp/3)*30), 1, 95);

  // final prediction object
  const prediction = {
    home, away, league: raw.league.name,
    kickoffLocal,
    expectedGoals: { home: egHome, away: egAway, total: totalExp },
    winnerProb: { home: homeProb, draw: drawProb, away: awayProb },
    bttsProb: Math.round(bttsProb*100)/100,
    last10Prob,
    markets, strongMarkets,
    reasoning: { fromModel: !!trainedModels, homeModel: homeProbModel ? +(homeProbModel*100).toFixed(2) : null, bttsModel: bttsProbModel ? +(bttsProbModel).toFixed(2) : null }
  };

  return prediction;
}

// ----------------- FETCH TODAY MATCHES (API-Football) -----------------
async function getTodayFixtures(){
  try{
    recordHit("apiFootball");
    const today = moment().tz(TIMEZONE).format("YYYY-MM-DD");
    const r = await axios.get("https://v3.football.api-sports.io/fixtures", {
      headers: { "x-apisports-key": API_FOOTBALL_KEY },
      params: { date: today }
    });
    return r.data.response || [];
  }catch(err){
    console.log("❌ getTodayFixtures error:", err.message);
    return [];
  }
}

// ----------------- AGGREGATE: produce predictions for today's matches and save -----------------
async function runPredictionCycle(){
  try{
    const fixtures = await getTodayFixtures();
    // filter top leagues + world cup qualifier if present
    const TOP_LEAGUES = [2,3,39,61,78,135,140,141,848,556];
    const WORLD_QUAL = 1;
    const todays = fixtures.filter(f => TOP_LEAGUES.includes(f.league.id) || f.league.id === WORLD_QUAL);

    const results = [];
    for(const f of todays){
      const pred = await predictForMatch(f);
      // save into PredictionModel (upsert by sourceId)
      await PredictionModel.updateOne(
        { sourceId: String(f.fixture.id) },
        { $set: { sourceId: String(f.fixture.id), teams: `${pred.home} vs ${pred.away}`, matchDate: pred.kickoffLocal, prediction: pred } },
        { upsert:true }
      );
      results.push({ fixtureId: f.fixture.id, prediction: pred });
    }

    // broadcast via SSE clients
    broadcastLatest();

    console.log("✔ runPredictionCycle complete. Predictions:", results.length);
    return results;
  }catch(err){
    console.log("❌ runPredictionCycle error:", err.message);
    return null;
  }
}

// ----------------- BROADCAST / SSE CLIENTS -----------------
let sseClients = [];
function broadcastLatest(){
  (async()=>{
    try{
      const preds = await PredictionModel.find().sort({ createdAt:-1 }).limit(50).lean();
      const formatted = preds.map(p => ({ teams:p.teams, matchDate:p.matchDate, prediction:p.prediction }));
      const payload = JSON.stringify({ ts: Date.now(), matchesCount: formatted.length, matches: formatted, apiUsage });
      sseClients.forEach(res => {
        try { res.write(`data: ${payload}\n\n`); } catch(e){}
      });
    }catch(e){ console.log("❌ broadcastLatest error:", e.message); }
  })();
}

// ----------------- CRON: every 5 minutes (runs on startup too) -----------------
cron.schedule("*/5 * * * *", async () => {
  console.log("🔁 Cron triggered at", new Date().toLocaleString());
  await ingestPastResults(7).catch(()=>{}); // top-up recent history
  await runPredictionCycle();
});

// run once at startup
(async()=>{ await ingestPastResults(7).catch(()=>{}); await runPredictionCycle(); })();

// ----------------- ROUTES -----------------
app.use(express.static(__dirname));
app.get("/", (req,res)=> res.sendFile(path.join(__dirname,"index.html")));

// SSE endpoint
app.get("/events", (req, res) => {
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.flushHeaders && res.flushHeaders();

  sseClients.push(res);
  console.log("👤 SSE connected:", sseClients.length);

  // send one immediate update
  (async()=>{ try{ const preds = await PredictionModel.find().sort({ createdAt:-1 }).limit(50).lean();
      const formatted = preds.map(p=>({teams:p.teams,matchDate:p.matchDate,prediction:p.prediction}));
      res.write(`data: ${JSON.stringify({ ts: Date.now(), matchesCount: formatted.length, matches: formatted, apiUsage })}\n\n`);
  }catch(e){}})();

  req.on("close", () => {
    sseClients = sseClients.filter(r=>r!==res);
    console.log("❌ SSE disconnected. Count:", sseClients.length);
  });
});

// today matches for left panel (PKT)
app.get("/today", async (req,res) => {
  try{
    const fixtures = await getTodayFixtures();
    const TOP_LEAGUES = [2,3,39,61,78,135,140,141,848,556]; const WORLD_QUAL = 1;
    const list = fixtures.filter(f => TOP_LEAGUES.includes(f.league.id) || f.league.id===WORLD_QUAL)
      .map(f => ({
        league: f.league.name,
        home: f.teams.home.name,
        away: f.teams.away.name,
        kickoff: moment.tz(f.fixture.date, TIMEZONE).format("hh:mm A"),
        status: f.fixture.status.short
      }));
    res.json({ success:true, data: list });
  }catch(err){ res.json({ success:false, error: err.message }); }
});

// last snapshot simple
app.get("/prediction", async (req,res) => {
  const last = await PredictionModel.find().sort({ createdAt:-1 }).limit(50).lean();
  res.json({ ok:true, last });
});

// trigger now
app.get("/run-now", async (req,res) => {
  const r = await runPredictionCycle();
  if(!r) return res.status(500).json({ ok:false });
  res.json({ ok:true, count: r.length });
});

app.get("/api-usage", (req,res)=> res.json({ ok:true, apiUsage }));

// ----------------- START -----------------
app.listen(PORT, ()=> console.log(`🚀 Server running on port ${PORT}`));
