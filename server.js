


import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// ==================== API CONFIGURATION ====================
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || 'fdab0eef5743173c30f9810bef3a6742';
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY || '62207494b8a241db93aee4c14b7c1266';

const TOP_LEAGUES = {
  39: 'Premier League', 140: 'La Liga', 135: 'Serie A', 78: 'Bundesliga',
  61: 'Ligue 1', 94: 'Primeira Liga', 88: 'Eredivisie', 203: 'Super Lig'
};

let apiFootballCalls = 0;
let footballDataCalls = 0;
const API_FOOTBALL_LIMIT = 100;
const FOOTBALL_DATA_LIMIT = 50;

const statsCache = new Map();
const latestPredictions = [];
let sseClients = []; // Store SSE connections

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// MongoDB
const MONGODB_URI = process.env.MONGO_PUBLIC_URL || process.env.MONGO_URI || 
                    'mongodb://localhost:27017/football-predictions';
let isMongoConnected = false;

mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS: 45000
})
.then(() => {
  console.log('✅ MongoDB Connected!');
  isMongoConnected = true;
})
.catch(err => console.error('❌ MongoDB Error:', err.message));

// ==================== SCHEMAS ====================
const matchSchema = new mongoose.Schema({
  match_id: { type: String, required: true, unique: true },
  home_team: { type: String, required: true },
  away_team: { type: String, required: true },
  league: String,
  home_score: { type: Number, default: 0 },
  away_score: { type: Number, default: 0 },
  status: { type: String, default: 'NS' },
  match_time_pkt: String,
  match_date: Date,
  venue: String,
  current_minute: { type: Number, default: 0 },
  live_stats: {
    shots_total: { home: Number, away: Number },
    shots_on_target: { home: Number, away: Number },
    shots_inside_box: { home: Number, away: Number },
    possession: { home: Number, away: Number },
    corners: { home: Number, away: Number },
    yellow_cards: { home: Number, away: Number },
    red_cards: { home: Number, away: Number },
    attacks: { home: Number, away: Number },
    dangerous_attacks: { home: Number, away: Number }
  },
  last_updated: { type: Date, default: Date.now }
}, { timestamps: true });

const predictionSchema = new mongoose.Schema({
  match_id: { type: String, required: true, unique: true },
  home_team: String,
  away_team: String,
  league: String,
  current_minute: Number,
  current_score: String,
  winner_prob: {
    home: { value: Number, trend: String, change: Number },
    draw: { value: Number, trend: String, change: Number },
    away: { value: Number, trend: String, change: Number }
  },
  most_likely_score: String,
  over_under: {
    '0.5': Number, '1.5': Number, '2.5': Number, 
    '3.5': Number, '4.5': Number, '5.5': Number
  },
  btts_prob: Number,
  xG: { home: Number, away: Number, total: Number },
  next_goal_likely: Boolean,
  next_goal_team: String,
  next_goal_probability: Number,
  momentum: String,
  momentum_strength: Number,
  live_insights: [String],
  value_bets: [{ market: String, probability: Number, recommendation: String }],
  confidence_score: Number,
  confidence_level: String,
  red_card_impact: Boolean,
  prediction_version: Number,
  last_updated: Date
}, { timestamps: true });

const Match = mongoose.model('Match', matchSchema);
const Prediction = mongoose.model('Prediction', predictionSchema);

// ==================== HELPER FUNCTIONS ====================
function convertStatus(status) {
  const map = {
    'NS': 'NS', 'TBD': 'NS', 'SCHEDULED': 'NS', 'TIMED': 'NS',
    'LIVE': 'LIVE', 'IN_PLAY': 'LIVE',
    '1H': '1H', 'HT': 'HT', '2H': '2H',
    'FT': 'FT', 'FINISHED': 'FT', 'AET': 'FT', 'PEN': 'FT'
  };
  return map[status] || 'NS';
}

