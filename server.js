import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// API Configuration
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || 'fdab0eef5743173c30f9810bef3a6742';
const TOP_LEAGUES = {
  39: 'Premier League', 140: 'La Liga', 135: 'Serie A', 78: 'Bundesliga',
  61: 'Ligue 1', 94: 'Primeira Liga', 88: 'Eredivisie', 203: 'Super Lig',
  480: 'Arab Cup', 32: 'WC Africa', 33: 'WC Asia', 34: 'WC Europe'
};

let apiCalls = 0;
const API_LIMIT = 100;
const statsCache = new Map(); // Cache for reducing API calls
const latestPredictions = []; // Store latest predictions for polling

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
.catch(err => {
  console.error('❌ MongoDB Error:', err.message);
});

// Helper to update latest predictions (for polling)
function updateLatestPredictions(prediction) {
  latestPredictions.unshift({
    ...prediction,
    timestamp: new Date()
  });
  
  // Keep only last 50 updates
  if (latestPredictions.length > 50) {
    latestPredictions.pop();
  }
}

// ==================== ENHANCED SCHEMAS ====================

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
  home_logo: String,
  away_logo: String,
  
  // Real-time Stats
  current_minute: { type: Number, default: 0 },
  live_stats: {
    shots_total: { home: Number, away: Number },
    shots_on_target: { home: Number, away: Number },
    shots_off_target: { home: Number, away: Number },
    shots_blocked: { home: Number, away: Number },
    shots_inside_box: { home: Number, away: Number },
    possession: { home: Number, away: Number },
    corners: { home: Number, away: Number },
    fouls: { home: Number, away: Number },
    yellow_cards: { home: Number, away: Number },
    red_cards: { home: Number, away: Number },
    saves: { home: Number, away: Number },
    passes_total: { home: Number, away: Number },
    passes_accurate: { home: Number, away: Number },
    pass_accuracy: { home: Number, away: Number },
    attacks: { home: Number, away: Number },
    dangerous_attacks: { home: Number, away: Number }
  },
  
  // Form & Context
  home_form: String,
  away_form: String,
  home_position: Number,
  away_position: Number,
  is_derby: { type: Boolean, default: false },
  is_cup: { type: Boolean, default: false },
  
  last_updated: { type: Date, default: Date.now }
}, { timestamps: true });

const predictionSchema = new mongoose.Schema({
  match_id: { type: String, required: true, unique: true },
  home_team: String,
  away_team: String,
  league: String,
  current_minute: Number,
  current_score: String,
  
  // Winner Probabilities with Trends
  winner_prob: {
    home: { value: Number, trend: String, change: Number },
    draw: { value: Number, trend: String, change: Number },
    away: { value: Number, trend: String, change: Number }
  },
  
  // Goal Predictions
  most_likely_score: String,
  over_under: {
    '0.5': Number, '1.5': Number, '2.5': Number, 
    '3.5': Number, '4.5': Number, '5.5': Number
  },
  btts_prob: Number,
  exact_goals_range: {
    '0-1': Number,
    '2-3': Number,
    '4+': Number
  },
  
  // Advanced Stats
  xG: { home: Number, away: Number, total: Number },
  xGOT: { home: Number, away: Number },
  big_chances: {
    home_created: Number,
    away_created: Number,
    home_missed: Number,
    away_missed: Number
  },
  
  // Key Statistics Display
  key_stats: {
    shots_on_target: String,
    possession: String,
    big_chances: String,
    corners: String
  },
  
  // Real-time Indicators
  next_goal_likely: Boolean,
  next_goal_team: String,
  next_goal_probability: Number,
  momentum: String,
  momentum_strength: Number,
  turning_point_detected: Boolean,
  
  // Live Insights & Alerts
  live_insights: [String],
  value_bets: [{
    market: String,
    probability: Number,
    recommendation: String
  }],
  
  // Risk Assessment
  confidence_score: Number,
  confidence_level: String,
  confidence_color: String,
  risk_indicators: [String],
  
  // Weighted Scores
  form_score: Number,
  realtime_score: Number,
  context_score: Number,
  
  // Special Situations
  red_card_impact: Boolean,
  penalty_situation: Boolean,
  
  prediction_version: Number,
  last_updated: Date
}, { timestamps: true });

const apiLogSchema = new mongoose.Schema({
  endpoint: String,
  timestamp: { type: Date, default: Date.now },
  response_time: Number,
  success: Boolean
});

