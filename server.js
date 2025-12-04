

import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { Server } from 'socket.io';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 8080;

// ==================== API KEYS ====================
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || 'fdab0eef5743173c30f9810bef3a6742';
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY || '62207494b8a241db93aee4c14b7c1266';

// ==================== TOP LEAGUES ====================
const TOP_LEAGUES = {
  39: 'Premier League',
  140: 'La Liga',
  135: 'Serie A',
  78: 'Bundesliga',
  61: 'Ligue 1',
  94: 'Primeira Liga',
  88: 'Eredivisie',
  203: 'Super Lig',
  480: 'Arab Cup',
  32: 'World Cup Qualification Africa',
  33: 'World Cup Qualification Asia',
  34: 'World Cup Qualification Europe'
};

let apiFootballCalls = 0;
let footballDataCalls = 0;
const API_FOOTBALL_LIMIT = 100;
const FOOTBALL_DATA_LIMIT = 10;
const statsCache = new Map();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ==================== MONGODB ====================
const MONGODB_URI = process.env.MONGO_PUBLIC_URL ||
                    process.env.MONGO_URI || 
                    process.env.MONGODB_URI || 
                    'mongodb://localhost:27017/football-predictions';

console.log('🔌 MongoDB Configuration:');
if (MONGODB_URI.includes('localhost')) {
  console.log('⚠️  LOCAL MongoDB detected');
} else {
  console.log('✅ CLOUD MongoDB detected');
}

let isMongoConnected = false;

mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS: 45000
})
.then(() => {
  console.log('✅ MongoDB Connected!');
  console.log('📦 Database:', mongoose.connection.db.databaseName);
  isMongoConnected = true;
})
.catch(err => {
  console.error('❌ MongoDB Error:', err.message);
  isMongoConnected = false;
});

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ MongoDB Disconnected');
  isMongoConnected = false;
});

mongoose.connection.on('reconnected', () => {
  console.log('✅ MongoDB Reconnected');
  isMongoConnected = true;
});

// ==================== SCHEMAS ====================
const matchSchema = new mongoose.Schema({
  match_id: { type: String, required: true, unique: true },
  fixture_id: String,
  home_team: { type: String, required: true },
  away_team: { type: String, required: true },
  league: String,
  league_name: String,
  home_score: { type: Number, default: 0 },
  away_score: { type: Number, default: 0 },
  status: { type: String, default: 'NS' },
  elapsed: { type: Number, default: 0 },
  match_time: String,
  match_time_pkt: String,
  match_date: Date,
  venue: String,
  home_logo: String,
  away_logo: String,
  
  // REAL-TIME STATS
  stats: {
    shots_on_goal: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    shots_off_goal: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    total_shots: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    blocked_shots: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    possession: { home: { type: Number, default: 50 }, away: { type: Number, default: 50 } },
    corner_kicks: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    fouls: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    yellow_cards: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    red_cards: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    saves: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    passes: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    passes_accurate: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } }
  },
  
  // FORM DATA
  form: {
    home_last5: { type: String, default: '' },
    away_last5: { type: String, default: '' },
    home_position: { type: Number, default: 0 },
    away_position: { type: Number, default: 0 }
  },
  
  api_source: String,
  last_stats_update: { type: Date, default: Date.now }
}, { timestamps: true });

matchSchema.index({ match_date: 1 });
matchSchema.index({ status: 1 });
matchSchema.index({ fixture_id: 1 });