function toPakistanTime(dateString) {
  try {
    return new Date(dateString).toLocaleString('en-PK', {
      timeZone: 'Asia/Karachi',
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true
    });
  } catch { return 'Time TBA'; }
}

function getTrend(current, previous) {
  if (!previous) return '─';
  const diff = current - previous;
  if (diff > 5) return '▲▲';
  if (diff > 2) return '▲';
  if (diff < -5) return '▼▼';
  if (diff < -2) return '▼';
  return '─';
}

function getConfidenceLevel(score) {
  if (score >= 80) return 'High';
  if (score >= 60) return 'Medium';
  return 'Low';
}

// ==================== SSE PUSH SYSTEM ====================
function broadcastToClients(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((client, index) => {
    try {
      client.write(message);
    } catch (error) {
      console.log(`❌ SSE client ${index} disconnected`);
      sseClients.splice(index, 1);
    }
  });
  console.log(`📡 Broadcasted ${event} to ${sseClients.length} clients`);
}

// ==================== FETCH FROM API-FOOTBALL ====================
async function fetchFromApiFootball() {
  try {
    console.log('\n🌐 Fetching from API-Football...');
    console.log(`📊 API Calls: ${apiFootballCalls}/${API_FOOTBALL_LIMIT}`);
    
    if (apiFootballCalls >= API_FOOTBALL_LIMIT) {
      console.log('⚠️ API-Football limit reached');
      return [];
    }
    
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 24*60*60*1000).toISOString().split('T')[0];
    
    console.log('📅 Fetching:', today, '&', tomorrow);
    
    let allMatches = [];
    
    for (const date of [today, tomorrow]) {
      if (apiFootballCalls >= API_FOOTBALL_LIMIT) break;
      
      console.log(`\n🔍 Fetching ${date}...`);
      
      try {
        const response = await fetch(
          `https://v3.football.api-sports.io/fixtures?date=${date}`,
          {
            headers: {
              'x-rapidapi-key': API_FOOTBALL_KEY,
              'x-rapidapi-host': 'v3.football.api-sports.io'
            },
            signal: AbortSignal.timeout(15000)
          }
        );
        
        apiFootballCalls++;
        
        if (!response.ok) {
          console.log(`❌ API Error: ${response.status}`);
          continue;
        }
        
        const data = await response.json();
        
        if (!data.response || data.response.length === 0) {
          console.log(`⚠️ No matches for ${date}`);
          continue;
        }
        
        console.log(`✅ Found ${data.response.length} total matches`);
        
        const filtered = data.response.filter(f => 
          Object.keys(TOP_LEAGUES).includes(String(f.league.id))
        );
        
        console.log(`🎯 Filtered: ${filtered.length} from target leagues`);
        
        const breakdown = {};
        filtered.forEach(f => {
          const name = f.league.name;
          breakdown[name] = (breakdown[name] || 0) + 1;
        });
        
        Object.entries(breakdown).forEach(([league, count]) => {
          console.log(`   📌 ${league}: ${count}`);
        });
        
        const matches = filtered.map(f => ({
          match_id: `af_${f.fixture.id}`,
          home_team: f.teams.home.name,
          away_team: f.teams.away.name,
          league: f.league.name,
          home_score: f.goals.home || 0,
          away_score: f.goals.away || 0,
          status: convertStatus(f.fixture.status.short),
          match_time_pkt: toPakistanTime(f.fixture.date),
          match_date: new Date(f.fixture.date),
          venue: f.fixture.venue?.name || 'Unknown',
          current_minute: f.fixture.status.elapsed || 0,
          last_updated: new Date()
        }));
        
        allMatches = [...allMatches, ...matches];
        
      } catch (error) {
        console.error(`❌ Fetch error for ${date}:`, error.message);
      }
    }
    
    console.log(`\n✅ API-Football Total: ${allMatches.length}`);
    return allMatches;
    
  } catch (error) {
    console.error('❌ API-Football Error:', error.message);
    return [];
  }
}