const Match = mongoose.model('Match', matchSchema);
const Prediction = mongoose.model('Prediction', predictionSchema);
const ApiLog = mongoose.model('ApiLog', apiLogSchema);

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
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true
    });
  } catch {
    return 'Time TBA';
  }
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

function getConfidenceColor(score) {
  if (score >= 80) return 'green';
  if (score >= 60) return 'yellow';
  return 'red';
}

function getConfidenceLevel(score) {
  if (score >= 80) return 'High';
  if (score >= 60) return 'Medium';
  return 'Low';
}

// ==================== API CALL WITH CACHING & LOGGING ====================

async function apiCall(url, cacheKey = null, cacheDuration = 60000) {
  const startTime = Date.now();
  
  try {
    // Check cache first
    if (cacheKey && statsCache.has(cacheKey)) {
      const cached = statsCache.get(cacheKey);
      if (Date.now() - cached.timestamp < cacheDuration) {
        console.log(`💾 Cache hit: ${cacheKey}`);
        return cached.data;
      }
    }
    
    if (apiCalls >= API_LIMIT) {
      console.log('⚠️ API limit reached');
      return null;
    }
    
    const response = await fetch(url, {
      headers: {
        'x-rapidapi-key': API_FOOTBALL_KEY,
        'x-rapidapi-host': 'v3.football.api-sports.io'
      },
      signal: AbortSignal.timeout(10000)
    });
    
    apiCalls++;
    const responseTime = Date.now() - startTime;
    
    // Log API call
    await ApiLog.create({
      endpoint: url.split('?')[0],
      response_time: responseTime,
      success: response.ok
    });
    
    if (!response.ok) {
      console.log(`❌ API Error: ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    
    // Cache the result
    if (cacheKey) {
      statsCache.set(cacheKey, {
        data: data,
        timestamp: Date.now()
      });
    }
    
    return data;
    
  } catch (error) {
    console.error(`❌ API call error:`, error.message);
    
    await ApiLog.create({
      endpoint: url.split('?')[0],
      response_time: Date.now() - startTime,
      success: false
    });
    
    return null;
  }
}

// ==================== FETCH LIVE STATS ====================

async function fetchLiveStatistics(fixtureId) {
  try {
    const cacheKey = `stats_${fixtureId}`;
    const data = await apiCall(
      `https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}`,
      cacheKey,
      120000 // Cache for 2 minutes
    );
    
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
    
    return {
      shots_total: {
        home: getStat(homeStats, 'Total Shots'),
        away: getStat(awayStats, 'Total Shots')
      },
      shots_on_target: {
        home: getStat(homeStats, 'Shots on Goal'),
        away: getStat(awayStats, 'Shots on Goal')
      },
      shots_off_target: {
        home: getStat(homeStats, 'Shots off Goal'),
        away: getStat(awayStats, 'Shots off Goal')
      },
      shots_blocked: {
        home: getStat(homeStats, 'Blocked Shots'),
        away: getStat(awayStats, 'Blocked Shots')
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
      fouls: {
        home: getStat(homeStats, 'Fouls'),
        away: getStat(awayStats, 'Fouls')
      },
      yellow_cards: {
        home: getStat(homeStats, 'Yellow Cards'),
        away: getStat(awayStats, 'Yellow Cards')
      },
      red_cards: {
        home: getStat(homeStats, 'Red Cards'),
        away: getStat(awayStats, 'Red Cards')
      },
      saves: {
        home: getStat(homeStats, 'Goalkeeper Saves'),
        away: getStat(awayStats, 'Goalkeeper Saves')
      },
      passes_total: {
        home: getStat(homeStats, 'Total passes'),
        away: getStat(awayStats, 'Total passes')
      },
      passes_accurate: {
        home: getStat(homeStats, 'Passes accurate'),
        away: getStat(awayStats, 'Passes accurate')
      },
      pass_accuracy: {
        home: getStat(homeStats, 'Passes %'),
        away: getStat(awayStats, 'Passes %')
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
  } catch (error) {
    console.error('❌ Live stats error:', error.message);
    return null;
  }
}

// ==================== FETCH TEAM FORM ====================

async function fetchTeamForm(teamId) {
  try {
    const cacheKey = `form_${teamId}`;
    const data = await apiCall(
      `https://v3.football.api-sports.io/fixtures?team=${teamId}&last=5`,
      cacheKey,
      900000 // Cache for 15 minutes
    );
    
    if (!data?.response) return '';
    
    let form = '';
    data.response.slice(0, 5).forEach(match => {
      const homeGoals = match.goals.home;
      const awayGoals = match.goals.away;
      const isHome = match.teams.home.id === teamId;
      
      if (isHome) {
        if (homeGoals > awayGoals) form += 'W';
        else if (homeGoals < awayGoals) form += 'L';
        else form += 'D';
      } else {
        if (awayGoals > homeGoals) form += 'W';
        else if (awayGoals < homeGoals) form += 'L';
        else form += 'D';
      }
    });
    
    return form;
  } catch (error) {
    return '';
  }
}

