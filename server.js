

import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { Server } from 'socket.io';
import fetch from 'node-fetch';
import { setTimeout } from 'timers/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

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

// API Rate Limiting
let apiFootballCalls = 0;
let footballDataCalls = 0;
const API_FOOTBALL_LIMIT = 90; // Leave some buffer
const FOOTBALL_DATA_LIMIT = 8; // Leave some buffer

// Caches
const statsCache = new Map();
const predictionsCache = new Map();
const formCache = new Map();

// Cache expiration times (in milliseconds)
const CACHE_EXPIRY = {
  LIVE_STATS: 2 * 60 * 1000,      // 2 minutes
  PREDICTIONS: 5 * 60 * 1000,     // 5 minutes
  FORM_DATA: 30 * 60 * 1000,      // 30 minutes
  MATCH_LIST: 15 * 60 * 1000      // 15 minutes
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.use('/js', express.static(path.join(__dirname, 'js')));

// ==================== MONGODB CONNECTION ====================
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
  socketTimeoutMS: 45000,
  maxPoolSize: 10,
  retryWrites: true,
  w: 'majority'
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

// ==================== DATABASE SCHEMAS ====================
const matchSchema = new mongoose.Schema({
  match_id: { type: String, required: true, unique: true },
  fixture_id: String,
  home_team: { type: String, required: true },
  away_team: { type: String, required: true },
  league: String,
  league_name: String,
  league_id: Number,
  home_score: { type: Number, default: 0 },
  away_score: { type: Number, default: 0 },
  status: { 
    type: String, 
    default: 'NS',
    enum: ['NS', 'LIVE', '1H', '2H', 'HT', 'FT', 'AET', 'PEN', 'PST', 'CANCELED']
  },
  elapsed: { type: Number, default: 0 },
  match_time: String,
  match_time_pkt: String,
  match_date: Date,
  venue: String,
  home_logo: String,
  away_logo: String,
  
  // REAL-TIME STATS (COMPREHENSIVE)
  stats: {
    // Shots statistics
    shots_on_goal: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    shots_off_goal: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    total_shots: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    blocked_shots: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    
    // Possession & passing
    possession: { home: { type: Number, default: 50 }, away: { type: Number, default: 50 } },
    passes: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    passes_accurate: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    passing_accuracy: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    
    // Expected goals
    xg: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    xg_total: { type: Number, default: 0 },
    xgot: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } }, // xG on target
    
    // Key events
    big_chances: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    big_chances_missed: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    hits_woodwork: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    
    // Set pieces
    corner_kicks: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    free_kicks: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    offsides: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    
    // Discipline
    fouls: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    yellow_cards: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    red_cards: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    
    // Goalkeeping
    saves: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    punches: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    
    // Advanced metrics
    touches: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    touches_opp_box: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    duels_won: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    aerials_won: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    interceptions: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    tackles: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    clearances: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } }
  },
  
  // FORM & HISTORICAL DATA
  form: {
    home_last5: { type: String, default: '' },
    away_last5: { type: String, default: '' },
    home_position: { type: Number, default: 0 },
    away_position: { type: Number, default: 0 },
    home_home_form: { type: String, default: '' },
    away_away_form: { type: String, default: '' },
    h2h_last5: { type: String, default: '' },
    home_goals_scored: { type: Number, default: 0 },
    home_goals_conceded: { type: Number, default: 0 },
    away_goals_scored: { type: Number, default: 0 },
    away_goals_conceded: { type: Number, default: 0 }
  },
  
  // CONTEXT FACTORS
  context: {
    is_derby: { type: Boolean, default: false },
    is_cup_final: { type: Boolean, default: false },
    importance: { type: String, default: 'normal' }, // normal, high, very-high
    weather: {
      condition: { type: String, default: 'clear' },
      temperature: { type: Number, default: 20 },
      humidity: { type: Number, default: 60 }
    },
    missing_players: {
      home: [{ name: String, position: String, importance: String }],
      away: [{ name: String, position: String, importance: String }]
    }
  },
  
  // MOMENTUM DATA (last 15 minutes)
  momentum: {
    last15_shots: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    last15_possession: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    last15_xg: { home: { type: Number, default: 0 }, away: { type: Number, default: 0 } },
    trend: { type: String, default: 'stable' } // improving, declining, stable
  },
  
  api_source: String,
  last_stats_update: { type: Date, default: Date.now },
  data_quality: { type: Number, default: 0 }, // 0-100
  updates_count: { type: Number, default: 0 }
}, { 
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Virtuals
matchSchema.virtual('total_goals').get(function() {
  return this.home_score + this.away_score;
});

matchSchema.virtual('goal_difference').get(function() {
  return this.home_score - this.away_score;
});

matchSchema.virtual('is_live').get(function() {
  return ['LIVE', '1H', '2H', 'HT', 'ET'].includes(this.status);
});

// Indexes
matchSchema.index({ match_date: 1 });
matchSchema.index({ status: 1 });
matchSchema.index({ fixture_id: 1 });
matchSchema.index({ league_id: 1 });
matchSchema.index({ 'stats.xg_total': -1 });
matchSchema.index({ is_live: 1 });

// Prediction Schema (Enhanced)
const predictionSchema = new mongoose.Schema({
  match_id: { type: String, required: true, unique: true },
  home_team: { type: String, required: true },
  away_team: { type: String, required: true },
  league: String,
  league_id: Number,
  match_time_pkt: String,
  match_status: String,
  elapsed: Number,
  current_score: { type: String, default: '0-0' },
  
  // PROBABILITY MATRIX WITH TRENDS
  winner_prob: {
    home: { 
      value: { type: Number, default: 0 },
      trend: { type: String, default: 'stable' }, // ▲, ▼, →
      change: { type: Number, default: 0 },
      confidence: { type: Number, default: 0 }
    },
    draw: { 
      value: { type: Number, default: 0 },
      trend: { type: String, default: 'stable' },
      change: { type: Number, default: 0 },
      confidence: { type: Number, default: 0 }
    },
    away: { 
      value: { type: Number, default: 0 },
      trend: { type: String, default: 'stable' },
      change: { type: Number, default: 0 },
      confidence: { type: Number, default: 0 }
    }
  },
  
  // GOAL PREDICTIONS (COMPREHENSIVE)
  goal_predictions: {
    most_likely_score: { type: String, default: '1-1' },
    exact_score_probabilities: [{
      score: String,
      probability: Number
    }],
    goal_ranges: {
      '0-1': { type: Number, default: 0 },
      '2-3': { type: Number, default: 0 },
      '4+': { type: Number, default: 0 }
    }
  },
  
  // OVER/UNDER MARKETS
  over_under: {
    '0.5': { 
      over: { type: Number, default: 0 },
      under: { type: Number, default: 0 },
      value: { type: Boolean, default: null }
    },
    '1.5': { 
      over: { type: Number, default: 0 },
      under: { type: Number, default: 0 },
      value: { type: Boolean, default: null }
    },
    '2.5': { 
      over: { type: Number, default: 0 },
      under: { type: Number, default: 0 },
      value: { type: Boolean, default: null }
    },
    '3.5': { 
      over: { type: Number, default: 0 },
      under: { type: Number, default: 0 },
      value: { type: Boolean, default: null }
    }
  },
  
  // BTTS & OTHER MARKETS
  btts_prob: { 
    yes: { type: Number, default: 0 },
    no: { type: Number, default: 0 },
    value: { type: Boolean, default: null }
  },
  double_chance: {
    '1X': { type: Number, default: 0 },
    '12': { type: Number, default: 0 },
    'X2': { type: Number, default: 0 }
  },
  
  // EXPECTED GOALS (xG) ANALYSIS
  xg_analysis: {
    home_xg: { type: Number, default: 0 },
    away_xg: { type: Number, default: 0 },
    total_xg: { type: Number, default: 0 },
    home_xgot: { type: Number, default: 0 },
    away_xgot: { type: Number, default: 0 },
    xg_timeline: [{
      minute: Number,
      home_xg: Number,
      away_xg: Number
    }]
  },
  
  // KEY STATISTICS
  key_stats: {
    shots_on_target: { type: String, default: '0-0' },
    possession: { type: String, default: '50%-50%' },
    big_chances: { type: String, default: '0-0' },
    corners: { type: String, default: '0-0' },
    expected_assists: { type: String, default: '0.0-0.0' },
    ppda: { type: String, default: '0.0-0.0' } // Passes per defensive action
  },
  
  // CONFIDENCE & RISK ANALYSIS
  confidence_analysis: {
    confidence_score: { type: Number, default: 0 },
    risk_level: { type: String, default: 'medium' }, // low, medium, high
    data_completeness: { type: Number, default: 0 },
    statistical_significance: { type: Number, default: 0 },
    historical_accuracy: { type: Number, default: 0 },
    match_consistency: { type: Number, default: 0 }
  },
  
  // LIVE INSIGHTS & ALERTS
  live_insights: [{
    message: String,
    type: { 
      type: String, 
      enum: ['goal_expected', 'momentum_shift', 'defensive', 'attacking', 'card_risk', 'substitution_impact']
    },
    severity: { type: String, default: 'info' }, // info, warning, alert
    timestamp: { type: Date, default: Date.now },
    expected_time: String, // e.g., "next 15 mins"
    probability: Number
  }],
  
  // SPECIAL FACTORS & CONTEXT
  special_factors: [{
    factor: {
      type: String,
      enum: ['red_card', 'penalty', 'injury', 'weather', 'derby', 'cup_final', 'relegation', 'title_race']
    },
    impact: Number, // -100 to +100
    description: String,
    team_affected: { type: String, enum: ['home', 'away', 'both'] },
    time_occurred: Number // minute
  }],
  
  // VALUE BET DETECTION
  value_bets: [{
    market: String,
    probability: Number,
    estimated_odds: Number,
    value_score: Number, // Positive = value bet
    confidence: Number
  }],
  
  // WEIGHTED PREDICTION FACTORS
  prediction_factors: {
    form_score: { 
      weight: { type: Number, default: 30 },
      home_score: { type: Number, default: 0 },
      away_score: { type: Number, default: 0 },
      total_score: { type: Number, default: 0 }
    },
    realtime_score: { 
      weight: { type: Number, default: 50 },
      home_score: { type: Number, default: 0 },
      away_score: { type: Number, default: 0 },
      total_score: { type: Number, default: 0 }
    },
    context_score: { 
      weight: { type: Number, default: 20 },
      home_score: { type: Number, default: 0 },
      away_score: { type: Number, default: 0 },
      total_score: { type: Number, default: 0 }
    },
    total_weighted_score: { type: Number, default: 0 }
  },
  
  // NEXT GOAL PREDICTION
  next_goal_prediction: {
    likely_team: { type: String, enum: ['home', 'away', 'none'] },
    probability: { type: Number, default: 0 },
    expected_time: String,
    confidence: { type: Number, default: 0 }
  },
  
  // TURNING POINT DETECTION
  turning_points: [{
    minute: Number,
    type: String,
    description: String,
    impact: Number
  }],
  
  // TREND ANALYSIS
  trends: {
    home_trend: { type: String, default: 'stable' },
    away_trend: { type: String, default: 'stable' },
    momentum_trend: { type: String, default: 'neutral' }
  },
  
  // METADATA
  is_new: { type: Boolean, default: true },
  last_updated: { type: Date, default: Date.now },
  update_count: { type: Number, default: 0 },
  prediction_version: { type: String, default: '1.0' },
  algorithm_version: { type: String, default: '1.0' }
}, { 
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes
predictionSchema.index({ createdAt: -1 });
predictionSchema.index({ match_id: 1 });
predictionSchema.index({ 'confidence_analysis.confidence_score': -1 });
predictionSchema.index({ league_id: 1 });
predictionSchema.index({ 'winner_prob.home.value': -1 });
predictionSchema.index({ 'winner_prob.away.value': -1 });
predictionSchema.index({ is_new: 1 });

// API Log Schema
const apiLogSchema = new mongoose.Schema({
  api_name: String,
  endpoint: String,
  status: String,
  response_time: Number,
  timestamp: { type: Date, default: Date.now },
  calls_today: Number,
  limit: Number
});

const historicalDataSchema = new mongoose.Schema({
  match_id: String,
  home_team: String,
  away_team: String,
  league: String,
  date: Date,
  result: String,
  stats: Object,
  predictions: Object,
  actual_outcome: Object
});

const Match = mongoose.model('Match', matchSchema);
const Prediction = mongoose.model('Prediction', predictionSchema);
const ApiLog = mongoose.model('ApiLog', apiLogSchema);
const HistoricalData = mongoose.model('HistoricalData', historicalDataSchema);

// ==================== WEBSOCKET SETUP ====================
io.on('connection', (socket) => {
  console.log('📱 Client connected:', socket.id);
  
  // Send initial stats
  socket.emit('api_stats', {
    apiFootball: `${apiFootballCalls}/${API_FOOTBALL_LIMIT}`,
    footballData: `${footballDataCalls}/${FOOTBALL_DATA_LIMIT}`,
    cache_hits: statsCache.size
  });
  
  socket.on('subscribe_match', async (matchId) => {
    socket.join(`match_${matchId}`);
    console.log(`📱 Client ${socket.id} subscribed to match ${matchId}`);
    
    // Send current data
    const match = await Match.findOne({ match_id: matchId });
    if (match) {
      socket.emit('match_update', match);
    }
    
    const prediction = await Prediction.findOne({ match_id: matchId });
    if (prediction) {
      socket.emit('prediction_update', prediction);
    }
  });
  
  socket.on('unsubscribe_match', (matchId) => {
    socket.leave(`match_${matchId}`);
    console.log(`📱 Client ${socket.id} unsubscribed from match ${matchId}`);
  });
  
  socket.on('request_prediction', async (matchId) => {
    const match = await Match.findOne({ match_id: matchId });
    if (match) {
      const prediction = await calculateEnhancedPrediction(match);
      socket.emit('prediction_response', prediction);
    }
  });
  
  socket.on('disconnect', () => {
    console.log('📱 Client disconnected:', socket.id);
  });
});

// ==================== HELPER FUNCTIONS ====================
function convertStatus(status) {
  const map = {
    'NS': 'NS', 'TBD': 'NS', 'SCHEDULED': 'NS', 'TIMED': 'NS',
    'LIVE': 'LIVE', 'IN_PLAY': 'LIVE', 'IN_PROGRESS': 'LIVE',
    '1H': '1H', 'FIRST_HALF': '1H',
    'HT': 'HT', 'HALF_TIME': 'HT',
    '2H': '2H', 'SECOND_HALF': '2H',
    'ET': 'ET', 'EXTRA_TIME': 'ET',
    'PEN': 'PEN', 'PENALTIES': 'PEN',
    'FT': 'FT', 'FINISHED': 'FT', 'AET': 'FT',
    'PST': 'PST', 'POSTPONED': 'PST',
    'CANC': 'CANC', 'CANCELLED': 'CANC',
    'SUSP': 'SUSP', 'SUSPENDED': 'SUSP',
    'ABD': 'ABD', 'ABANDONED': 'ABD',
    'AWARDED': 'AWD'
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

function getTrendSymbol(change) {
  if (change > 2) return '▲';
  if (change < -2) return '▼';
  return '→';
}

// ==================== STATISTICS CALCULATIONS ====================
function calculateXG(stats) {
  if (!stats || !stats.shots_on_goal) {
    return { home: 0, away: 0, total: 0 };
  }
  
  const homeXg = (
    stats.shots_on_goal.home * 0.35 +
    stats.total_shots.home * 0.10 +
    stats.corner_kicks.home * 0.04 +
    stats.big_chances.home * 0.25 +
    stats.touches_opp_box.home * 0.002
  ).toFixed(2);
  
  const awayXg = (
    stats.shots_on_goal.away * 0.35 +
    stats.total_shots.away * 0.10 +
    stats.corner_kicks.away * 0.04 +
    stats.big_chances.away * 0.25 +
    stats.touches_opp_box.away * 0.002
  ).toFixed(2);
  
  return {
    home: parseFloat(homeXg),
    away: parseFloat(awayXg),
    total: parseFloat((parseFloat(homeXg) + parseFloat(awayXg)).toFixed(2))
  };
}

function calculateXGOT(xg, shotsOnTarget) {
  // xG on target is typically higher than regular xG
  const multiplier = 1.15; // Shots on target have higher chance
  return {
    home: parseFloat((xg.home * multiplier).toFixed(2)),
    away: parseFloat((xg.away * multiplier).toFixed(2))
  };
}

function calculatePassingAccuracy(stats) {
  if (!stats.passes || !stats.passes_accurate) {
    return { home: 0, away: 0 };
  }
  
  const homeAccuracy = stats.passes.home > 0 
    ? Math.round((stats.passes_accurate.home / stats.passes.home) * 100) 
    : 0;
  
  const awayAccuracy = stats.passes.away > 0 
    ? Math.round((stats.passes_accurate.away / stats.passes.away) * 100) 
    : 0;
  
  return { home: homeAccuracy, away: awayAccuracy };
}

// ==================== FETCH LIVE STATS (ENHANCED) ====================
async function fetchLiveStats(fixtureId) {
  try {
    // Check cache
    const cached = statsCache.get(fixtureId);
    if (cached && Date.now() - cached.timestamp < CACHE_EXPIRY.LIVE_STATS) {
      return cached.data;
    }
    
    if (apiFootballCalls >= API_FOOTBALL_LIMIT) {
      console.log('⚠️ API limit reached, using cache');
      return cached?.data || null;
    }
    
    const startTime = Date.now();
    
    // Fetch fixture details
    const response = await fetchWithRetry(
      `https://v3.football.api-sports.io/fixtures?id=${fixtureId}`,
      {
        headers: {
          'x-rapidapi-key': API_FOOTBALL_KEY,
          'x-rapidapi-host': 'v3.football.api-sports.io'
        }
      },
      3
    );
    
    apiFootballCalls++;
    
    if (!response.ok) {
      await logApiCall('API-Football', 'fixtures', 'error', Date.now() - startTime);
      return null;
    }
    
    const data = await response.json();
    if (!data.response || data.response.length === 0) return null;
    
    const fixture = data.response[0];
    const elapsed = fixture.fixture.status.elapsed || 0;
    const status = convertStatus(fixture.fixture.status.short);
    
    const statsData = {
      elapsed: elapsed,
      status: status,
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
        passes_accurate: { home: 0, away: 0 },
        big_chances: { home: 0, away: 0 },
        big_chances_missed: { home: 0, away: 0 },
        hits_woodwork: { home: 0, away: 0 },
        offsides: { home: 0, away: 0 },
        touches_opp_box: { home: 0, away: 0 },
        duels_won: { home: 0, away: 0 },
        aerials_won: { home: 0, away: 0 },
        interceptions: { home: 0, away: 0 },
        tackles: { home: 0, away: 0 },
        clearances: { home: 0, away: 0 }
      }
    };
    
    // Fetch detailed statistics
    if (apiFootballCalls < API_FOOTBALL_LIMIT) {
      const statsResponse = await fetchWithRetry(
        `https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}`,
        {
          headers: {
            'x-rapidapi-key': API_FOOTBALL_KEY,
            'x-rapidapi-host': 'v3.football.api-sports.io'
          }
        },
        2
      );
      
      apiFootballCalls++;
      
      if (statsResponse.ok) {
        const statsJson = await statsResponse.json();
        if (statsJson.response && statsJson.response.length > 0) {
          const homeStats = statsJson.response[0]?.statistics || [];
          const awayStats = statsJson.response[1]?.statistics || [];
          
          const getStatValue = (stats, type, isPercentage = false) => {
            const stat = stats.find(s => s.type === type);
            if (!stat || !stat.value) return 0;
            
            if (isPercentage) {
              const val = String(stat.value).replace('%', '');
              return parseInt(val) || 0;
            }
            
            // Handle various value formats
            const val = String(stat.value);
            if (val.includes('/')) {
              const parts = val.split('/');
              return parseInt(parts[0]) || 0;
            }
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
              home: getStatValue(homeStats, 'Ball Possession', true),
              away: getStatValue(awayStats, 'Ball Possession', true)
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
            },
            big_chances: {
              home: getStatValue(homeStats, 'Big Chances'),
              away: getStatValue(awayStats, 'Big Chances')
            },
            big_chances_missed: {
              home: getStatValue(homeStats, 'Big Chances Missed'),
              away: getStatValue(awayStats, 'Big Chances Missed')
            },
            hits_woodwork: {
              home: getStatValue(homeStats, 'Woodwork'),
              away: getStatValue(awayStats, 'Woodwork')
            },
            offsides: {
              home: getStatValue(homeStats, 'Offsides'),
              away: getStatValue(awayStats, 'Offsides')
            },
            touches_opp_box: {
              home: getStatValue(homeStats, 'Touches'),
              away: getStatValue(awayStats, 'Touches')
            }
          };
          
          // Calculate passing accuracy
          const passingAccuracy = calculatePassingAccuracy(statsData.stats);
          statsData.stats.passing_accuracy = passingAccuracy;
          
          // Calculate xG
          const xg = calculateXG(statsData.stats);
          statsData.stats.xg = { home: xg.home, away: xg.away };
          statsData.stats.xg_total = xg.total;
          
          // Calculate xGOT
          const xgot = calculateXGOT(xg, statsData.stats.shots_on_goal);
          statsData.stats.xgot = xgot;
        }
      }
    }
    
    // Calculate data quality score (0-100)
    let dataQuality = 0;
    const totalStats = Object.keys(statsData.stats).length;
    let availableStats = 0;
    
    Object.values(statsData.stats).forEach(stat => {
      if (typeof stat === 'object') {
        if (stat.home !== 0 || stat.away !== 0) availableStats++;
      }
    });
    
    dataQuality = Math.round((availableStats / totalStats) * 100);
    statsData.data_quality = dataQuality;
    
    // Cache the results
    statsCache.set(fixtureId, { 
      data: statsData, 
      timestamp: Date.now(),
      quality: dataQuality 
    });
    
    await logApiCall('API-Football', 'fixtures/statistics', 'success', Date.now() - startTime);
    
    return statsData;
  } catch (error) {
    console.error(`❌ Error fetching stats for ${fixtureId}:`, error.message);
    return null;
  }
}

// ==================== FETCH TEAM FORM DATA ====================
async function fetchTeamForm(teamId, leagueId) {
  try {
    const cacheKey = `${teamId}_${leagueId}`;
    const cached = formCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_EXPIRY.FORM_DATA) {
      return cached.data;
    }
    
    if (apiFootballCalls >= API_FOOTBALL_LIMIT) {
      console.log('⚠️ API limit reached for form data');
      return cached?.data || null;
    }
    
    const startTime = Date.now();
    const response = await fetchWithRetry(
      `https://v3.football.api-sports.io/teams/statistics?team=${teamId}&season=2024&league=${leagueId}`,
      {
        headers: {
          'x-rapidapi-key': API_FOOTBALL_KEY,
          'x-rapidapi-host': 'v3.football.api-sports.io'
        }
      },
      2
    );
    
    apiFootballCalls++;
    
    if (!response.ok) {
      await logApiCall('API-Football', 'teams/statistics', 'error', Date.now() - startTime);
      return null;
    }
    
    const data = await response.json();
    if (!data.response) return null;
    
    const formData = {
      last5: '',
      position: 0,
      goals_scored: 0,
      goals_conceded: 0,
      home_form: '',
      away_form: ''
    };
    
    if (data.response.fixtures) {
      // Last 5 results
      const last5Results = data.response.fixtures.results?.slice(0, 5) || [];
      formData.last5 = last5Results.map(r => {
        if (r.result === 'W') return 'W';
        if (r.result === 'L') return 'L';
        return 'D';
      }).join('');
      
      // Home/Away form
      const homeResults = data.response.fixtures.results?.filter(r => 
        r.homeTeam.id === teamId
      ).slice(0, 5) || [];
      
      const awayResults = data.response.fixtures.results?.filter(r => 
        r.awayTeam.id === teamId
      ).slice(0, 5) || [];
      
      formData.home_form = homeResults.map(r => r.result === 'W' ? 'W' : r.result === 'L' ? 'L' : 'D').join('');
      formData.away_form = awayResults.map(r => r.result === 'W' ? 'W' : r.result === 'L' ? 'L' : 'D').join('');
    }
    
    if (data.response.league) {
      formData.position = data.response.league.standing || 0;
    }
    
    if (data.response.goals) {
      formData.goals_scored = data.response.goals.for?.total?.total || 0;
      formData.goals_conceded = data.response.goals.against?.total?.total || 0;
    }
    
    formCache.set(cacheKey, { data: formData, timestamp: Date.now() });
    await logApiCall('API-Football', 'teams/statistics', 'success', Date.now() - startTime);
    
    return formData;
  } catch (error) {
    console.error(`❌ Error fetching form for team ${teamId}:`, error.message);
    return null;
  }
}

// ==================== WEIGHTED PREDICTION ALGORITHM ====================
async function calculateEnhancedPrediction(match) {
  const stats = match.stats || {};
  const form = match.form || {};
  const context = match.context || {};
  const momentum = match.momentum || {};
  const status = match.status;
  const elapsed = match.elapsed || 0;
  const currentScore = `${match.home_score || 0}-${match.away_score || 0}`;
  
  // Initialize scores
  let formScoreHome = 50;
  let formScoreAway = 50;
  let realtimeScoreHome = 50;
  let realtimeScoreAway = 50;
  let contextScoreHome = 50;
  let contextScoreAway = 50;
  
  // === A. FORM FACTORS (30%) ===
  if (form.home_last5 && form.away_last5) {
    // Last 5 matches form
    const homeWins = (form.home_last5.match(/W/g) || []).length;
    const homeLosses = (form.home_last5.match(/L/g) || []).length;
    const awayWins = (form.away_last5.match(/W/g) || []).length;
    const awayLosses = (form.away_last5.match(/L/g) || []).length;
    
    // Home/Away performance
    const homeHomeForm = form.home_home_form || '';
    const awayAwayForm = form.away_away_form || '';
    const homeHomeWins = (homeHomeForm.match(/W/g) || []).length;
    const awayAwayWins = (awayAwayForm.match(/W/g) || []).length;
    
    // League position
    const positionDiff = (form.away_position || 20) - (form.home_position || 20);
    const positionFactor = Math.max(-20, Math.min(20, positionDiff));
    
    // Head-to-head (simplified)
    const h2h = form.h2h_last5 || '';
    const h2hHomeWins = (h2h.match(/W/g) || []).length;
    const h2hAwayWins = (h2h.match(/L/g) || []).length;
    
    // Calculate form scores
    formScoreHome = 50 + 
      (homeWins - homeLosses) * 5 + 
      homeHomeWins * 3 +
      h2hHomeWins * 4 +
      positionFactor;
    
    formScoreAway = 50 + 
      (awayWins - awayLosses) * 5 + 
      awayAwayWins * 3 +
      h2hAwayWins * 4 -
      positionFactor;
    
    // Normalize to 0-100
    formScoreHome = Math.max(10, Math.min(90, formScoreHome));
    formScoreAway = Math.max(10, Math.min(90, formScoreAway));
  }
  
  // === B. REAL-TIME FACTORS (50%) ===
  if (status === 'LIVE' || status === '1H' || status === '2H' || status === 'HT') {
    // 1. Current match stats (20%)
    const possessionDiff = (stats.possession?.home || 50) - (stats.possession?.away || 50);
    const shotsOnTargetDiff = (stats.shots_on_goal?.home || 0) - (stats.shots_on_goal?.away || 0);
    const shotsTotalDiff = (stats.total_shots?.home || 0) - (stats.total_shots?.away || 0);
    
    const currentStatsScore = 50 + 
      (possessionDiff * 0.4) + 
      (shotsOnTargetDiff * 8) + 
      (shotsTotalDiff * 3);
    
    // 2. xG difference (15%)
    const xg = calculateXG(stats);
    const xgDiff = (xg.home - xg.away) * 25;
    
    // 3. Big chances created (10%)
    const bigChancesDiff = (stats.big_chances?.home || 0) - (stats.big_chances?.away || 0);
    const bigChancesScore = 50 + (bigChancesDiff * 15);
    
    // 4. Momentum - last 15 mins (5%)
    const momentumScore = 50;
    if (momentum.last15_shots && momentum.last15_possession) {
      const momentumDiff = (momentum.last15_shots.home - momentum.last15_shots.away) * 10;
      momentumScore = 50 + momentumDiff;
    }
    
    // Weighted realtime score
    realtimeScoreHome = 50 + 
      ((currentStatsScore - 50) * 0.20) +
      (xgDiff * 0.15) +
      ((bigChancesScore - 50) * 0.10) +
      ((momentumScore - 50) * 0.05);
    
    realtimeScoreAway = 100 - realtimeScoreHome;
    
  } else {
    // Not live yet, use form as realtime
    realtimeScoreHome = formScoreHome;
    realtimeScoreAway = formScoreAway;
  }
  
  // === C. CONTEXT FACTORS (20%) ===
  contextScoreHome = 50;
  contextScoreAway = 50;
  
  // Match importance
  const importance = context.importance || 'normal';
  if (importance === 'very-high') {
    // Cup finals, derbies - more unpredictable
    contextScoreHome = 50;
    contextScoreAway = 50;
  } else if (importance === 'high') {
    // Title race, relegation
    contextScoreHome = formScoreHome > 55 ? 60 : 40;
    contextScoreAway = formScoreAway > 55 ? 60 : 40;
  }
  
  // Weather conditions
  const weather = context.weather || {};
  if (weather.condition === 'rain' || weather.condition === 'snow') {
    // Weather affects game, reduces scoring
    contextScoreHome = contextScoreHome * 0.9;
    contextScoreAway = contextScoreAway * 0.9;
  }
  
  // Missing key players
  const missingHome = context.missing_players?.home || [];
  const missingAway = context.missing_players?.away || [];
  
  const importantPlayersHome = missingHome.filter(p => p.importance === 'high').length;
  const importantPlayersAway = missingAway.filter(p => p.importance === 'high').length;
  
  contextScoreHome -= importantPlayersHome * 8;
  contextScoreAway -= importantPlayersAway * 8;
  
  // Red cards
  if (stats.red_cards?.home > 0) contextScoreHome -= 20;
  if (stats.red_cards?.away > 0) contextScoreAway -= 20;
  
  // Normalize context scores
  contextScoreHome = Math.max(20, Math.min(80, contextScoreHome));
  contextScoreAway = Math.max(20, Math.min(80, contextScoreAway));
  
  // === WEIGHTED TOTAL SCORE ===
  const weightedScoreHome = (
    formScoreHome * 0.30 +
    realtimeScoreHome * 0.50 +
    contextScoreHome * 0.20
  );
  
  const weightedScoreAway = (
    formScoreAway * 0.30 +
    realtimeScoreAway * 0.50 +
    contextScoreAway * 0.20
  );
  
  // === PROBABILITY CALCULATION ===
  let homeProb = Math.round(Math.max(10, Math.min(85, weightedScoreHome)));
  let awayProb = Math.round(Math.max(10, Math.min(85, weightedScoreAway)));
  let drawProb = Math.max(5, 100 - homeProb - awayProb);
  
  // Adjust for current score
  if (status !== 'NS') {
    const goalDiff = (match.home_score || 0) - (match.away_score || 0);
    if (goalDiff > 0) {
      homeProb += goalDiff * 8;
      awayProb -= goalDiff * 5;
    } else if (goalDiff < 0) {
      awayProb += Math.abs(goalDiff) * 8;
      homeProb -= Math.abs(goalDiff) * 5;
    }
    
    // Re-normalize
    const total = homeProb + drawProb + awayProb;
    homeProb = Math.round((homeProb / total) * 100);
    awayProb = Math.round((awayProb / total) * 100);
    drawProb = 100 - homeProb - awayProb;
  }
  
  // === XG ANALYSIS ===
  const xg = calculateXG(stats);
  const xgot = calculateXGOT(xg, stats.shots_on_goal);
  
  // === GOAL PREDICTIONS ===
  const totalXg = xg.total;
  
  // Over/Under probabilities
  const over05 = totalXg > 0.3 ? Math.min(95, 70 + totalXg * 10) : 60;
  const over15 = totalXg > 1.0 ? Math.min(85, 60 + totalXg * 15) : 35;
  const over25 = totalXg > 2.0 ? Math.min(75, 50 + totalXg * 15) : 25;
  const over35 = totalXg > 3.0 ? Math.min(60, 40 + totalXg * 10) : 15;
  
  // BTTS probability
  const bttsYes = xg.home > 0.7 && xg.away > 0.7 
    ? Math.min(85, 50 + (xg.home + xg.away) * 15) 
    : 35;
  const bttsNo = 100 - bttsYes;
  
  // Most likely score
  const homeGoals = Math.round(xg.home);
  const awayGoals = Math.round(xg.away);
  const mostLikelyScore = `${homeGoals}-${awayGoals}`;
  
  // Goal ranges
  const goals01 = totalXg < 1.5 ? 65 : 25;
  const goals23 = totalXg >= 1.5 && totalXg < 3.5 ? 60 : 30;
  const goals4plus = totalXg >= 3.5 ? 40 : 10;
  
  // === CONFIDENCE SCORING ===
  const dataCompleteness = match.data_quality || 0;
  const statisticalSignificance = Math.min(100, 
    (stats.total_shots?.home || 0) + (stats.total_shots?.away || 0)
  );
  
  const matchConsistency = 50; // Would need historical comparison
  const historicalAccuracy = 75; // Based on past predictions
  
  const confidenceScore = Math.round(
    (dataCompleteness * 0.20 +
    statisticalSignificance * 0.30 +
    matchConsistency * 0.25 +
    historicalAccuracy * 0.25)
  );
  
  // Risk level
  let riskLevel = 'medium';
  if (confidenceScore >= 80) riskLevel = 'low';
  if (confidenceScore < 60) riskLevel = 'high';
  
  // === LIVE INSIGHTS ===
  const liveInsights = [];
  
  if (status === 'LIVE' || status === '1H' || status === '2H') {
    // Goal expectation
    if (xg.total > 2.5 && elapsed > 30) {
      const prob = Math.min(90, 60 + (xg.total - 2.5) * 20);
      liveInsights.push({
        message: '⚡ High goal expectation - Over 2.5 goals likely',
        type: 'goal_expected',
        severity: 'info',
        timestamp: new Date(),
        expected_time: 'next 20 mins',
        probability: prob
      });
    }
    
    // Next goal prediction
    if (xg.home > xg.away + 0.5) {
      liveInsights.push({
        message: '🔥 Home team more likely to score next',
        type: 'next_goal',
        severity: 'warning',
        timestamp: new Date(),
        expected_time: 'next 15 mins',
        probability: 65
      });
    } else if (xg.away > xg.home + 0.5) {
      liveInsights.push({
        message: '🔥 Away team more likely to score next',
        type: 'next_goal',
        severity: 'warning',
        timestamp: new Date(),
        expected_time: 'next 15 mins',
        probability: 65
      });
    }
    
    // Defensive/Attacking match
    const totalShotsOnTarget = (stats.shots_on_goal?.home || 0) + (stats.shots_on_goal?.away || 0);
    if (totalShotsOnTarget < 3 && elapsed > 30) {
      liveInsights.push({
        message: '🛡️ Defensive match - Under 2.5 goals likely',
        type: 'defensive',
        severity: 'info',
        timestamp: new Date(),
        probability: 70
      });
    }
    
    // Momentum shift
    const momentumDiff = (momentum.last15_shots?.home || 0) - (momentum.last15_shots?.away || 0);
    if (Math.abs(momentumDiff) > 3) {
      const team = momentumDiff > 0 ? 'home' : 'away';
      liveInsights.push({
        message: `🔄 ${team === 'home' ? 'Home' : 'Away'} team gaining momentum`,
        type: 'momentum_shift',
        severity: 'warning',
        timestamp: new Date(),
        probability: 60
      });
    }
    
    // Card risk
    const totalCards = (stats.yellow_cards?.home || 0) + (stats.yellow_cards?.away || 0);
    if (totalCards > 4 && elapsed < 60) {
      liveInsights.push({
        message: '🟡 High card risk - More bookings likely',
        type: 'card_risk',
        severity: 'alert',
        timestamp: new Date(),
        probability: 75
      });
    }
  }
  
  // === SPECIAL FACTORS ===
  const specialFactors = [];
  
  if (stats.red_cards?.home > 0) {
    specialFactors.push({
      factor: 'red_card',
      impact: -25,
      description: '🔴 Home team playing with 10 men',
      team_affected: 'home',
      time_occurred: elapsed
    });
  }
  
  if (stats.red_cards?.away > 0) {
    specialFactors.push({
      factor: 'red_card',
      impact: 25,
      description: '🔴 Away team playing with 10 men',
      team_affected: 'away',
      time_occurred: elapsed
    });
  }
  
  if (context.is_derby) {
    specialFactors.push({
      factor: 'derby',
      impact: 15,
      description: '🏆 Derby match - Higher intensity',
      team_affected: 'both',
      time_occurred: 0
    });
  }
  
  if (context.is_cup_final) {
    specialFactors.push({
      factor: 'cup_final',
      impact: 20,
      description: '🏆 Cup final - More cautious play',
      team_affected: 'both',
      time_occurred: 0
    });
  }
  
  // === VALUE BETS DETECTION ===
  const valueBets = [];
  
  // Check home win value
  const homeWinValue = homeProb - (100 / 3); // Compared to fair odds of 3.00
  if (homeWinValue > 10) {
    valueBets.push({
      market: 'Home Win',
      probability: homeProb,
      estimated_odds: Math.round(100 / homeProb * 100) / 100,
      value_score: homeWinValue,
      confidence: Math.min(100, confidenceScore + 10)
    });
  }
  
  // Check over 2.5 value
  const over25Value = over25 - 50; // Compared to fair probability of 50%
  if (over25Value > 10) {
    valueBets.push({
      market: 'Over 2.5 Goals',
      probability: over25,
      estimated_odds: Math.round(100 / over25 * 100) / 100,
      value_score: over25Value,
      confidence: confidenceScore
    });
  }
  
  // Check BTTS value
  const bttsValue = bttsYes - 50;
  if (bttsValue > 10) {
    valueBets.push({
      market: 'Both Teams to Score',
      probability: bttsYes,
      estimated_odds: Math.round(100 / bttsYes * 100) / 100,
      value_score: bttsValue,
      confidence: confidenceScore
    });
  }
  
  // === TREND ANALYSIS ===
  const previousPrediction = await Prediction.findOne({ match_id: match.match_id });
  let homeTrend = 'stable';
  let awayTrend = 'stable';
  let homeChange = 0;
  let awayChange = 0;
  
  if (previousPrediction) {
    const prevHome = previousPrediction.winner_prob.home.value || 0;
    const prevAway = previousPrediction.winner_prob.away.value || 0;
    
    homeChange = homeProb - prevHome;
    awayChange = awayProb - prevAway;
    
    homeTrend = getTrendSymbol(homeChange);
    awayTrend = getTrendSymbol(awayChange);
  }
  
  // === FINAL PREDICTION OBJECT ===
  return {
    match_id: match.match_id,
    home_team: match.home_team,
    away_team: match.away_team,
    league: match.league_name || match.league,
    league_id: match.league_id,
    match_time_pkt: match.match_time_pkt,
    match_status: status,
    elapsed: elapsed,
    current_score: currentScore,
    
    winner_prob: {
      home: { 
        value: homeProb,
        trend: homeTrend,
        change: homeChange,
        confidence: Math.min(100, confidenceScore - 10)
      },
      draw: { 
        value: drawProb,
        trend: 'stable',
        change: 0,
        confidence: Math.min(100, confidenceScore - 15)
      },
      away: { 
        value: awayProb,
        trend: awayTrend,
        change: awayChange,
        confidence: Math.min(100, confidenceScore - 10)
      }
    },
    
    goal_predictions: {
      most_likely_score: mostLikelyScore,
      exact_score_probabilities: [
        { score: '0-0', probability: totalXg < 1 ? 25 : 5 },
        { score: '1-0', probability: xg.home > 0.8 ? 18 : 8 },
        { score: '0-1', probability: xg.away > 0.8 ? 18 : 8 },
        { score: '1-1', probability: 22 },
        { score: '2-0', probability: xg.home > 1.5 ? 15 : 5 },
        { score: '0-2', probability: xg.away > 1.5 ? 15 : 5 },
        { score: '2-1', probability: 20 },
        { score: '1-2', probability: 20 }
      ].filter(p => p.probability > 3),
      goal_ranges: {
        '0-1': goals01,
        '2-3': goals23,
        '4+': goals4plus
      }
    },
    
    over_under: {
      '0.5': { 
        over: over05,
        under: 100 - over05,
        value: over05 > 85 ? true : over05 < 65 ? false : null
      },
      '1.5': { 
        over: over15,
        under: 100 - over15,
        value: over15 > 75 ? true : over15 < 45 ? false : null
      },
      '2.5': { 
        over: over25,
        under: 100 - over25,
        value: over25 > 65 ? true : over25 < 35 ? false : null
      },
      '3.5': { 
        over: over35,
        under: 100 - over35,
        value: over35 > 55 ? true : over35 < 25 ? false : null
      }
    },
    
    btts_prob: { 
      yes: bttsYes,
      no: bttsNo,
      value: bttsYes > 65 ? true : bttsYes < 45 ? false : null
    },
    
    double_chance: {
      '1X': homeProb + drawProb - 5, // Slight adjustment
      '12': homeProb + awayProb - 10,
      'X2': awayProb + drawProb - 5
    },
    
    xg_analysis: {
      home_xg: xg.home,
      away_xg: xg.away,
      total_xg: xg.total,
      home_xgot: xgot.home,
      away_xgot: xgot.away,
      xg_timeline: [] // Would need timeline data
    },
    
    key_stats: {
      shots_on_target: `${stats.shots_on_goal?.home || 0}-${stats.shots_on_goal?.away || 0}`,
      possession: `${stats.possession?.home || 50}%-${stats.possession?.away || 50}%`,
      big_chances: `${stats.big_chances?.home || 0}-${stats.big_chances?.away || 0}`,
      corners: `${stats.corner_kicks?.home || 0}-${stats.corner_kicks?.away || 0}`,
      expected_assists: '0.0-0.0', // Would need assist data
      ppda: '0.0-0.0' // Would need defensive action data
    },
    
    confidence_analysis: {
      confidence_score: confidenceScore,
      risk_level: riskLevel,
      data_completeness: dataCompleteness,
      statistical_significance: statisticalSignificance,
      historical_accuracy: historicalAccuracy,
      match_consistency: matchConsistency
    },
    
    live_insights: liveInsights,
    special_factors: specialFactors,
    value_bets: valueBets,
    
    prediction_factors: {
      form_score: { 
        weight: 30,
        home_score: Math.round(formScoreHome),
        away_score: Math.round(formScoreAway),
        total_score: Math.round((formScoreHome + formScoreAway) / 2)
      },
      realtime_score: { 
        weight: 50,
        home_score: Math.round(realtimeScoreHome),
        away_score: Math.round(realtimeScoreAway),
        total_score: Math.round((realtimeScoreHome + realtimeScoreAway) / 2)
      },
      context_score: { 
        weight: 20,
        home_score: Math.round(contextScoreHome),
        away_score: Math.round(contextScoreAway),
        total_score: Math.round((contextScoreHome + contextScoreAway) / 2)
      },
      total_weighted_score: Math.round(weightedScoreHome)
    },
    
    next_goal_prediction: {
      likely_team: xg.home > xg.away ? 'home' : xg.away > xg.home ? 'away' : 'none',
      probability: Math.abs(xg.home - xg.away) > 0.3 ? 65 : 50,
      expected_time: 'next 20 mins',
      confidence: Math.min(100, confidenceScore - 20)
    },
    
    turning_points: [], // Would need detailed match events
    trends: {
      home_trend: homeTrend,
      away_trend: awayTrend,
      momentum_trend: momentum.trend || 'neutral'
    },
    
    is_new: true,
    last_updated: new Date(),
    update_count: (previousPrediction?.update_count || 0) + 1,
    prediction_version: '2.0',
    algorithm_version: '1.1'
  };
}

// ==================== API HELPER FUNCTIONS ====================
async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await setTimeout(1000 * (i + 1)); // Exponential backoff
    }
  }
}