// ==================== FETCH LIVE STATS ====================
async function fetchLiveStatistics(fixtureId) {
  try {
    if (apiFootballCalls >= API_FOOTBALL_LIMIT) return null;
    
    const cacheKey = `stats_${fixtureId}`;
    if (statsCache.has(cacheKey)) {
      const cached = statsCache.get(cacheKey);
      if (Date.now() - cached.timestamp < 120000) {
        return cached.data;
      }
    }
    
    const response = await fetch(
      `https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}`,
      {
        headers: {
          'x-rapidapi-key': API_FOOTBALL_KEY,
          'x-rapidapi-host': 'v3.football.api-sports.io'
        },
        signal: AbortSignal.timeout(10000)
      }
    );
    
    apiFootballCalls++;
    
    if (!response.ok) return null;
    
    const data = await response.json();
    
    if (!data?.response || data.response.length === 0) return null;
    
    const homeStats = data.response[0]?.statistics || [];
    const awayStats = data.response[1]?.statistics || [];
    
    const getStat = (statsList, type) => {
      const stat = statsList.find(s => s.type === type);
      if (!stat || stat.value === null) return 0;
      if (typeof stat.value === 'string') {
        return parseInt(stat.value.replace('%', '')) || 0;
      }
      return stat.value || 0;
    };
    
    const stats = {
      shots_total: {
        home: getStat(homeStats, 'Total Shots'),
        away: getStat(awayStats, 'Total Shots')
      },
      shots_on_target: {
        home: getStat(homeStats, 'Shots on Goal'),
        away: getStat(awayStats, 'Shots on Goal')
      },
      shots_inside_box: {
        home: getStat(homeStats, 'Shots insidebox'),
        away: getStat(awayStats, 'Shots insidebox')
      },
      possession: {
        home: getStat(homeStats, 'Ball Possession'),
        away: getStat(awayStats, 'Ball Possession')
      },
      corners: {
        home: getStat(homeStats, 'Corner Kicks'),
        away: getStat(awayStats, 'Corner Kicks')
      },
      yellow_cards: {
        home: getStat(homeStats, 'Yellow Cards'),
        away: getStat(awayStats, 'Yellow Cards')
      },
      red_cards: {
        home: getStat(homeStats, 'Red Cards'),
        away: getStat(awayStats, 'Red Cards')
      },
      attacks: {
        home: getStat(homeStats, 'Total Attacks'),
        away: getStat(awayStats, 'Total Attacks')
      },
      dangerous_attacks: {
        home: getStat(homeStats, 'Dangerous Attacks'),
        away: getStat(awayStats, 'Dangerous Attacks')
      }
    };
    
    statsCache.set(cacheKey, { data: stats, timestamp: Date.now() });
    
    return stats;
    
  } catch (error) {
    console.error('❌ Live stats error:', error.message);
    return null;
  }
}