// ==================== ADVANCED PREDICTION ALGORITHM ====================

async function calculateAdvancedPrediction(match) {
  try {
    const prevPrediction = await Prediction.findOne({ match_id: match.match_id });
    
    // ========== A. FORM FACTORS (30%) ==========
    let formScore = 50;
    
    // Last 5 matches form
    if (match.home_form) {
      const homeWins = (match.home_form.match(/W/g) || []).length;
      const homeDraws = (match.home_form.match(/D/g) || []).length;
      formScore += (homeWins * 4) + (homeDraws * 1);
    }
    if (match.away_form) {
      const awayWins = (match.away_form.match(/W/g) || []).length;
      const awayDraws = (match.away_form.match(/D/g) || []).length;
      formScore -= (awayWins * 3) + (awayDraws * 0.5);
    }
    
    // League position difference
    if (match.home_position && match.away_position) {
      const posDiff = match.away_position - match.home_position;
      formScore += posDiff * 0.5;
    }
    
    formScore = Math.max(20, Math.min(80, formScore));
    
    // ========== B. REAL-TIME FACTORS (50%) ==========
    let realtimeScore = 50;
    let xG_home = 0, xG_away = 0, xGOT_home = 0, xGOT_away = 0;
    let nextGoalProb = 0, nextGoalTeam = 'neutral';
    let momentum = 'neutral', momentumStrength = 0;
    let bigChancesHome = 0, bigChancesAway = 0;
    
    if (match.live_stats) {
      const stats = match.live_stats;
      
      // Possession dominance (20% of realtime)
      const possDiff = (stats.possession?.home || 50) - (stats.possession?.away || 50);
      realtimeScore += possDiff * 0.4;
      
      // Shots dominance (20% of realtime)
      const shotsDiff = (stats.shots_on_target?.home || 0) - (stats.shots_on_target?.away || 0);
      realtimeScore += shotsDiff * 4;
      
      // Calculate xG (15% of realtime)
      xG_home = ((stats.shots_on_target?.home || 0) * 0.35) + 
                ((stats.shots_inside_box?.home || 0) * 0.25) +
                ((stats.dangerous_attacks?.home || 0) * 0.015);
                
      xG_away = ((stats.shots_on_target?.away || 0) * 0.35) + 
                ((stats.shots_inside_box?.away || 0) * 0.25) +
                ((stats.dangerous_attacks?.away || 0) * 0.015);
      
      xGOT_home = xG_home * 0.75;
      xGOT_away = xG_away * 0.75;
      
      const xGDiff = xG_home - xG_away;
      realtimeScore += xGDiff * 8;
      
      // Big chances (10% of realtime)
      bigChancesHome = stats.dangerous_attacks?.home || 0;
      bigChancesAway = stats.dangerous_attacks?.away || 0;
      realtimeScore += (bigChancesHome - bigChancesAway) * 2;
      
      // Momentum detection (5% of realtime)
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
      
      // Next goal prediction
      const totalXg = xG_home + xG_away;
      if (totalXg > 1.0) {
        nextGoalProb = Math.min(90, totalXg * 35);
        nextGoalTeam = xG_home > xG_away ? 'home' : 'away';
      }
    }
    
    realtimeScore = Math.max(20, Math.min(80, realtimeScore));
    
    // ========== C. CONTEXT FACTORS (20%) ==========
    let contextScore = 50;
    
    if (match.is_derby) {
      contextScore += 5; // Increase draw probability
    }
    if (match.is_cup) {
      contextScore += 3; // Higher stakes
    }
    
    contextScore = Math.max(30, Math.min(70, contextScore));
    
    // ========== CALCULATE FINAL PROBABILITIES ==========
    const totalScore = (formScore * 0.3) + (realtimeScore * 0.5) + (contextScore * 0.2);
    
    let homeProb = Math.max(15, Math.min(75, totalScore));
    let awayProb = Math.max(15, Math.min(75, 100 - totalScore - 20));
    let drawProb = 100 - homeProb - awayProb;
    
    // Adjust for current score
    if (match.home_score > match.away_score) {
      homeProb += 12;
      awayProb -= 8;
      drawProb -= 4;
    } else if (match.away_score > match.home_score) {
      awayProb += 12;
      homeProb -= 8;
      drawProb -= 4;
    }
    
    // Derby adjustment
    if (match.is_derby) {
      drawProb += 8;
      homeProb -= 4;
      awayProb -= 4;
    }
    
    // Red card adjustment
    let redCardImpact = false;
    if (match.live_stats?.red_cards?.home > 0) {
      homeProb -= 20;
      awayProb += 15;
      drawProb += 5;
      redCardImpact = true;
    }
    if (match.live_stats?.red_cards?.away > 0) {
      awayProb -= 20;
      homeProb += 15;
      drawProb += 5;
      redCardImpact = true;
    }
    
    // Normalize
    const total = homeProb + drawProb + awayProb;
    homeProb = Math.round((homeProb / total) * 100);
    drawProb = Math.round((drawProb / total) * 100);
    awayProb = 100 - homeProb - drawProb;
    
    // ========== CALCULATE OVER/UNDER ==========
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
    
    // BTTS
    const bttsProb = Math.round(
      40 +
      (xG_home > 0.6 ? 15 : 0) +
      (xG_away > 0.6 ? 15 : 0) +
      ((match.live_stats?.shots_on_target?.home || 0) > 3 ? 10 : 0) +
      ((match.live_stats?.shots_on_target?.away || 0) > 3 ? 10 : 0) +
      (match.home_score > 0 && match.away_score > 0 ? 20 : 0)
    );
    
    // Most likely score
    const predictedHomeGoals = Math.round(xG_home) + match.home_score;
    const predictedAwayGoals = Math.round(xG_away) + match.away_score;
    const mostLikelyScore = `${predictedHomeGoals}-${predictedAwayGoals}`;
    
    // ========== CONFIDENCE CALCULATION ==========
    let confidenceScore = 50;
    
    // Data completeness
    if (match.live_stats) confidenceScore += 25;
    if (match.home_form && match.away_form) confidenceScore += 10;
    
    // Statistical significance
    const totalShots = (match.live_stats?.shots_total?.home || 0) + 
                      (match.live_stats?.shots_total?.away || 0);
    if (totalShots > 15) confidenceScore += 10;
    else if (totalShots > 8) confidenceScore += 5;
    
    // Match consistency
    if (momentumStrength < 50) confidenceScore += 5;
    
    confidenceScore = Math.max(30, Math.min(100, confidenceScore));
    
    // ========== LIVE INSIGHTS ==========
    const insights = [];
    
    if (nextGoalProb > 65) {
      insights.push(`⚡ Goal expected in next 15 mins (${Math.round(nextGoalProb)}% probability)`);
    }
    if ((match.live_stats?.shots_on_target?.home || 0) < 2 && 
        (match.live_stats?.shots_on_target?.away || 0) < 2) {
      insights.push('🛡️ Defensive match - Under 2.5 goals likely');
    }
    if (momentumStrength > 75) {
      insights.push(`📈 Strong ${momentum} team momentum detected`);
    }
    if (redCardImpact) {
      insights.push('🟥 Red card - match dynamics changed significantly');
    }
    if (totalXg > 3.0) {
      insights.push('🎯 High xG match - Over 2.5 goals very likely');
    }
    if (match.is_derby) {
      insights.push('⚔️ Derby match - increased draw probability');
    }
    
    // ========== RISK INDICATORS ==========
    const riskIndicators = [];
    if (confidenceScore < 60) riskIndicators.push('Limited real-time data');
    if (Math.abs(homeProb - awayProb) < 12) riskIndicators.push('Very close match');
    if (totalXg < 1.3) riskIndicators.push('Low-scoring expected');
    if (!match.live_stats) riskIndicators.push('No live statistics available');
    
    // ========== VALUE BETS ==========
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
        probability: overUnder['2.5'],
        recommendation: 'Good Value'
      });
    }
    if (bttsProb > 70 && confidenceScore > 65) {
      valueBets.push({
        market: 'Both Teams to Score',
        probability: bttsProb,
        recommendation: 'Fair Value'
      });
    }
    
    // ========== BUILD PREDICTION OBJECT ==========
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
      exact_goals_range: {
        '0-1': Math.round(100 - overUnder['1.5']),
        '2-3': Math.round(overUnder['1.5'] - overUnder['3.5']),
        '4+': Math.round(overUnder['3.5'])
      },
      
      xG: {
        home: Number(xG_home.toFixed(2)),
        away: Number(xG_away.toFixed(2)),
        total: Number((xG_home + xG_away).toFixed(2))
      },
      xGOT: {
        home: Number(xGOT_home.toFixed(2)),
        away: Number(xGOT_away.toFixed(2))
      },
      big_chances: {
        home_created: bigChancesHome,
        away_created: bigChancesAway,
        home_missed: Math.max(0, (match.live_stats?.shots_on_target?.home || 0) - match.home_score),
        away_missed: Math.max(0, (match.live_stats?.shots_on_target?.away || 0) - match.away_score)
      },
      
      key_stats: {
        shots_on_target: `${match.live_stats?.shots_on_target?.home || 0} - ${match.live_stats?.shots_on_target?.away || 0}`,
        possession: `${match.live_stats?.possession?.home || 0}% - ${match.live_stats?.possession?.away || 0}%`,
        big_chances: `${bigChancesHome} - ${bigChancesAway}`,
        corners: `${match.live_stats?.corners?.home || 0} - ${match.live_stats?.corners?.away || 0}`
      },
      
      next_goal_likely: nextGoalProb > 50,
      next_goal_team: nextGoalTeam,
      next_goal_probability: Math.round(nextGoalProb),
      momentum: momentum,
      momentum_strength: Math.round(momentumStrength),
      turning_point_detected: momentumStrength > 85,
      
      live_insights: insights,
      value_bets: valueBets,
      
      confidence_score: Math.round(confidenceScore),
      confidence_level: getConfidenceLevel(confidenceScore),
      confidence_color: getConfidenceColor(confidenceScore),
      risk_indicators: riskIndicators,
      
      form_score: Math.round(formScore),
      realtime_score: Math.round(realtimeScore),
      context_score: Math.round(contextScore),
      
      red_card_impact: redCardImpact,
      penalty_situation: false,
      
      prediction_version: (prevPrediction?.prediction_version || 0) + 1,
      last_updated: new Date()
    };
    
    return prediction;
    
  } catch (error) {
    console.error('❌ Prediction error:', error.message);
    return null;
  }
}