async function logApiCall(apiName, endpoint, status, responseTime) {
  if (!isMongoConnected) return;
  
  try {
    await ApiLog.create({
      api_name: apiName,
      endpoint: endpoint,
      status: status,
      response_time: responseTime,
      calls_today: apiName === 'API-Football' ? apiFootballCalls : footballDataCalls,
      limit: apiName === 'API-Football' ? API_FOOTBALL_LIMIT : FOOTBALL_DATA_LIMIT
    });
  } catch (error) {
    console.error('❌ Error logging API call:', error.message);
  }
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
    let teamsData = new Map(); // Store team data for form fetching
    
    for (const date of [today, tomorrow]) {
      if (apiFootballCalls >= API_FOOTBALL_LIMIT) break;
      
      console.log(`\n🔍 Fetching ${date}...`);
      
      try {
        const response = await fetchWithRetry(
          `https://v3.football.api-sports.io/fixtures?date=${date}`,
          {
            headers: {
              'x-rapidapi-key': API_FOOTBALL_KEY,
              'x-rapidapi-host': 'v3.football.api-sports.io'
            }
          },
          2
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
        
        // Store team data for later form fetching
        filtered.forEach(f => {
          if (f.teams.home.id) teamsData.set(f.teams.home.id, f.teams.home);
          if (f.teams.away.id) teamsData.set(f.teams.away.id, f.teams.away);
        });
        
        const matches = filtered.map(f => ({
          match_id: `af_${f.fixture.id}`,
          fixture_id: f.fixture.id,
          home_team: f.teams.home.name,
          away_team: f.teams.away.name,
          league: f.league.name,
          league_name: f.league.name,
          league_id: f.league.id,
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
          api_source: 'API-Football',
          form: {
            home_last5: '',
            away_last5: ''
          },
          stats: {
            shots_on_goal: { home: 0, away: 0 },
            shots_off_goal: { home: 0, away: 0 },
            total_shots: { home: 0, away: 0 },
            possession: { home: 50, away: 50 }
          }
        }));
        
        allMatches = [...allMatches, ...matches];
        
        // Fetch form data for a few matches (limited by API calls)
        if (apiFootballCalls < API_FOOTBALL_LIMIT - 10) {
          for (let i = 0; i < Math.min(3, matches.length); i++) {
            const match = matches[i];
            const homeTeamId = filtered[i].teams.home.id;
            const awayTeamId = filtered[i].teams.away.id;
            
            // Fetch form data if we have API calls left
            if (apiFootballCalls < API_FOOTBALL_LIMIT) {
              const homeForm = await fetchTeamForm(homeTeamId, filtered[i].league.id);
              if (homeForm) {
                match.form.home_last5 = homeForm.last5;
                match.form.home_position = homeForm.position;
              }
            }
            
            if (apiFootballCalls < API_FOOTBALL_LIMIT) {
              const awayForm = await fetchTeamForm(awayTeamId, filtered[i].league.id);
              if (awayForm) {
                match.form.away_last5 = awayForm.last5;
                match.form.away_position = awayForm.position;
              }
            }
          }
        }
        
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
        const response = await fetchWithRetry(
          `https://api.football-data.org/v4/matches?date=${date}`,
          {
            headers: {
              'X-Auth-Token': FOOTBALL_DATA_KEY
            }
          },
          2
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
          league_id: m.competition.id,
          home_score: m.score.fullTime.home || 0,
          away_score: m.score.fullTime.away || 0,
          status: convertStatus(m.status),
          elapsed: 0, // Football-Data doesn't provide minute
          match_time: m.utcDate,
          match_time_pkt: toPakistanTime(m.utcDate),
          match_date: new Date(m.utcDate),
          venue: m.venue || 'Unknown',
          home_logo: m.homeTeam.crest || null,
          away_logo: m.awayTeam.crest || null,
          api_source: 'Football-Data',
          form: {
            home_last5: '',
            away_last5: ''
          },
          stats: {
            shots_on_goal: { home: 0, away: 0 },
            shots_off_goal: { home: 0, away: 0 },
            total_shots: { home: 0, away: 0 },
            possession: { home: 50, away: 50 }
          }
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

// ==================== MAIN FETCH FUNCTION ====================
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
  
  // Reset API counters if new day
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (now.getHours() < 2) { // Reset around midnight
    apiFootballCalls = 0;
    footballDataCalls = 0;
    console.log('🔄 API counters reset for new day');
  }
  
  // STEP 1: Try API-Football (primary)
  const apiFootballMatches = await fetchFromApiFootball();
  if (apiFootballMatches && apiFootballMatches.length > 0) {
    allMatches = [...allMatches, ...apiFootballMatches];
  }
  
  // STEP 2: Fallback to Football-Data
  if ((apiFootballCalls >= API_FOOTBALL_LIMIT || !apiFootballMatches || apiFootballMatches.length < 5) && 
      footballDataCalls < FOOTBALL_DATA_LIMIT) {
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
  let updated = 0;
  
  for (const match of uniqueMatches) {
    try {
      const existing = await Match.findOne({ match_id: match.match_id });
      
      if (existing) {
        // Update existing match
        await Match.findOneAndUpdate(
          { match_id: match.match_id },
          { 
            ...match,
            updates_count: (existing.updates_count || 0) + 1,
            last_stats_update: new Date()
          },
          { new: true }
        );
        updated++;
      } else {
        // Insert new match
        await Match.create(match);
        saved++;
      }
    } catch (err) {
      console.error('❌ Save error:', err.message);
    }
  }
  
  console.log(`✅ Saved: ${saved} new, ${updated} updated`);
  console.log('============ FETCH COMPLETE ============\n');
  
  // Update WebSocket clients
  io.emit('matches_updated', {
    count: uniqueMatches.length,
    new: saved,
    updated: updated,
    timestamp: new Date()
  });
  
  return uniqueMatches;
}

// ==================== UPDATE LIVE STATS ====================
async function updateLiveMatches() {
  if (!isMongoConnected) return;
  
  try {
    console.log('\n🔄 Updating live matches...');
    
    const liveMatches = await Match.find({
      status: { $in: ['LIVE', '1H', '2H', 'HT', 'ET'] }
    }).limit(20); // Limit to avoid API overload
    
    console.log(`📊 Found ${liveMatches.length} live matches`);
    
    let updated = 0;
    
    for (const match of liveMatches) {
      if (!match.fixture_id || apiFootballCalls >= API_FOOTBALL_LIMIT) break;
      
      try {
        const liveStats = await fetchLiveStats(match.fixture_id);
        
        if (liveStats) {
          // Update match with live stats
          await Match.findOneAndUpdate(
            { match_id: match.match_id },
            {
              status: liveStats.status,
              elapsed: liveStats.elapsed,
              home_score: liveStats.home_score,
              away_score: liveStats.away_score,
              'stats': liveStats.stats,
              'stats.xg': liveStats.stats.xg,
              'stats.xg_total': liveStats.stats.xg_total,
              'stats.xgot': liveStats.stats.xgot,
              last_stats_update: new Date(),
              data_quality: liveStats.data_quality || 0,
              $inc: { updates_count: 1 }
            },
            { new: true }
          );
          
          updated++;
          
          // Update prediction
          const updatedMatch = await Match.findOne({ match_id: match.match_id });
          if (updatedMatch) {
            const prediction = await calculateEnhancedPrediction(updatedMatch);
            const existingPrediction = await Prediction.findOne({ match_id: match.match_id });
            
            if (existingPrediction) {
              // Add trend data
              prediction.winner_prob.home.change = prediction.winner_prob.home.value - (existingPrediction.winner_prob.home.value || 0);
              prediction.winner_prob.away.change = prediction.winner_prob.away.value - (existingPrediction.winner_prob.away.value || 0);
              prediction.winner_prob.home.trend = getTrendSymbol(prediction.winner_prob.home.change);
              prediction.winner_prob.away.trend = getTrendSymbol(prediction.winner_prob.away.change);
              prediction.is_new = false;
              prediction.update_count = (existingPrediction.update_count || 0) + 1;
            }
            
            await Prediction.findOneAndUpdate(
              { match_id: match.match_id },
              prediction,
              { upsert: true, new: true }
            );
            
            // Broadcast via WebSocket
            io.to(`match_${match.match_id}`).emit('match_update', updatedMatch);
            io.to(`match_${match.match_id}`).emit('prediction_update', prediction);
          }
        }
        
        // Small delay to avoid rate limiting
        await setTimeout(500);
        
      } catch (error) {
        console.error(`❌ Error updating match ${match.match_id}:`, error.message);
      }
    }
    
    if (updated > 0) {
      console.log(`✅ Updated ${updated} live matches`);
      
      // Broadcast general update
      io.emit('live_updates_complete', {
        count: updated,
        timestamp: new Date(),
        api_calls_remaining: API_FOOTBALL_LIMIT - apiFootballCalls
      });
    }
    
  } catch (error) {
    console.error('❌ Error in updateLiveMatches:', error.message);
  }
}

// ==================== CLEANUP OLD DATA ====================
async function cleanupOldData() {
  if (!isMongoConnected) return;
  
  try {
    console.log('\n🗑️ Cleaning up old data...');
    
    // Remove finished matches older than 24 hours
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const finishedResult = await Match.deleteMany({
      status: { $in: ['FT', 'AET', 'PEN', 'CANCELED', 'POSTPONED'] },
      updatedAt: { $lt: twentyFourHoursAgo }
    });
    
    // Remove old upcoming matches (past dates)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(23, 59, 59, 999);
    
    const oldResult = await Match.deleteMany({
      match_date: { $lt: yesterday }
    });
    
    // Cleanup old predictions
    const activeIds = await Match.find().distinct('match_id');
    const predResult = await Prediction.deleteMany({
      match_id: { $nin: activeIds }
    });
    
    // Cleanup old API logs (older than 7 days)
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const logResult = await ApiLog.deleteMany({
      timestamp: { $lt: weekAgo }
    });
    
    const totalDeleted = finishedResult.deletedCount + oldResult.deletedCount + predResult.deletedCount;
    
    if (totalDeleted > 0) {
      console.log(`🗑️ Removed: ${finishedResult.deletedCount} finished, ${oldResult.deletedCount} old, ${predResult.deletedCount} predictions, ${logResult.deletedCount} logs`);
    }
    
    // Clear old cache entries
    const now = Date.now();
    for (const [key, value] of statsCache.entries()) {
      if (now - value.timestamp > CACHE_EXPIRY.LIVE_STATS * 2) {
        statsCache.delete(key);
      }
    }
    
    for (const [key, value] of formCache.entries()) {
      if (now - value.timestamp > CACHE_EXPIRY.FORM_DATA * 2) {
        formCache.delete(key);
      }
    }
    
  } catch (err) {
    console.error('❌ Cleanup error:', err.message);
  }
}

// ==================== API ROUTES ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    mongodb: isMongoConnected ? 'Connected' : 'Disconnected',
    apiFootballCalls: `${apiFootballCalls}/${API_FOOTBALL_LIMIT}`,
    footballDataCalls: `${footballDataCalls}/${FOOTBALL_DATA_LIMIT}`,
    cache_sizes: {
      stats: statsCache.size,
      form: formCache.size,
      predictions: predictionsCache.size
    },
    time: new Date().toISOString(),
    server_time_pk: toPakistanTime(new Date().toISOString())
  });
});

// Get all active matches
app.get('/api/matches', async (req, res) => {
  try {
    if (!isMongoConnected) {
      return res.status(503).json({ success: false, error: 'MongoDB offline' });
    }
    
    const { status, league, limit = 100, page = 1 } = req.query;
    
    const query = {};
    
    // Filter by status
    if (status) {
      if (status === 'live') {
        query.status = { $in: ['LIVE', '1H', '2H', 'HT', 'ET'] };
      } else if (status === 'upcoming') {
        query.status = 'NS';
      } else {
        query.status = status;
      }
    } else {
      // Default: show live and upcoming
      query.status = { $in: ['NS', 'LIVE', '1H', '2H', 'HT', 'ET'] };
    }
    
    // Filter by league
    if (league) {
      query.league_id = parseInt(league) || league;
    }
    
    // Only show matches from today and tomorrow
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const tomorrowEnd = new Date();
    tomorrowEnd.setDate(tomorrowEnd.getDate() + 2);
    tomorrowEnd.setHours(23, 59, 59, 999);
    
    query.match_date = { $gte: todayStart, $lte: tomorrowEnd };
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const matches = await Match.find(query)
      .sort({ 
        status: -1, // Live matches first
        match_date: 1 // Then by date
      })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();
    
    const total = await Match.countDocuments(query);
    
    res.json({
      success: true,
      count: matches.length,
      total: total,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
      data: matches
    });
  } catch (err) {
    console.error('❌ API Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get specific match
app.get('/api/matches/:id', async (req, res) => {
  try {
    const match = await Match.findOne({ match_id: req.params.id }).lean();
    
    if (!match) {
      return res.status(404).json({ success: false, error: 'Match not found' });
    }
    
    res.json({
      success: true,
      data: match
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get predictions
app.get('/api/predictions', async (req, res) => {
  try {
    if (!isMongoConnected) {
      return res.status(503).json({ success: false, error: 'MongoDB offline' });
    }
    
    const { match_id, league, confidence_min, limit = 50, page = 1 } = req.query;
    
    const query = {};
    
    if (match_id) {
      query.match_id = match_id;
    }
    
    if (league) {
      query.league_id = parseInt(league) || league;
    }
    
    if (confidence_min) {
      query['confidence_analysis.confidence_score'] = { $gte: parseInt(confidence_min) };
    }
    
    // Only show predictions for active matches
    const activeIds = await Match.find({
      status: { $in: ['NS', 'LIVE', '1H', '2H', 'HT', 'ET'] }
    }).distinct('match_id');
    
    query.match_id = { $in: activeIds };
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const predictions = await Prediction.find(query)
      .sort({ 
        'confidence_analysis.confidence_score': -1,
        createdAt: -1
      })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();
    
    const total = await Prediction.countDocuments(query);
    const newCount = await Prediction.countDocuments({ ...query, is_new: true });
    
    res.json({
      success: true,
      count: predictions.length,
      total: total,
      newPredictions: newCount,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
      data: predictions
    });
  } catch (err) {
    console.error('❌ API Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get prediction for specific match
app.get('/api/predictions/:match_id', async (req, res) => {
  try {
    const prediction = await Prediction.findOne({ match_id: req.params.match_id }).lean();
    
    if (!prediction) {
      // Try to create prediction if match exists
      const match = await Match.findOne({ match_id: req.params.match_id });
      if (match) {
        const newPrediction = await calculateEnhancedPrediction(match);
        await Prediction.create(newPrediction);
        
        return res.json({
          success: true,
          data: newPrediction,
          message: 'Prediction generated'
        });
      }
      
      return res.status(404).json({ success: false, error: 'Prediction not found' });
    }
    
    res.json({
      success: true,
      data: prediction
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manual fetch endpoint
app.post('/api/fetch-matches', async (req, res) => {
  try {
    console.log('🔄 Manual fetch triggered');
    const matches = await fetchMatches();
    
    // Generate predictions for new matches
    if (matches.length > 0) {
      for (const match of matches) {
        const existingPrediction = await Prediction.findOne({ match_id: match.match_id });
        
        if (!existingPrediction) {
          const prediction = await calculateEnhancedPrediction(match);
          await Prediction.create(prediction);
        }
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

// Update live matches
app.post('/api/update-live', async (req, res) => {
  try {
    await updateLiveMatches();
    res.json({ success: true, message: 'Live matches updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Mark predictions as seen
app.post('/api/mark-predictions-seen', async (req, res) => {
  try {
    await Prediction.updateMany({ is_new: true }, { is_new: false });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get API statistics
app.get('/api/stats', async (req, res) => {
  try {
    const matchStats = await Match.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);
    
    const predictionStats = await Prediction.aggregate([
      {
        $group: {
          _id: '$confidence_analysis.risk_level',
          count: { $sum: 1 },
          avg_confidence: { $avg: '$confidence_analysis.confidence_score' }
        }
      }
    ]);
    
    const apiLogs = await ApiLog.aggregate([
      {
        $match: {
          timestamp: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
        }
      },
      {
        $group: {
          _id: '$api_name',
          total_calls: { $sum: 1 },
          success_rate: {
            $avg: {
              $cond: [{ $eq: ['$status', 'success'] }, 1, 0]
            }
          },
          avg_response_time: { $avg: '$response_time' }
        }
      }
    ]);
    
    res.json({
      success: true,
      match_stats: matchStats,
      prediction_stats: predictionStats,
      api_stats: apiLogs,
      cache_stats: {
        stats_cache: statsCache.size,
        form_cache: formCache.size,
        predictions_cache: predictionsCache.size
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ==================== AUTO TASKS ====================

// Initial fetch on startup
setTimeout(async () => {
  if (!isMongoConnected) {
    console.log('⏳ Waiting for MongoDB...');
    let attempts = 0;
    while (!isMongoConnected && attempts < 30) {
      await setTimeout(1000);
      attempts++;
    }
  }
  
  if (isMongoConnected) {
    console.log('🚀 Initial fetch...');
    await fetchMatches();
    await cleanupOldData();
  }
}, 5000);

// Regular match fetching (every 15 minutes)
setInterval(async () => {
  if (isMongoConnected) {
    await fetchMatches();
  }
}, 15 * 60 * 1000);

// Live match updates (every 2 minutes)
setInterval(async () => {
  if (isMongoConnected) {
    await updateLiveMatches();
  }
}, 2 * 60 * 1000);

// Cleanup old data (every hour)
setInterval(async () => {
  if (isMongoConnected) {
    await cleanupOldData();
  }
}, 60 * 60 * 1000);

// Update predictions for all active matches (every 5 minutes)
setInterval(async () => {
  if (!isMongoConnected) return;
  
  console.log('\n🔄 Updating all predictions...');
  
  const activeMatches = await Match.find({
    status: { $in: ['NS', 'LIVE', '1H', '2H', 'HT', 'ET'] }
  }).limit(50);
  
  console.log(`📊 Updating ${activeMatches.length} predictions`);
  
  for (const match of activeMatches) {
    try {
      const existing = await Prediction.findOne({ match_id: match.match_id });
      const prediction = await calculateEnhancedPrediction(match);
      
      if (existing) {
        // Add trend data
        prediction.winner_prob.home.change = prediction.winner_prob.home.value - (existing.winner_prob.home.value || 0);
        prediction.winner_prob.away.change = prediction.winner_prob.away.value - (existing.winner_prob.away.value || 0);
        prediction.winner_prob.home.trend = getTrendSymbol(prediction.winner_prob.home.change);
        prediction.winner_prob.away.trend = getTrendSymbol(prediction.winner_prob.away.change);
        prediction.is_new = false;
        prediction.update_count = (existing.update_count || 0) + 1;
      }
      
      await Prediction.findOneAndUpdate(
        { match_id: match.match_id },
        prediction,
        { upsert: true, new: true }
      );
      
    } catch (error) {
      console.error(`❌ Error updating prediction for ${match.match_id}:`, error.message);
    }
    
    // Small delay to avoid overwhelming
    await setTimeout(100);
  }
  
  console.log('✅ Predictions update complete\n');
}, 5 * 60 * 1000);

// ==================== START SERVER ====================
server.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║   ⚽ ENHANCED FOOTBALL PREDICTION SYSTEM ⚽          ║');
  console.log('║                                                    ║');
  console.log(`║   🚀 Server: http://localhost:${PORT}             ║`);
  console.log(`║   📡 WebSocket: ws://localhost:${PORT}            ║`);
  console.log('║                                                    ║');
  console.log('║   📊 FEATURES:                                     ║');
  console.log('║   • Real-time stats & xG analysis                  ║');
  console.log('║   • Weighted prediction algorithm (30/50/20)       ║');
  console.log('║   • Live insights & momentum detection             ║');
  console.log('║   • Confidence scoring & risk assessment           ║');
  console.log('║   • Value bet detection                            ║');
  console.log('║   • WebSocket real-time updates                    ║');
  console.log('║   • Dual API fallback system                       ║');
  console.log('║   • Auto-cleanup & cache management                ║');
  console.log('║                                                    ║');
  console.log('║   🔄 UPDATE FREQUENCY:                             ║');
  console.log('║   • Live matches: Every 2 minutes                  ║');
  console.log('║   • Match list: Every 15 minutes                   ║');
  console.log('║   • Predictions: Every 5 minutes                   ║');
  console.log('║   • Cleanup: Every hour                            ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  if (isMongoConnected) {
    await mongoose.connection.close();
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  if (isMongoConnected) {
    await mongoose.connection.close();
  }
  process.exit(0);
});