// ==================== PREDICTION ALGORITHM ====================
async function calculateAdvancedPrediction(match) {
  try {
    const prevPrediction = await Prediction.findOne({ match_id: match.match_id });
    
    let realtimeScore = 50;
    let xG_home = 0, xG_away = 0;
    let nextGoalProb = 0, nextGoalTeam = 'neutral';
    let momentum = 'neutral', momentumStrength = 0;
    
    if (match.live_stats) {
      const stats = match.live_stats;
      
      const possDiff = (stats.possession?.home || 50) - (stats.possession?.away || 50);
      realtimeScore += possDiff * 0.4;
      
      const shotsDiff = (stats.shots_on_target?.home || 0) - (stats.shots_on_target?.away || 0);
      realtimeScore += shotsDiff * 4;
      
      xG_home = ((stats.shots_on_target?.home || 0) * 0.35) + 
                ((stats.shots_inside_box?.home || 0) * 0.25) +
                ((stats.dangerous_attacks?.home || 0) * 0.015);
                
      xG_away = ((stats.shots_on_target?.away || 0) * 0.35) + 
                ((stats.shots_inside_box?.away || 0) * 0.25) +
                ((stats.dangerous_attacks?.away || 0) * 0.015);
      
      const xGDiff = xG_home - xG_away;
      realtimeScore += xGDiff * 8;
      
      if (match.current_minute > 15) {
        const recentDominance = shotsDiff + (stats.attacks?.home || 0) - (stats.attacks?.away || 0);
        if (recentDominance > 8) {
          momentum = 'home';
          momentumStrength = Math.min(100, recentDominance * 4);
          realtimeScore += 10;
        } else if (recentDominance < -8) {
          momentum = 'away';
          momentumStrength = Math.min(100, Math.abs(recentDominance) * 4);
          realtimeScore -= 10;
        }
      }
      
      const totalXg = xG_home + xG_away;
      if (totalXg > 1.0) {
        nextGoalProb = Math.min(90, totalXg * 35);
        nextGoalTeam = xG_home > xG_away ? 'home' : 'away';
      }
    }
    
    realtimeScore = Math.max(20, Math.min(80, realtimeScore));
    
    let homeProb = Math.max(15, Math.min(75, realtimeScore));
    let awayProb = Math.max(15, Math.min(75, 100 - realtimeScore - 20));
    let drawProb = 100 - homeProb - awayProb;
    
    if (match.home_score > match.away_score) {
      homeProb += 12; awayProb -= 8; drawProb -= 4;
    } else if (match.away_score > match.home_score) {
      awayProb += 12; homeProb -= 8; drawProb -= 4;
    }
    
    let redCardImpact = false;
    if (match.live_stats?.red_cards?.home > 0) {
      homeProb -= 20; awayProb += 15; drawProb += 5; redCardImpact = true;
    }
    if (match.live_stats?.red_cards?.away > 0) {
      awayProb -= 20; homeProb += 15; drawProb += 5; redCardImpact = true;
    }
    
    const total = homeProb + drawProb + awayProb;
    homeProb = Math.round((homeProb / total) * 100);
    drawProb = Math.round((drawProb / total) * 100);
    awayProb = 100 - homeProb - drawProb;
    
    const totalXg = xG_home + xG_away;
    const currentGoals = match.home_score + match.away_score;
    
    const overUnder = {
      '0.5': Math.min(98, 80 + (totalXg * 8) + (currentGoals > 0 ? 18 : 0)),
      '1.5': Math.min(96, 60 + (totalXg * 12) + (currentGoals > 1 ? 25 : currentGoals * 10)),
      '2.5': Math.min(92, 40 + (totalXg * 15) + (currentGoals > 2 ? 30 : currentGoals * 8)),
      '3.5': Math.min(85, 25 + (totalXg * 12) + (currentGoals > 3 ? 35 : currentGoals * 6)),
      '4.5': Math.min(75, 15 + (totalXg * 8) + (currentGoals > 4 ? 40 : currentGoals * 4)),
      '5.5': Math.min(65, 8 + (totalXg * 5) + (currentGoals > 5 ? 45 : currentGoals * 3))
    };
    
    const bttsProb = Math.round(
      40 +
      (xG_home > 0.6 ? 15 : 0) +
      (xG_away > 0.6 ? 15 : 0) +
      ((match.live_stats?.shots_on_target?.home || 0) > 3 ? 10 : 0) +
      ((match.live_stats?.shots_on_target?.away || 0) > 3 ? 10 : 0) +
      (match.home_score > 0 && match.away_score > 0 ? 20 : 0)
    );
    
    const predictedHomeGoals = Math.round(xG_home) + match.home_score;
    const predictedAwayGoals = Math.round(xG_away) + match.away_score;
    const mostLikelyScore = `${predictedHomeGoals}-${predictedAwayGoals}`;
    
    let confidenceScore = 50;
    if (match.live_stats) confidenceScore += 30;
    const totalShots = (match.live_stats?.shots_total?.home || 0) + 
                      (match.live_stats?.shots_total?.away || 0);
    if (totalShots > 15) confidenceScore += 15;
    else if (totalShots > 8) confidenceScore += 10;
    
    confidenceScore = Math.max(40, Math.min(100, confidenceScore));
    
    const insights = [];
    if (nextGoalProb > 65) {
      insights.push(`⚡ Goal expected soon (${Math.round(nextGoalProb)}% probability)`);
    }
    if (momentumStrength > 75) {
      insights.push(`📈 Strong ${momentum} team momentum`);
    }
    if (redCardImpact) {
      insights.push('🟥 Red card impact detected');
    }
    if (totalXg > 3.0) {
      insights.push('🎯 High scoring match expected');
    }
    
    const valueBets = [];
    if (homeProb > 70 && confidenceScore > 75) {
      valueBets.push({
        market: 'Home Win',
        probability: homeProb,
        recommendation: 'Strong Value'
      });
    }
    if (overUnder['2.5'] > 75 && confidenceScore > 70) {
      valueBets.push({
        market: 'Over 2.5 Goals',
        probability: Math.round(overUnder['2.5']),
        recommendation: 'Good Value'
      });
    }
    
    const prediction = {
      match_id: match.match_id,
      home_team: match.home_team,
      away_team: match.away_team,
      league: match.league,
      current_minute: match.current_minute,
      current_score: `${match.home_score}-${match.away_score}`,
      
      winner_prob: {
        home: {
          value: homeProb,
          trend: getTrend(homeProb, prevPrediction?.winner_prob?.home?.value),
          change: prevPrediction ? homeProb - prevPrediction.winner_prob.home.value : 0
        },
        draw: {
          value: drawProb,
          trend: getTrend(drawProb, prevPrediction?.winner_prob?.draw?.value),
          change: prevPrediction ? drawProb - prevPrediction.winner_prob.draw.value : 0
        },
        away: {
          value: awayProb,
          trend: getTrend(awayProb, prevPrediction?.winner_prob?.away?.value),
          change: prevPrediction ? awayProb - prevPrediction.winner_prob.away.value : 0
        }
      },
      
      most_likely_score: mostLikelyScore,
      over_under: overUnder,
      btts_prob: Math.min(95, bttsProb),
      
      xG: {
        home: Number(xG_home.toFixed(2)),
        away: Number(xG_away.toFixed(2)),
        total: Number((xG_home + xG_away).toFixed(2))
      },
      
      next_goal_likely: nextGoalProb > 50,
      next_goal_team: nextGoalTeam,
      next_goal_probability: Math.round(nextGoalProb),
      momentum: momentum,
      momentum_strength: Math.round(momentumStrength),
      
      live_insights: insights,
      value_bets: valueBets,
      
      confidence_score: Math.round(confidenceScore),
      confidence_level: getConfidenceLevel(confidenceScore),
      red_card_impact: redCardImpact,
      
      prediction_version: (prevPrediction?.prediction_version || 0) + 1,
      last_updated: new Date()
    };
    
    return prediction;
    
  } catch (error) {
    console.error('❌ Prediction error:', error.message);
    return null;
  }
}

