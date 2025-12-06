




// api se live matches fetch ker rha hy...or live predion kare ga..

import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// API Key
const API_KEY = process.env.API_FOOTBALL_KEY || 'fdab0eef5743173c30f9810bef3a6742';

const TOP_LEAGUES = {
  39: 'Premier League', 140: 'La Liga', 135: 'Serie A', 78: 'Bundesliga',
  61: 'Ligue 1', 94: 'Primeira Liga', 88: 'Eredivisie', 203: 'Super Lig'
};

let apiCalls = 0;
const API_LIMIT = 100;
const cache = new Map();
let sseClients = [];

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// MongoDB
const MONGO_URI = process.env.MONGO_PUBLIC_URL || process.env.MONGO_URI || 
                  'mongodb://localhost:27017/football-predictions';
let mongoConnected = false;

mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS: 45000
}).then(() => {
  console.log('✅ MongoDB Connected');
  mongoConnected = true;
}).catch(err => console.error('❌ MongoDB:', err.message));

// Schemas
const matchSchema = new mongoose.Schema({
  match_id: { type: String, required: true, unique: true },
  home_team: String,
  away_team: String,
  league: String,
  home_score: { type: Number, default: 0 },
  away_score: { type: Number, default: 0 },
  status: { type: String, default: 'NS' },
  match_time_pkt: String,
  match_date: Date,
  venue: String,
  current_minute: { type: Number, default: 0 },
  live_stats: Object,
  last_updated: { type: Date, default: Date.now }
}, { timestamps: true });

const predictionSchema = new mongoose.Schema({
  match_id: { type: String, required: true, unique: true },
  home_team: String,
  away_team: String,
  league: String,
  current_minute: Number,
  current_score: String,
  winner_prob: Object,
  most_likely_score: String,
  over_under: Object,
  btts_prob: Number,
  xG: Object,
  next_goal_likely: Boolean,
  next_goal_team: String,
  next_goal_probability: Number,
  momentum: String,
  live_insights: [String],
  value_bets: [Object],
  confidence_score: Number,
  confidence_level: String,
  prediction_version: Number,
  last_updated: Date
}, { timestamps: true });

const Match = mongoose.model('Match', matchSchema);
const Prediction = mongoose.model('Prediction', predictionSchema);

// Helpers
function convertStatus(s) {
  const map = {
    'NS': 'NS', 'TBD': 'NS', 'SCHEDULED': 'NS', 'TIMED': 'NS',
    'LIVE': 'LIVE', 'IN_PLAY': 'LIVE',
    '1H': '1H', 'HT': 'HT', '2H': '2H',
    'FT': 'FT', 'FINISHED': 'FT'
  };
  return map[s] || 'NS';
}

function toPakTime(d) {
  try {
    return new Date(d).toLocaleString('en-PK', {
      timeZone: 'Asia/Karachi',
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true
    });
  } catch { return 'TBA'; }
}

function getConfLevel(score) {
  if (score >= 80) return 'High';
  if (score >= 60) return 'Medium';
  return 'Low';
}

// SSE Broadcast
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(client => {
    try {
      client.write(msg);
      return true;
    } catch {
      return false;
    }
  });
  console.log(`📡 Broadcast ${event} to ${sseClients.length} clients`);
}

// Fetch from API-Football
async function fetchMatches() {
  try {
    console.log('\n🔄 Fetching matches...');
    
    if (apiCalls >= API_LIMIT) {
      console.log('⚠️ API limit reached');
      return [];
    }
    
    const today = new Date().toISOString().split('T')[0];
    
    const res = await fetch(
      `https://v3.football.api-sports.io/fixtures?date=${today}`,
      {
        headers: {
          'x-rapidapi-key': API_KEY,
          'x-rapidapi-host': 'v3.football.api-sports.io'
        },
        signal: AbortSignal.timeout(15000)
      }
    );
    
    apiCalls++;
    
    if (!res.ok) {
      console.log(`❌ API Error: ${res.status}`);
      return [];
    }
    
    const data = await res.json();
    
    if (!data.response || data.response.length === 0) {
      console.log('⚠️ No matches found');
      return [];
    }
    
    const filtered = data.response.filter(f => 
      Object.keys(TOP_LEAGUES).includes(String(f.league.id))
    );
    
    console.log(`✅ Found ${filtered.length} matches from target leagues`);
    
    const matches = filtered.map(f => ({
      match_id: `af_${f.fixture.id}`,
      home_team: f.teams.home.name,
      away_team: f.teams.away.name,
      league: f.league.name,
      home_score: f.goals.home || 0,
      away_score: f.goals.away || 0,
      status: convertStatus(f.fixture.status.short),
      match_time_pkt: toPakTime(f.fixture.date),
      match_date: new Date(f.fixture.date),
      venue: f.fixture.venue?.name || 'TBA',
      current_minute: f.fixture.status.elapsed || 0,
      last_updated: new Date()
    }));
    
    for (const m of matches) {
      await Match.findOneAndUpdate(
        { match_id: m.match_id },
        m,
        { upsert: true, new: true }
      );
    }
    
    broadcast('matchesUpdate', { count: matches.length });
    
    return matches;
    
  } catch (err) {
    console.error('❌ Fetch error:', err.message);
    return [];
  }
}