const predictionSchema = new mongoose.Schema({
  match_id: { type: String, required: true, unique: true },
  home_team: { type: String, required: true },
  away_team: { type: String, required: true },
  league: String,
  match_time_pkt: String,
  match_status: String,
  elapsed: Number,
  
  // PROBABILITY MATRIX
  winner_prob: {
    home: { type: Number, default: 0 },
    draw: { type: Number, default: 0 },
    away: { type: Number, default: 0 },
    trend: { type: String, default: 'stable' }
  },
  
  // GOAL PREDICTIONS
  most_likely_score: { type: String, default: '1-1' },
  over_under: {
    '0.5': { type: Number, default: 0 },
    '1.5': { type: Number, default: 0 },
    '2.5': { type: Number, default: 0 },
    '3.5': { type: Number, default: 0 }
  },
  btts_prob: { type: Number, default: 0 },
  
  // XG & STATS
  xG: {
    home: { type: Number, default: 0 },
    away: { type: Number, default: 0 },
    total: { type: Number, default: 0 }
  },
  
  key_stats: {
    shots_on_target: { type: String, default: '0-0' },
    possession: { type: String, default: '50%-50%' },
    big_chances: { type: String, default: '0-0' }
  },
  
  // CONFIDENCE & RISK
  confidence_score: { type: Number, default: 0 },
  risk_level: { type: String, default: 'medium' },
  
  // LIVE INDICATORS
  live_insights: [{
    message: String,
    type: String,
    timestamp: { type: Date, default: Date.now }
  }],
  
  // SPECIAL CIRCUMSTANCES
  special_factors: [{
    factor: String,
    impact: Number,
    description: String
  }],
  
  // WEIGHTED FACTORS
  prediction_factors: {
    form_score: { type: Number, default: 0 },
    realtime_score: { type: Number, default: 0 },
    context_score: { type: Number, default: 0 },
    total_score: { type: Number, default: 0 }
  },
  
  is_new: { type: Boolean, default: true },
  last_updated: { type: Date, default: Date.now }
}, { timestamps: true });

predictionSchema.index({ createdAt: -1 });
predictionSchema.index({ match_id: 1 });

const Match = mongoose.model('Match', matchSchema);
const Prediction = mongoose.model('Prediction', predictionSchema);

// ==================== WEBSOCKET ====================
io.on('connection', (socket) => {
  console.log('📱 Client connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('📱 Client disconnected:', socket.id);
  });
});

// ==================== HELPER FUNCTIONS ====================
function convertStatus(status) {
  const map = {
    'NS': 'NS', 'TBD': 'NS', 'SCHEDULED': 'NS',
    'LIVE': 'LIVE', 'IN_PLAY': 'LIVE',
    '1H': '1H', 'HT': 'HT', '2H': '2H',
    'FT': 'FT', 'FINISHED': 'FT', 'AET': 'FT', 'PEN': 'FT',
    'ET': 'ET', 'P': 'P'
  };
  return map[status] || 'NS';
}