// ==================== FETCH & UPDATE MATCHES ====================
async function fetchAllMatches() {
  console.log('\n🔄 ============ FETCHING ALL MATCHES ============');
  
  if (!isMongoConnected) return [];
  
  const matches = await fetchFromApiFootball();
  
  if (matches.length === 0) {
    console.log('⚠️ No matches found');
    return [];
  }
  
  // Save to database
  for (const match of matches) {
    await Match.findOneAndUpdate(
      { match_id: match.match_id },
      match,
      { upsert: true, new: true }
    );
  }
  
  console.log(`✅ Saved ${matches.length} matches to database`);
  
  // Broadcast to clients
  broadcastToClients('matchesUpdate', {
    count: matches.length,
    matches: matches.slice(0, 10) // Send first 10
  });
  
  return matches;
}

async function updateLiveMatches() {
  if (!isMongoConnected) return;
  
  try {
    console.log('\n⚡ Updating LIVE matches...');
    
    const liveMatches = await Match.find({
      status: { $in: ['1H', '2H', 'HT', 'LIVE'] }
    });
    
    console.log(`📊 ${liveMatches.length} live matches found`);
    
    for (const match of liveMatches) {
      const fixtureId = match.match_id.replace('af_', '');
      const liveStats = await fetchLiveStatistics(fixtureId);
      
      if (liveStats) {
        match.live_stats = liveStats;
        match.last_updated = new Date();
        await match.save();
        
        console.log(`✅ Updated stats: ${match.home_team} vs ${match.away_team}`);
      }
    }
    
    // Broadcast live stats update
    broadcastToClients('liveStatsUpdate', {
      count: liveMatches.length,
      timestamp: new Date()
    });
    
    console.log('✅ Live updates complete\n');
  } catch (error) {
    console.error('❌ Live update error:', error.message);
  }
}