// ==================== FETCH & UPDATE FUNCTIONS ====================

async function fetchMatches() {
  console.log('\n🔄 ============ FETCHING MATCHES ============');
  
  if (!isMongoConnected) return [];
  
  try {
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 24*60*60*1000).toISOString().split('T')[0];
    
    console.log('📅 Dates:', today, '&', tomorrow);
    
    let allMatches = [];
    
    for (const date of [today, tomorrow]) {
      if (apiCalls >= API_LIMIT) break;
      
      const data = await apiCall(
        `https://v3.football.api-sports.io/fixtures?date=${date}`,
        `fixtures_${date}`,
        300000
      );
      
      if (!data?.response) continue;
      
      const filtered = data.response.filter(f => 
        Object.keys(TOP_LEAGUES).includes(String(f.league.id))
      );
      
      console.log(`✅ ${date}: ${filtered.length} matches`);
      
      for (const f of filtered) {
        const matchData = {
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
          home_logo: f.teams.home.logo,
          away_logo: f.teams.away.logo,
          current_minute: f.fixture.status.elapsed || 0,
          last_updated: new Date()
        };
        
        if (['1H', '2H', 'LIVE', 'HT'].includes(matchData.status)) {
          const liveStats = await fetchLiveStatistics(f.fixture.id);
          if (liveStats) matchData.live_stats = liveStats;
        }
        
        allMatches.push(matchData);
      }
    }
    
    console.log(`✅ Total: ${allMatches.length}`);
    
    for (const match of allMatches) {
      await Match.findOneAndUpdate(
        { match_id: match.match_id },
        match,
        { upsert: true, new: true }
      );
    }
    
    return allMatches;
    
  } catch (error) {
    console.error('❌ Fetch error:', error.message);
    return [];
  }
}