function toPakistanTime(dateString) {
  try {
    return new Date(dateString).toLocaleString('en-PK', {
      timeZone: 'Asia/Karachi',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  } catch {
    return 'Time TBA';
  }
}

// ==================== CALCULATE XG ====================
function calculateXG(stats) {
  if (!stats || !stats.shots_on_goal) {
    return { home: 0, away: 0, total: 0 };
  }
  
  const homeXg = (
    stats.shots_on_goal.home * 0.35 +
    stats.total_shots.home * 0.10 +
    stats.corner_kicks.home * 0.04
  ).toFixed(2);
  
  const awayXg = (
    stats.shots_on_goal.away * 0.35 +
    stats.total_shots.away * 0.10 +
    stats.corner_kicks.away * 0.04
  ).toFixed(2);
  
  return {
    home: parseFloat(homeXg),
    away: parseFloat(awayXg),
    total: parseFloat((parseFloat(homeXg) + parseFloat(awayXg)).toFixed(2))
  };
}

// ==================== FETCH LIVE STATS ====================
async function fetchLiveStats(fixtureId) {
  try {
    // Check cache (valid for 2 minutes)
    const cached = statsCache.get(fixtureId);
    if (cached && Date.now() - cached.timestamp < 120000) {
      return cached.data;
    }
    
    const response = await fetch(
      `https://v3.football.api-sports.io/fixtures?id=${fixtureId}`,
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
    if (!data.response || data.response.length === 0) return null;
    
    const fixture = data.response[0];
    const statsData = {
      elapsed: fixture.fixture.status.elapsed || 0,
      status: convertStatus(fixture.fixture.status.short),
      home_score: fixture.goals.home || 0,
      away_score: fixture.goals.away || 0,
      stats: {
        shots_on_goal: { home: 0, away: 0 },
        shots_off_goal: { home: 0, away: 0 },
        total_shots: { home: 0, away: 0 },
        blocked_shots: { home: 0, away: 0 },
        possession: { home: 50, away: 50 },
        corner_kicks: { home: 0, away: 0 },
        fouls: { home: 0, away: 0 },
        yellow_cards: { home: 0, away: 0 },
        red_cards: { home: 0, away: 0 },
        saves: { home: 0, away: 0 },
        passes: { home: 0, away: 0 },
        passes_accurate: { home: 0, away: 0 }
      }
    };
    
    // Fetch detailed statistics
    const statsResponse = await fetch(
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
    
    if (statsResponse.ok) {
      const statsJson = await statsResponse.json();
      if (statsJson.response && statsJson.response.length > 0) {
        const homeStats = statsJson.response[0]?.statistics || [];
        const awayStats = statsJson.response[1]?.statistics || [];
        
        const getStatValue = (stats, type) => {
          const stat = stats.find(s => s.type === type);
          if (!stat || !stat.value) return 0;
          const val = String(stat.value).replace('%', '');
          return parseInt(val) || 0;
        };
        
        statsData.stats = {
          shots_on_goal: {
            home: getStatValue(homeStats, 'Shots on Goal'),
            away: getStatValue(awayStats, 'Shots on Goal')
          },
          shots_off_goal: {
            home: getStatValue(homeStats, 'Shots off Goal'),
            away: getStatValue(awayStats, 'Shots off Goal')
          },
          total_shots: {
            home: getStatValue(homeStats, 'Total Shots'),
            away: getStatValue(awayStats, 'Total Shots')
          },
          blocked_shots: {
            home: getStatValue(homeStats, 'Blocked Shots'),
            away: getStatValue(awayStats, 'Blocked Shots')
          },
          possession: {
            home: getStatValue(homeStats, 'Ball Possession'),
            away: getStatValue(awayStats, 'Ball Possession')
          },
          corner_kicks: {
            home: getStatValue(homeStats, 'Corner Kicks'),
            away: getStatValue(awayStats, 'Corner Kicks')
          },
          fouls: {
            home: getStatValue(homeStats, 'Fouls'),
            away: getStatValue(awayStats, 'Fouls')
          },
          yellow_cards: {
            home: getStatValue(homeStats, 'Yellow Cards'),
            away: getStatValue(awayStats, 'Yellow Cards')
          },
          red_cards: {
            home: getStatValue(homeStats, 'Red Cards'),
            away: getStatValue(awayStats, 'Red Cards')
          },
          saves: {
            home: getStatValue(homeStats, 'Goalkeeper Saves'),
            away: getStatValue(awayStats, 'Goalkeeper Saves')
          },
          passes: {
            home: getStatValue(homeStats, 'Total passes'),
            away: getStatValue(awayStats, 'Total passes')
          },
          passes_accurate: {
            home: getStatValue(homeStats, 'Passes accurate'),
            away: getStatValue(awayStats, 'Passes accurate')
          }
        };
      }
    }
    
    // Cache for 2 minutes
    statsCache.set(fixtureId, { data: statsData, timestamp: Date.now() });
    
    return statsData;
  } catch (error) {
    console.error(`❌ Error fetching stats for ${fixtureId}:`, error.message);
    return null;
  }
}

// ==================== INTELLIGENT PREDICTION ====================
function calculateIntelligentPrediction(match) {
  const stats = match.stats || {};
  const form = match.form || {};
  const status = match.status;
  const elapsed = match.elapsed || 0;
  
  let formScore = 0;
  let realtimeScore = 0;
  let contextScore = 0;
  
  // === FORM FACTORS (30%) ===
  if (form.home_last5 && form.away_last5) {
    const homeWins = (form.home_last5.match(/W/g) || []).length;
    const awayWins = (form.away_last5.match(/W/g) || []).length;
    formScore = ((homeWins - awayWins) * 10) + 50;
  } else {
    formScore = 50;
  }
  
  // === REAL-TIME FACTORS (50%) ===
  if (status === 'LIVE' || status === '1H' || status === '2H') {
    const possessionDiff = (stats.possession?.home || 50) - (stats.possession?.away || 50);
    const shotsDiff = (stats.shots_on_goal?.home || 0) - (stats.shots_on_goal?.away || 0);
    const xG = calculateXG(stats);
    const xGDiff = xG.home - xG.away;
    
    realtimeScore = (
      possessionDiff * 0.3 +
      shotsDiff * 10 +
      xGDiff * 30
    ) + 50;
    
    realtimeScore = Math.max(0, Math.min(100, realtimeScore));
  } else {
    realtimeScore = formScore;
  }
  
  // === CONTEXT FACTORS (20%) ===
  contextScore = 50;
  
  if (stats.red_cards?.home > stats.red_cards?.away) {
    contextScore -= 20;
  } else if (stats.red_cards?.away > stats.red_cards?.home) {
    contextScore += 20;
  }
  
  // === WEIGHTED TOTAL ===
  const totalScore = (
    formScore * 0.30 +
    realtimeScore * 0.50 +
    contextScore * 0.20
  );
  
  // === PROBABILITY CALCULATION ===
  const homeProb = Math.round(Math.max(15, Math.min(85, totalScore)));
  const awayProb = Math.round(Math.max(15, Math.min(85, 100 - totalScore)));
  const drawProb = Math.max(5, 100 - homeProb - awayProb);
  
  // === XG CALCULATION ===
  const xG = calculateXG(stats);
  
  // === OVER/UNDER ===
  const totalXg = xG.total;
  const over05 = totalXg > 0.3 ? 90 : 70;
  const over15 = totalXg > 1.0 ? 75 : 40;
  const over25 = totalXg > 2.0 ? 65 : 30;
  const over35 = totalXg > 3.0 ? 45 : 15;
  
  // === BTTS ===
  const btts = xG.home > 0.8 && xG.away > 0.8 ? 70 : 35;
  
  // === MOST LIKELY SCORE ===
  const homeGoals = Math.round(xG.home);
  const awayGoals = Math.round(xG.away);
  const mostLikelyScore = `${homeGoals}-${awayGoals}`;
  
  // === CONFIDENCE ===
  const statsDiff = Math.abs(realtimeScore - 50);
  const confidence = Math.round(Math.min(95, 50 + statsDiff));
  
  // === RISK LEVEL ===
  let riskLevel = 'medium';
  if (confidence >= 80) riskLevel = 'low';
  if (confidence < 60) riskLevel = 'high';
  
  // === LIVE INSIGHTS ===
  const liveInsights = [];
  
  if (status === 'LIVE' || status === '1H' || status === '2H') {
    if (xG.total > 2.5 && elapsed > 30) {
      liveInsights.push({
        message: '⚡ High goal expectation - Over 2.5 likely',
        type: 'goal_expected',
        timestamp: new Date()
      });
    }
    
    if (stats.shots_on_goal?.home > (stats.shots_on_goal?.away || 0) + 3) {
      liveInsights.push({
        message: '🔥 Home team dominating - Next goal likely',
        type: 'momentum_shift',
        timestamp: new Date()
      });
    }
    
    if (stats.shots_on_goal?.away > (stats.shots_on_goal?.home || 0) + 3) {
      liveInsights.push({
        message: '🔥 Away team dominating - Next goal likely',
        type: 'momentum_shift',
        timestamp: new Date()
      });
    }
    
    const totalShots = (stats.shots_on_goal?.home || 0) + (stats.shots_on_goal?.away || 0);
    if (totalShots < 2 && elapsed > 30) {
      liveInsights.push({
        message: '🛡️ Defensive match - Under 2.5 likely',
        type: 'defensive',
        timestamp: new Date()
      });
    }
  }
  
  // === SPECIAL FACTORS ===
  const specialFactors = [];
  
  if (stats.red_cards?.home > 0) {
    specialFactors.push({
      factor: 'red_card',
      impact: -20,
      description: '🔴 Home team playing with 10 men'
    });
  }
  
  if (stats.red_cards?.away > 0) {
    specialFactors.push({
      factor: 'red_card',
      impact: 20,
      description: '🔴 Away team playing with 10 men'
    });
  }
  
  return {
    match_id: match.match_id,
    home_team: match.home_team,
    away_team: match.away_team,
    league: match.league_name || match.league,
    match_time_pkt: match.match_time_pkt,
    match_status: status,
    elapsed: elapsed,
    
    winner_prob: {
      home: homeProb,
      draw: drawProb,
      away: awayProb,
      trend: 'stable'
    },
    
    most_likely_score: mostLikelyScore,
    
    over_under: {
      '0.5': over05,
      '1.5': over15,
      '2.5': over25,
      '3.5': over35
    },
    
    btts_prob: btts,
    
    xG: xG,
    
    key_stats: {
      shots_on_target: `${stats.shots_on_goal?.home || 0}-${stats.shots_on_goal?.away || 0}`,
      possession: `${stats.possession?.home || 50}%-${stats.possession?.away || 50}%`,
      big_chances: `${Math.floor((stats.shots_on_goal?.home || 0) / 2)}-${Math.floor((stats.shots_on_goal?.away || 0) / 2)}`
    },
    
    confidence_score: confidence,
    risk_level: riskLevel,
    
    live_insights: liveInsights,
    special_factors: specialFactors,
    
    prediction_factors: {
      form_score: Math.round(formScore),
      realtime_score: Math.round(realtimeScore),
      context_score: Math.round(contextScore),
      total_score: Math.round(totalScore)
    },
    
    is_new: true,
    last_updated: new Date()
  };
}

// ==================== FETCH MATCHES FROM API-FOOTBALL ====================
async function fetchFromApiFootball() {
  try {
    console.log('\n🌐 Fetching from API-Football...');
    console.log(`📊 API Calls: ${apiFootballCalls}/${API_FOOTBALL_LIMIT}`);
    
    if (apiFootballCalls >= API_FOOTBALL_LIMIT) {
      console.log('⚠️ API-Football limit reached');
      return null;
    }
    
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 24*60*60*1000).toISOString().split('T')[0];
    
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
        
        const matches = filtered.map(f => ({
          match_id: `af_${f.fixture.id}`,
          fixture_id: f.fixture.id,
          home_team: f.teams.home.name,
          away_team: f.teams.away.name,
          league: f.league.name,
          league_name: f.league.name,
          home_score: f.goals.home || 0,
          away_score: f.goals.away || 0,
          status: convertStatus(f.fixture.status.short),
          elapsed: f.fixture.status.elapsed || 0,
          match_time: f.fixture.date,
          match_time_pkt: toPakistanTime(f.fixture.date),
          match_date: new Date(f.fixture.date),
          venue: f.fixture.venue?.name || 'Unknown',
          home_logo: f.teams.home.logo,
          away_logo: f.teams.away.logo,
          api_source: 'API-Football'
        }));
        
        allMatches = [...allMatches, ...matches];
        
      } catch (error) {
        console.error(`❌ Fetch error for ${date}:`, error.message);
      }
    }
    
    console.log(`\n✅ API-Football Total: ${allMatches.length}`);
    return allMatches.length > 0 ? allMatches : null;
    
  } catch (error) {
    console.error('❌ API-Football Error:', error.message);
    return null;
  }
}

// ==================== FETCH MATCHES FROM FOOTBALL-DATA ====================
async function fetchFromFootballData() {
  try {
    console.log('\n🌐 Fetching from Football-Data.org...');
    console.log(`📊 Calls: ${footballDataCalls}/${FOOTBALL_DATA_LIMIT}`);
    
    if (footballDataCalls >= FOOTBALL_DATA_LIMIT) {
      console.log('⚠️ Football-Data limit reached');
      return null;
    }
    
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 24*60*60*1000).toISOString().split('T')[0];
    
    let allMatches = [];
    
    for (const date of [today, tomorrow]) {
      if (footballDataCalls >= FOOTBALL_DATA_LIMIT) break;
      
      console.log(`\n🔍 Football-Data: ${date}...`);
      
      try {
        const response = await fetch(
          `https://api.football-data.org/v4/matches?date=${date}`,
          {
            headers: {
              'X-Auth-Token': FOOTBALL_DATA_KEY
            },
            signal: AbortSignal.timeout(15000)
          }
        );
        
        footballDataCalls++;
        
        if (!response.ok) {
          console.log(`❌ API Error: ${response.status}`);
          continue;
        }
        
        const data = await response.json();
        
        if (!data.matches || data.matches.length === 0) {
          console.log(`⚠️ No matches for ${date}`);
          continue;
        }
        
        console.log(`✅ Found ${data.matches.length} matches`);
        
        const matches = data.matches.map(m => ({
          match_id: `fd_${m.id}`,
          fixture_id: String(m.id),
          home_team: m.homeTeam.name,
          away_team: m.awayTeam.name,
          league: m.competition.name,
          league_name: m.competition.name,
          home_score: m.score.fullTime.home || 0,
          away_score: m.score.fullTime.away || 0,
          status: convertStatus(m.status),
          elapsed: 0,
          match_time: m.utcDate,
          match_time_pkt: toPakistanTime(m.utcDate),
          match_date: new Date(m.utcDate),
          venue: m.venue || 'Unknown',
          home_logo: m.homeTeam.crest || null,
          away_logo: m.awayTeam.crest || null,
          api_source: 'Football-Data'
        }));
        
        allMatches = [...allMatches, ...matches];
        
      } catch (error) {
        console.error(`❌ Error for ${date}:`, error.message);
      }
    }
    
    console.log(`\n✅ Football-Data Total: ${allMatches.length}`);
    return allMatches.length > 0 ? allMatches : null;
    
  } catch (error) {
    console.error('❌ Football-Data Error:', error.message);
    return null;
  }
}