async function generateAndPushPredictions() {
  if (!isMongoConnected) return;
  
  try {
    console.log('\n🎯 ============ GENERATING PREDICTIONS ============');
    
    const matches = await Match.find({
      status: { $in: ['NS', '1H', '2H', 'HT', 'LIVE'] }
    }).limit(50);
    
    console.log(`📊 Generating predictions for ${matches.length} matches`);
    
    let generatedCount = 0;
    
    for (const match of matches) {
      const prediction = await calculateAdvancedPrediction(match);
      
      if (prediction) {
        await Prediction.findOneAndUpdate(
          { match_id: match.match_id },
          prediction,
          { upsert: true, new: true }
        );
        
        latestPredictions.unshift({
          ...prediction,
          timestamp: new Date()
        });
        
        if (latestPredictions.length > 50) {
          latestPredictions.pop();
        }
        
        generatedCount++;
        
        console.log(`✅ Prediction: ${match.home_team} vs ${match.away_team} (${prediction.confidence_score}%)`);
      }
    }
    
    console.log(`\n✅ Generated ${generatedCount} predictions`);
    
    // Broadcast predictions to all clients
    broadcastToClients('newPredictions', {
      count: generatedCount,
      predictions: latestPredictions.slice(0, 5),
      timestamp: new Date()
    });
    
  } catch (error) {
    console.error('❌ Prediction generation error:', error.message);
  }
}

// ==================== API ROUTES ====================

// SSE endpoint for real-time updates
app.get('/api/live-stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  
  sseClients.push(res);
  
  console.log(`📡 New SSE client connected. Total: ${sseClients.length}`);
  
  res.write(`data: ${JSON.stringify({ message: 'Connected to live stream' })}\n\n`);
  
  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
    console.log(`📡 SSE client disconnected. Remaining: ${sseClients.length}`);
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    mongodb: isMongoConnected ? 'Connected' : 'Disconnected',
    apiCalls: `${apiFootballCalls}/${API_FOOTBALL_LIMIT}`,
    cacheSize: statsCache.size,
    sseClients: sseClients.length,
    time: new Date().toISOString()
  });
});