async function updateLiveMatches() {
  if (!isMongoConnected) return;
  
  try {
    console.log('\n⚡ Updating LIVE matches...');
    
    const liveMatches = await Match.find({
      status: { $in: ['1H', '2H', 'HT', 'LIVE'] }
    });
    
    console.log(`📊 ${liveMatches.length} live matches`);
    
    for (const match of liveMatches) {
      const fixtureId = match.match_id.replace('af_', '');
      const liveStats = await fetchLiveStatistics(fixtureId);
      
      if (liveStats) {
        match.live_stats = liveStats;
        match.last_updated = new Date();
        await match.save();
        
        const prediction = await calculateAdvancedPrediction(match);
        if (prediction) {
          await Prediction.findOneAndUpdate(
            { match_id: match.match_id },
            prediction,
            { upsert: true, new: true }
          );
          
          updateLatestPredictions(prediction);
        }
      }
    }
    
    console.log('✅ Live updates complete\n');
  } catch (error) {
    console.error('❌ Live update error:', error.message);
  }
}

async function cleanupFinished() {
  if (!isMongoConnected) return;
  
  try {
    const result = await Match.deleteMany({
      status: { $in: ['FT', 'AET', 'PEN'] },
      updatedAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    });
    
    if (result.deletedCount > 0) {
      console.log(`🗑️ Archived ${result.deletedCount} finished matches`);
    }
  } catch (error) {
    console.error('❌ Cleanup error:', error.message);
  }
}