// Fetch Live Stats
async function fetchLiveStats(fixtureId) {
  try {
    if (apiCalls >= API_LIMIT) return null;
    
    const cacheKey = `stats_${fixtureId}`;
    if (cache.has(cacheKey)) {
      const cached = cache.get(cacheKey);
      if (Date.now() - cached.timestamp < 120000) return cached.data;
    }
    
    const res = await fetch(
      `https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}`,
      {
        headers: {
          'x-rapidapi-key': API_KEY,
          'x-rapidapi-host': 'v3.football.api-sports.io'
        },
        signal: AbortSignal.timeout(10000)
      }
    );
    
    apiCalls++;
    
    if (!res.ok) return null;
    
    const data = await res.json();
    if (!data?.response || data.response.length === 0) return null;
    
    const hStats = data.response[0]?.statistics || [];
    const aStats = data.response[1]?.statistics || [];
    
    const getStat = (list, type) => {
      const stat = list.find(s => s.type === type);
      if (!stat || stat.value === null) return 0;
      return typeof stat.value === 'string' ? 
        parseInt(stat.value.replace('%', '')) || 0 : stat.value || 0;
    };
    
    const stats = {
      shots_total: { home: getStat(hStats, 'Total Shots'), away: getStat(aStats, 'Total Shots') },
      shots_on_target: { home: getStat(hStats, 'Shots on Goal'), away: getStat(aStats, 'Shots on Goal') },
      shots_inside_box: { home: getStat(hStats, 'Shots insidebox'), away: getStat(aStats, 'Shots insidebox') },
      possession: { home: getStat(hStats, 'Ball Possession'), away: getStat(aStats, 'Ball Possession') },
      corners: { home: getStat(hStats, 'Corner Kicks'), away: getStat(aStats, 'Corner Kicks') },
      yellow_cards: { home: getStat(hStats, 'Yellow Cards'), away: getStat(aStats, 'Yellow Cards') },
      red_cards: { home: getStat(hStats, 'Red Cards'), away: getStat(aStats, 'Red Cards') },
      attacks: { home: getStat(hStats, 'Total Attacks'), away: getStat(aStats, 'Total Attacks') },
      dangerous_attacks: { home: getStat(hStats, 'Dangerous Attacks'), away: getStat(aStats, 'Dangerous Attacks') }
    };
    
    cache.set(cacheKey, { data: stats, timestamp: Date.now() });
    return stats;
    
  } catch (err) {
    console.error('❌ Stats error:', err.message);
    return null;
  }
}