app.get('/api/matches', async (req, res) => {
  try {
    if (!isMongoConnected) {
      return res.status(503).json({ success: false, error: 'MongoDB offline' });
    }
    
    const matches = await Match.find({
      status: { $in: ['NS', 'LIVE', '1H', '2H', 'HT'] }
    })
      .sort({ match_date: 1 })
      .limit(100);
    
    res.json({
      success: true,
      count: matches.length,
      data: matches
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/predictions', async (req, res) => {
  try {
    if (!isMongoConnected) {
      return res.status(503).json({ success: false, error: 'MongoDB offline' });
    }
    
    const predictions = await Prediction.find()
      .sort({ confidence_score: -1, updatedAt: -1 })
      .limit(100);
    
    res.json({
      success: true,
      count: predictions.length,
      data: predictions
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/latest-updates', (req, res) => {
  res.json({
    success: true,
    updates: latestPredictions.slice(0, 20)
  });
});

app.post('/api/fetch-matches', async (req, res) => {
  try {
    const matches = await fetchAllMatches();
    
    res.json({
      success: true,
      count: matches.length,
      message: `Fetched ${matches.length} matches`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/generate-predictions', async (req, res) => {
  try {
    await generateAndPushPredictions();
    
    res.json({
      success: true,
      message: 'Predictions generated and pushed to clients'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ==================== AUTO TASKS ====================

// Initial fetch after 10 seconds
setTimeout(async () => {
  if (!isMongoConnected) {
    let attempts = 0;
    while (!isMongoConnected && attempts < 30) {
      await new Promise(r => setTimeout(r, 1000));
      attempts++;
    }
  }
  
  if (isMongoConnected) {
    console.log('🚀 Initial fetch starting...');
    await fetchAllMatches();
    await generateAndPushPredictions();
    console.log('✅ Initial setup complete!');
  }
}, 10000);

// Update live matches every 2 minutes
setInterval(async () => {
  console.log('\n⏰ Scheduled: Live stats update');
  await updateLiveMatches();
}, 2 * 60 * 1000);

// Generate and push predictions every 5 minutes
setInterval(async () => {
  console.log('\n⏰ Scheduled: Prediction generation');
  await generateAndPushPredictions();
}, 5 * 60 * 1000);

// Fetch new matches every 15 minutes
setInterval(async () => {
  console.log('\n⏰ Scheduled: Fetch new matches');
  if (isMongoConnected) await fetchAllMatches();
}, 15 * 60 * 1000);

// Clear old cache every 10 minutes
setInterval(() => {
  const now = Date.now();
  let cleared = 0;
  for (const [key, value] of statsCache.entries()) {
    if (now - value.timestamp > 600000) {
      statsCache.delete(key);
      cleared++;
    }
  }
  if (cleared > 0) {
    console.log(`🧹 Cleared ${cleared} cache entries. Size: ${statsCache.size}`);
  }
}, 10 * 60 * 1000);

// Keep-alive ping for SSE clients every 30 seconds
setInterval(() => {
  if (sseClients.length > 0) {
    const message = `: keep-alive\n\n`;
    sseClients.forEach((client, index) => {
      try {
        client.write(message);
      } catch (error) {
        console.log(`❌ SSE client ${index} disconnected during ping`);
        sseClients.splice(index, 1);
      }
    });
  }
}, 30000);

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║  ⚽ LIVE FOOTBALL PREDICTION SYSTEM ⚽            ║');
  console.log('║                                                   ║');
  console.log(`║  🚀 Server: http://localhost:${PORT}            ║`);
  console.log('║  📡 SSE Live Stream: /api/live-stream            ║');
  console.log('║  📊 API-Football: Real-time match data           ║');
  console.log('║  🎯 Auto Predictions: Every 5 minutes            ║');
  console.log('║  ⚡ Live Stats Update: Every 2 minutes           ║');
  console.log('║  🔄 Match Refresh: Every 15 minutes              ║');
  console.log('║  📡 Auto-Push: SSE to all connected clients      ║');
  console.log('║                                                   ║');
  console.log('║  API Endpoints:                                   ║');
  console.log('║  • GET  /api/matches                             ║');
  console.log('║  • GET  /api/predictions                         ║');
  console.log('║  • GET  /api/latest-updates                      ║');
  console.log('║  • GET  /api/live-stream (SSE)                   ║');
  console.log('║  • POST /api/fetch-matches                       ║');
  console.log('║  • POST /api/generate-predictions                ║');
  console.log('╚═══════════════════════════════════════════════════╝\n');
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  sseClients.forEach(client => client.end());
  if (isMongoConnected) await mongoose.connection.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  sseClients.forEach(client => client.end());
  if (isMongoConnected) await mongoose.connection.close();
  process.exit(0);
});