// ==================== API ROUTES ====================

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    mongodb: isMongoConnected ? 'Connected' : 'Disconnected',
    apiCalls: `${apiCalls}/${API_LIMIT}`,
    cacheSize: statsCache.size,
    latestUpdates: latestPredictions.length,
    time: new Date().toISOString()
  });
});

app.get('/api/matches', async (req, res) => {
  try {
    if (!isMongoConnected) {
      return res.status(503).json({ success: false, error: 'MongoDB offline' });
    }
    
    const matches = await Match.find({
      status: { $in: ['NS', 'LIVE', '1H', '2H', 'HT', 'ET'] }
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
      .sort({ confidence_score: -1 })
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
    updates: latestPredictions
  });
});

app.post('/api/fetch-matches', async (req, res) => {
  try {
    const matches = await fetchMatches();
    
    for (const match of matches) {
      const prediction = await calculateAdvancedPrediction(match);
      if (prediction) {
        await Prediction.findOneAndUpdate(
          { match_id: match.match_id },
          prediction,
          { upsert: true, new: true }
        );
      }
    }
    
    res.json({
      success: true,
      count: matches.length,
      message: `Fetched ${matches.length} matches with predictions`
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
    let attempts = 0;
    while (!isMongoConnected && attempts < 30) {
      await new Promise(r => setTimeout(r, 1000));
      attempts++;
    }
  }
  
  if (isMongoConnected) {
    console.log('🚀 Initial fetch...');
    const matches = await fetchMatches();
    
    for (const match of matches) {
      const prediction = await calculateAdvancedPrediction(match);
      if (prediction) {
        await Prediction.findOneAndUpdate(
          { match_id: match.match_id },
          prediction,
          { upsert: true, new: true }
        );
      }
    }
    console.log(`✅ Created ${matches.length} predictions`);
  }
}, 10000);

setInterval(updateLiveMatches, 2 * 60 * 1000);
setInterval(async () => {
  if (isMongoConnected) await fetchMatches();
}, 15 * 60 * 1000);
setInterval(cleanupFinished, 60 * 60 * 1000);
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of statsCache.entries()) {
    if (now - value.timestamp > 600000) {
      statsCache.delete(key);
    }
  }
  console.log(`💾 Cache size: ${statsCache.size}`);
}, 10 * 60 * 1000);

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║  ⚡ PROFESSIONAL PREDICTION SYSTEM ⚡       ║');
  console.log('║                                            ║');
  console.log(`║  🚀 Server: http://localhost:${PORT}     ║`);
  console.log('║  📊 Real-time stats from API               ║');
  console.log('║  🎯 Weighted algorithm (Form/Live/Context) ║');
  console.log('║  ⏱️  Live updates every 2 minutes          ║');
  console.log('║  🔄 Polling API for updates                ║');
  console.log('║  📈 Momentum & trend detection             ║');
  console.log('║  💰 Value bet identification               ║');
  console.log('║  💾 Smart caching system                   ║');
  console.log('╚════════════════════════════════════════════╝\n');
});

process.on('SIGTERM', async () => {
  if (isMongoConnected) await mongoose.connection.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  if (isMongoConnected) await mongoose.connection.close();
  process.exit(0);
});