// Prediction Algorithm
async function calculatePrediction(match) {
  try {
    const prev = await Prediction.findOne({ match_id: match.match_id });
    
    let score = 50;
    let xGH = 0, xGA = 0;
    let nextGoalProb = 0, nextGoalTeam = 'neutral';
    let momentum = 'neutral';
    
    if (match.live_stats) {
      const s = match.live_stats;
      
      const possDiff = (s.possession?.home || 50) - (s.possession?.away || 50);
      score += possDiff * 0.4;
      
      const shotsDiff = (s.shots_on_target?.home || 0) - (s.shots_on_target?.away || 0);
      score += shotsDiff * 4;
      
      xGH = ((s.shots_on_target?.home || 0) * 0.35) + 
            ((s.shots_inside_box?.home || 0) * 0.25) +
            ((s.dangerous_attacks?.home || 0) * 0.015);
            
      xGA = ((s.shots_on_target?.away || 0) * 0.35) + 
            ((s.shots_inside_box?.away || 0) * 0.25) +
            ((s.dangerous_attacks?.away || 0) * 0.015);
      
      score += (xGH - xGA) * 8;
      
      if (match.current_minute > 15) {
        const dom = shotsDiff + (s.attacks?.home || 0) - (s.attacks?.away || 0);
        if (dom > 8) { momentum = 'home'; score += 10; }
        else if (dom < -8) { momentum = 'away'; score -= 10; }
      }
      
      const totalXg = xGH + xGA;
      if (totalXg > 1.0) {
        nextGoalProb = Math.min(90, totalXg * 35);
        nextGoalTeam = xGH > xGA ? 'home' : 'away';
      }
    }
    
    score = Math.max(20, Math.min(80, score));
    
    let homeProb = Math.max(15, Math.min(75, score));
    let awayProb = Math.max(15, Math.min(75, 100 - score - 20));
    let drawProb = 100 - homeProb - awayProb;
    
    if (match.home_score > match.away_score) {
      homeProb += 12; awayProb -= 8; drawProb -= 4;
    } else if (match.away_score > match.home_score) {
      awayProb += 12; homeProb -= 8; drawProb -= 4;
    }
    
    // Normalize
    const total = homeProb + drawProb + awayProb;
    homeProb = Math.round((homeProb / total) * 100);
    drawProb = Math.round((drawProb / total) * 100);
    awayProb = 100 - homeProb - drawProb;
    
    const totalXg = xGH + xGA;
    const curGoals = match.home_score + match.away_score;
    
    const overUnder = {
      '0.5': Math.min(98, 80 + (totalXg * 8) + (curGoals > 0 ? 18 : 0)),
      '1.5': Math.min(96, 60 + (totalXg * 12) + (curGoals > 1 ? 25 : curGoals * 10)),
      '2.5': Math.min(92, 40 + (totalXg * 15) + (curGoals > 2 ? 30 : curGoals * 8)),
      '3.5': Math.min(85, 25 + (totalXg * 12) + (curGoals > 3 ? 35 : curGoals * 6)),
      '4.5': Math.min(75, 15 + (totalXg * 8) + (curGoals > 4 ? 40 : curGoals * 4)),
      '5.5': Math.min(65, 8 + (totalXg * 5) + (curGoals > 5 ? 45 : curGoals * 3))
    };
    
    const btts = Math.round(
      40 +
      (xGH > 0.6 ? 15 : 0) +
      (xGA > 0.6 ? 15 : 0) +
      ((match.live_stats?.shots_on_target?.home || 0) > 3 ? 10 : 0) +
      ((match.live_stats?.shots_on_target?.away || 0) > 3 ? 10 : 0) +
      (match.home_score > 0 && match.away_score > 0 ? 20 : 0)
    );
    
    const predScore = `${Math.round(xGH) + match.home_score}-${Math.round(xGA) + match.away_score}`;
    
    let conf = 50;
    if (match.live_stats) conf += 30;
    const totalShots = (match.live_stats?.shots_total?.home || 0) + 
                       (match.live_stats?.shots_total?.away || 0);
    if (totalShots > 15) conf += 15;
    else if (totalShots > 8) conf += 10;
    
    conf = Math.max(40, Math.min(100, conf));
    
    const insights = [];
    if (nextGoalProb > 65) insights.push(`⚡ Goal expected soon (${Math.round(nextGoalProb)}%)`);
    if (momentum !== 'neutral') insights.push(`📈 Strong ${momentum} momentum`);
    if (totalXg > 3.0) insights.push('🎯 High scoring match expected');
    
    const prediction = {
      match_id: match.match_id,
      home_team: match.home_team,
      away_team: match.away_team,
      league: match.league,
      current_minute: match.current_minute,
      current_score: `${match.home_score}-${match.away_score}`,
      
      winner_prob: {
        home: { value: homeProb, trend: '─', change: prev ? homeProb - (prev.winner_prob?.home?.value || homeProb) : 0 },
        draw: { value: drawProb, trend: '─', change: prev ? drawProb - (prev.winner_prob?.draw?.value || drawProb) : 0 },
        away: { value: awayProb, trend: '─', change: prev ? awayProb - (prev.winner_prob?.away?.value || awayProb) : 0 }
      },
      
      most_likely_score: predScore,
      over_under: overUnder,
      btts_prob: Math.min(95, btts),
      
      xG: {
        home: Number(xGH.toFixed(2)),
        away: Number(xGA.toFixed(2)),
        total: Number((xGH + xGA).toFixed(2))
      },
      
      next_goal_likely: nextGoalProb > 50,
      next_goal_team: nextGoalTeam,
      next_goal_probability: Math.round(nextGoalProb),
      momentum: momentum,
      
      live_insights: insights,
      value_bets: [],
      
      confidence_score: Math.round(conf),
      confidence_level: getConfLevel(conf),
      
      prediction_version: (prev?.prediction_version || 0) + 1,
      last_updated: new Date()
    };
    
    return prediction;
    
  } catch (err) {
    console.error('❌ Prediction error:', err.message);
    return null;
  }
}