// ==================== FETCH MATCHES (WITH FALLBACK) ====================
async function fetchMatches() {
  console.log('\n🔄 ============ FETCHING MATCHES ============');
  
  const pkTime = new Date().toLocaleString('en-PK', {
    timeZone: 'Asia/Karachi',
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
  
  console.log('🇵🇰 Pakistan Time:', pkTime);
  
  if (!isMongoConnected) {
    console.log('❌ MongoDB not connected');
    return [];
  }
  
  let allMatches = [];
  
  // STEP 1: Try API-Football
  const apiFootballMatches = await fetchFromApiFootball();
  if (apiFootballMatches && apiFootballMatches.length > 0) {
    allMatches = [...allMatches, ...apiFootballMatches];
  }
  
  // STEP 2: Fallback to Football-Data
  if (apiFootballCalls >= API_FOOTBALL_LIMIT || !apiFootballMatches) {
    console.log('\n🔄 Trying Football-Data fallback...');
    const footballDataMatches = await fetchFromFootballData();
    if (footballDataMatches && footballDataMatches.length > 0) {
      allMatches = [...allMatches, ...footballDataMatches];
    }
  }
  
  // Remove duplicates
  const uniqueMatches = [];
  const seen = new Set();
  
  for (const match of allMatches) {
    const key = `${match.home_team}-${match.away_team}-${new Date(match.match_date).toDateString()}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueMatches.push(match);
    }
  }
  
  console.log(`\n✅ Total Unique Matches: ${uniqueMatches.length}`);
  
  // Save to database
  let saved = 0;
  for (const match of uniqueMatches) {
    try {
      await Match.findOneAndUpdate(
        { match_id: match.match_id },
        match,
        { upsert: true, new: true }
      );
      saved++;
    } catch (err) {
      console.error('❌ Save error:', err.message);
    }
  }
  
  console.log(`✅ Saved: ${saved}/${uniqueMatches.length}`);
  console.log('============ FETCH COMPLETE ============\n');
  
  return uniqueMatches;
}

// ==================== UPDATE LIVE MATCHES ====================
async function updateLiveMatches() {
  if (!isMongoConnected) return;
  
  try {
    const liveMatches = await Match.find({
      status: { $in: ['LIVE', '1H', '2H', 'HT'] }
    });
    
    if (liveMatches.length === 0) {
      console.log('✅ No live matches to update');
      return;
    }
    
    console.log(`\n🔴 Updating ${liveMatches.length} LIVE matches...`);
    
    for (const match of liveMatches) {
      if (apiFootballCalls >= API_FOOTBALL_LIMIT) {
        console.log('⚠️ API limit reached, stopping updates');
        break;
      }
      
      const liveStats = await fetchLiveStats(match.fixture_id);
      
      if (liveStats) {
        await Match.findOneAndUpdate(
          { match_id: match.match_id },
          {
            $set: {
              ...liveStats,
              last_stats_update: new Date()
            }
          }
        );
        
        const updatedMatch = await Match.findOne({ match_id: match.match_id });
        const prediction = calculateIntelligentPrediction(updatedMatch);
        
        await Prediction.findOneAndUpdate(
          { match_id: match.match_id },
          prediction,
          { upsert: true, new: true }
        );
        
        // Send to WebSocket
        io.emit('prediction_update', {
          match_id: match.match_id,
          prediction: prediction
        });
        
        console.log(`✅ Updated: ${match.home_team} vs ${match.away_team} (${liveStats.elapsed}')`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log('✅ Live updates complete\n');
    
  } catch (error) {
    console.error('❌ Live update error:', error.message);
  }
}

// ==================== CLEANUP FINISHED ====================
async function cleanupFinished() {
  if (!isMongoConnected) return;
  
  try {
    const finishedResult = await Match.deleteMany({
      status: { $in: ['FT', 'AET', 'PEN'] }
    });
    
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const oldResult = await Match.deleteMany({
      match_date: { $lt: todayStart }
    });
    
    const totalDeleted = finishedResult.deletedCount + oldResult.deletedCount;
    
    if (totalDeleted > 0) {
      console.log(`🗑️ Removed ${finishedResult.deletedCount} finished + ${oldResult.deletedCount} old = ${totalDeleted} total`);
      
      const activeIds = await Match.find().distinct('match_id');
      const predResult = await Prediction.deleteMany({
        match_id: { $nin: activeIds }
      });
      
      if (predResult.deletedCount > 0) {
        console.log(`🗑️ Removed ${predResult.deletedCount} orphaned predictions`);
      }
    }
  } catch (err) {
    console.error('❌ Cleanup error:', err.message);
  }
}

// ==================== API ROUTES ====================

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    mongodb: isMongoConnected ? 'Connected' : 'Disconnected',
    apiFootballCalls: `${apiFootballCalls}/${API_FOOTBALL_LIMIT}`,
    footballDataCalls: `${footballDataCalls}/${FOOTBALL_DATA_LIMIT}`,
    websocket: io.engine.clientsCount + ' clients',
    time: new Date().toISOString()
  });
});

app.get('/api/matches', async (req, res) => {
  try {
    if (!isMongoConnected) {
      return res.status(503).json({ success: false, error: 'MongoDB offline' });
    }
    
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    
    const tomorrowEnd = new Date(now);
    tomorrowEnd.setDate(tomorrowEnd.getDate() + 2);
    tomorrowEnd.setHours(23, 59, 59, 999);
    
    const matches = await Match.find({
      status: { $in: ['NS', 'LIVE', '1H', '2H', 'HT', 'ET'] },
      match_date: { $gte: todayStart, $lte: tomorrowEnd }
    })
      .sort({ match_date: 1 })
      .limit(100);
    
    console.log(`📊 Active matches: ${matches.length}`);
    
    res.json({
      success: true,
      count: matches.length,
      data: matches
    });
  } catch (err) {
    console.error('❌ API Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/predictions', async (req, res) => {
  try {
    if (!isMongoConnected) {
      return res.status(503).json({ success: false, error: 'MongoDB offline' });
    }
    
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    
    const tomorrowEnd = new Date(now);
    tomorrowEnd.setDate(tomorrowEnd.getDate() + 2);
    
    const activeIds = await Match.find({
      status: { $in: ['NS', 'LIVE', '1H', '2H', 'HT', 'ET'] },
      match_date: { $gte: todayStart, $lte: tomorrowEnd }
    }).distinct('match_id');
    
    const predictions = await Prediction.find({
      match_id: { $in: activeIds }
    })
      .sort({ confidence_score: -1, createdAt: -1 })
      .limit(100);
    
    const newCount = predictions.filter(p => p.is_new).length;
    
    console.log(`📊 Predictions: ${predictions.length} (${newCount} new)`);
    
    res.json({
      success: true,
      count: predictions.length,
      newPredictions: newCount,
      data: predictions
    });
  } catch (err) {
    console.error('❌ API Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/fetch-matches', async (req, res) => {
  try {
    console.log('🔄 Manual fetch triggered');
    const matches = await fetchMatches();
    
    if (matches.length > 0) {
      for (const match of matches) {
        const pred = calculateIntelligentPrediction(match);
        await Prediction.findOneAndUpdate(
          { match_id: match.match_id },
          pred,
          { upsert: true, new: true }
        );
      }
    }
    
    res.json({
      success: true,
      count: matches.length,
      message: `Fetched ${matches.length} matches`
    });
  } catch (err) {
    console.error('❌ Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/mark-predictions-seen', async (req, res) => {
  try {
    await Prediction.updateMany({ is_new: true }, { is_new: false });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/cleanup-old-matches', async (req, res) => {
  try {
    if (!isMongoConnected) {
      return res.status(503).json({ success: false, error: 'MongoDB offline' });
    }
    
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const result = await Match.deleteMany({
      match_date: { $lt: todayStart }
    });
    
    const activeIds = await Match.find().distinct('match_id');
    const predResult = await Prediction.deleteMany({
      match_id: { $nin: activeIds }
    });
    
    console.log(`🗑️ Cleaned: ${result.deletedCount} matches, ${predResult.deletedCount} predictions`);
    
    res.json({
      success: true,
      matchesDeleted: result.deletedCount,
      predictionsDeleted: predResult.deletedCount
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ==================== AUTO TASKS ====================

setTimeout(async () => {
  if (!isMongoConnected) {
    console.log('⏳ Waiting for MongoDB...');
    let attempts = 0;
    while (!isMongoConnected && attempts < 30) {
      await new Promise(r => setTimeout(r, 1000));
      attempts++;
    }
  }
  
  if (isMongoConnected) {
    console.log('🚀 Initial fetch...');
    const matches = await fetchMatches();
    
    if (matches.length > 0) {
      console.log('🔄 Creating predictions...');
      for (const match of matches) {
        const pred = calculateIntelligentPrediction(match);
        await Prediction.findOneAndUpdate(
          { match_id: match.match_id },
          pred,
          { upsert: true, new: true }
        );
      }
      console.log(`✅ Created ${matches.length} predictions`);
    }
  }
}, 10000);

// Update live matches every 2 minutes
setInterval(async () => {
  if (isMongoConnected) {
    await updateLiveMatches();
  }
}, 2 * 60 * 1000);

// Fetch new matches every 15 minutes
setInterval(async () => {
  if (isMongoConnected) {
    await fetchMatches();
  }
}, 15 * 60 * 1000);

// Auto-update predictions every 5 minutes
setInterval(async () => {
  if (!isMongoConnected) return;
  
  console.log('\n🔄 Auto-update predictions...');
  await cleanupFinished();
  
  const activeMatches = await Match.find({
    status: { $in: ['NS', 'LIVE', '1H', '2H', 'HT', 'ET'] }
  }).limit(100);
  
  console.log(`📊 Updating ${activeMatches.length} predictions`);
  
  for (const match of activeMatches) {
    const existing = await Prediction.findOne({ match_id: match.match_id });
    const pred = calculateIntelligentPrediction(match);
    pred.is_new = !existing;
    
    await Prediction.findOneAndUpdate(
      { match_id: match.match_id },
      pred,
      { upsert: true, new: true }
    );
  }
  
  console.log('✅ Update complete\n');
}, 5 * 60 * 1000);

// Cleanup every 2 minutes
setInterval(async () => {
  if (isMongoConnected) {
    await cleanupFinished();
  }
}, 2 * 60 * 1000);

// ==================== START SERVER ====================
server.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║   ⚽ REAL-TIME PREDICTION SYSTEM ⚽         ║');
  console.log('║                                            ║');
  console.log(`║   🚀 Server: http://localhost:${PORT}     ║`);
  console.log('║   📡 WebSocket: ENABLED                    ║');
  console.log('║   🔴 Live Updates: Every 2 mins            ║');
  console.log('║   📊 Real Stats: API-Football              ║');
  console.log('║   🧠 Intelligent Algorithm: ACTIVE         ║');
  console.log('║   🇵🇰 Pakistan Time                         ║');
  console.log('╚════════════════════════════════════════════╝\n');
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down...');
  if (isMongoConnected) {
    await mongoose.connection.close();
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  if (isMongoConnected) {
    await mongoose.connection.close();
  }
  process.exit(0);
});