// Update Live Matches
async function updateLiveMatches() {
  if (!mongoConnected) return;
  
  try {
    console.log('\n⚡ Updating live matches...');
    
    const live = await Match.find({
      status: { $in: ['1H', '2H', 'HT', 'LIVE'] }
    });
    
    console.log(`📊 ${live.length} live matches`);
    
    for (const m of live) {
      const fixId = m.match_id.replace('af_', '');
      const stats = await fetchLiveStats(fixId);
      
      if (stats) {
        m.live_stats = stats;
        m.last_updated = new Date();
        await m.save();
        console.log(`✅ Updated: ${m.home_team} vs ${m.away_team}`);
      }
    }
    
    broadcast('liveStatsUpdate', { count: live.length, timestamp: new Date() });
    
  } catch (err) {
    console.error('❌ Update error:', err.message);
  }
}

// Generate Predictions
async function generatePredictions() {
  if (!mongoConnected) return;
  
  try {
    console.log('\n🎯 Generating predictions...');
    
    const matches = await Match.find({
      status: { $in: ['NS', '1H', '2H', 'HT', 'LIVE'] }
    }).limit(50);
    
    console.log(`📊 ${matches.length} matches`);
    
    let count = 0;
    
    for (const m of matches) {
      const pred = await calculatePrediction(m);
      
      if (pred) {
        await Prediction.findOneAndUpdate(
          { match_id: m.match_id },
          pred,
          { upsert: true, new: true }
        );
        count++;
        console.log(`✅ ${m.home_team} vs ${m.away_team} (${pred.confidence_score}%)`);
      }
    }
    
    console.log(`\n✅ Generated ${count} predictions`);
    
    broadcast('newPredictions', { count, timestamp: new Date() });
    
  } catch (err) {
    console.error('❌ Generation error:', err.message);
  }
}

// Routes
app.get('/api/live-stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  
  sseClients.push(res);
  console.log(`📡 SSE client connected. Total: ${sseClients.length}`);
  
  res.write(`data: ${JSON.stringify({ message: 'Connected' })}\n\n`);
  
  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
    console.log(`📡 Client disconnected. Remaining: ${sseClients.length}`);
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    mongodb: mongoConnected,
    apiCalls: `${apiCalls}/${API_LIMIT}`,
    clients: sseClients.length
  });
});

app.get('/api/matches', async (req, res) => {
  try {
    if (!mongoConnected) {
      return res.status(503).json({ success: false, error: 'DB offline' });
    }
    
    const matches = await Match.find({
      status: { $in: ['NS', 'LIVE', '1H', '2H', 'HT'] }
    }).sort({ match_date: 1 }).limit(100);
    
    res.json({ success: true, count: matches.length, data: matches });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/predictions', async (req, res) => {
  try {
    if (!mongoConnected) {
      return res.status(503).json({ success: false, error: 'DB offline' });
    }
    
    const preds = await Prediction.find()
      .sort({ confidence_score: -1, updatedAt: -1 })
      .limit(100);
    
    res.json({ success: true, count: preds.length, data: preds });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Auto Tasks
setTimeout(async () => {
  if (!mongoConnected) {
    let attempts = 0;
    while (!mongoConnected && attempts < 30) {
      await new Promise(r => setTimeout(r, 1000));
      attempts++;
    }
  }
  
  if (mongoConnected) {
    console.log('🚀 Initial fetch...');
    await fetchMatches();
    await generatePredictions();
    console.log('✅ Initial setup complete');
  }
}, 10000);

setInterval(updateLiveMatches, 2 * 60 * 1000); // 2 min
setInterval(generatePredictions, 5 * 60 * 1000); // 5 min
setInterval(() => mongoConnected && fetchMatches(), 15 * 60 * 1000); // 15 min

setInterval(() => {
  if (sseClients.length > 0) {
    sseClients.forEach(c => {
      try { c.write(': ping\n\n'); } catch {}
    });
  }
}, 30000);

// Start
app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║  ⚽ LIVE PREDICTION SYSTEM ⚽          ║');
  console.log('║                                        ║');
  console.log(`║  🚀 Server: http://localhost:${PORT}  ║`);
  console.log('║  📡 SSE: /api/live-stream             ║');
  console.log('║  🎯 Predictions: Every 5 min          ║');
  console.log('║  ⚡ Live Stats: Every 2 min           ║');
  console.log('╚════════════════════════════════════════╝\n');
});

process.on('SIGTERM', async () => {
  sseClients.forEach(c => c.end());
  if (mongoConnected) await mongoose.connection.close();
  process.exit(0);
});
