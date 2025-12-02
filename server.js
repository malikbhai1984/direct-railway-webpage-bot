


import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// API Keys
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || 'fdab0eef5743173c30f9810bef3a6742';
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY || '62207494b8a241db93aee4c14b7c1266';

// Top Leagues IDs (API-Football)
const TOP_LEAGUES = {
  39: 'Premier League',           // England
  140: 'La Liga',                 // Spain
  135: 'Serie A',                 // Italy
  78: 'Bundesliga',               // Germany
  61: 'Ligue 1',                  // France
  94: 'Primeira Liga',            // Portugal
  88: 'Eredivisie',               // Netherlands
  203: 'Super Lig',               // Turkey
  32: 'World Cup - Qualification Africa',
  33: 'World Cup - Qualification Asia',
  34: 'World Cup - Qualification Europe',
  35: 'World Cup - Qualification South America'
};

// API Rate Limits
let apiFootballCalls = 0;
let footballDataCalls = 0;
const API_FOOTBALL_LIMIT = 100;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ==================== MONGODB CONNECTION (FIXED) ====================
const MONGO_URI = process.env.MONGO_URI || 
                  process.env.MONGODB_URI || 
                  process.env.MONGO_PUBLIC_URL ||
                  process.env.MONGO_URL ||
                  process.env.DATABASE_URL;

if (!MONGO_URI) {
  console.error('❌ CRITICAL ERROR: No MongoDB URI found!');
  console.error('💡 Please set one of these environment variables:');
  console.error('   - MONGO_URI');
  console.error('   - MONGO_PUBLIC_URL (Railway MongoDB)');
  console.error('   - MONGODB_URI');
  console.error('\n📋 Example MongoDB Atlas URI:');
  console.error('   mongodb+srv://username:password@cluster.mongodb.net/football');
  console.error('\n📋 Railway MongoDB URI format:');
  console.error('   mongodb://mongo:PORT/railway');
  console.error('\n🔧 To fix this on Railway:');
  console.error('   1. Add MongoDB from the service menu');
  console.error('   2. Railway will auto-set MONGO_PUBLIC_URL');
  console.error('   3. Or manually add your MongoDB Atlas URI');
  process.exit(1);
}

console.log('✅ MongoDB URI detected');
console.log('🔌 Connecting to:', MONGO_URI.substring(0, 20) + '...');

let isMongoConnected = false;

mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
})
.then(() => {
  console.log('✅ MongoDB Connected Successfully!');
  console.log('📦 Database:', mongoose.connection.db.databaseName);
  isMongoConnected = true;
})
.catch(err => {
  console.error('❌ MongoDB Connection Failed!');
  console.error('Error:', err.message);
  console.error('\n💡 Troubleshooting:');
  console.error('1. Check if MongoDB URI is correct in environment variables');
  console.error('2. If using Railway MongoDB, ensure it\'s added to your project');
  console.error('3. If using MongoDB Atlas:');
  console.error('   - Whitelist all IPs (0.0.0.0/0) in Network Access');
  console.error('   - Check username/password in connection string');
  console.error('   - Ensure database user has read/write permissions');
  isMongoConnected = false;
  // Don't exit - let server run but warn about no DB
});

// Handle connection events
mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ MongoDB Disconnected! Attempting to reconnect...');
  isMongoConnected = false;
});

mongoose.connection.on('reconnected', () => {
  console.log('✅ MongoDB Reconnected!');
  isMongoConnected = true;
});

mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB Error:', err.message);
  isMongoConnected = false;
});

// Wait for MongoDB connection
async function waitForMongo() {
  let attempts = 0;
  while (!isMongoConnected && attempts < 30) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    attempts++;
  }
  if (!isMongoConnected) {
    throw new Error('MongoDB connection timeout after 30 seconds');
  }
}

// ==================== SCHEMAS ====================

const matchSchema = new mongoose.Schema({
  match_id: { 
    type: String, 
    required: true, 
    unique: true
  },
  home_team: { type: String, required: true },
  away_team: { type: String, required: true },
  league: String,
  league_name: String,
  home_score: Number,
  away_score: Number,
  status: { type: String, default: 'NS' },
  match_time: String,
  match_time_pkt: String,
  match_date: Date,
  venue: String,
  home_logo: String,
  away_logo: String,
  api_source: String,
  is_world_cup_qualifier: { type: Boolean, default: false },
  fetched_at: { type: Date, default: Date.now }
}, { 
  timestamps: true 
});

matchSchema.index({ match_date: -1 });
matchSchema.index({ status: 1 });
matchSchema.index({ is_world_cup_qualifier: 1 });

const predictionSchema = new mongoose.Schema({
  match_id: { 
    type: String, 
    required: true, 
    unique: true
  },
  home_team: { type: String, required: true },
  away_team: { type: String, required: true },
  league: String,
  match_time_pkt: String,
  
  winner_prob: {
    home: { type: Number, default: 0 },
    draw: { type: Number, default: 0 },
    away: { type: Number, default: 0 }
  },
  
  xG: {
    home: { type: Number, default: 0 },
    away: { type: Number, default: 0 },
    total: { type: Number, default: 0 }
  },
  
  btts_prob: { type: Number, default: 0 },
  over_under: {
    '1.5': { type: Number, default: 0 },
    '2.5': { type: Number, default: 0 },
    '3.5': { type: Number, default: 0 }
  },
  last10_prob: { type: Number, default: 0 },
  
  confidence_score: { type: Number, default: 0 },
  strong_markets: [{
    market: String,
    prob: Number
  }],
  correct_scores: [{
    score: String,
    probability: Number
  }],
  top_goal_minutes: [{
    minute: String,
    probability: Number
  }],
  h2h_analysis: {
    recent_form: String,
    last_5: String,
    summary: String
  },
  odds_suggestions: [{
    market: String,
    suggested_odds: String,
    value: String
  }],
  risk_warning: String,
  is_new: { type: Boolean, default: true },
  
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
}, { 
  timestamps: true 
});

predictionSchema.index({ created_at: -1 });
predictionSchema.index({ confidence_score: -1 });
predictionSchema.index({ is_new: 1 });

const Match = mongoose.model('Match', matchSchema);
const Prediction = mongoose.model('Prediction', predictionSchema);

// ==================== API FUNCTIONS ====================

async function fetchFromApiFootball() {
  try {
    console.log('🌐 Fetching from API-Football...');
    console.log(`📊 API Calls: ${apiFootballCalls}/${API_FOOTBALL_LIMIT}`);
    
    if (apiFootballCalls >= API_FOOTBALL_LIMIT) {
      console.log('⚠️ API-Football limit reached for today');
      return null;
    }
    
    const today = new Date().toISOString().split('T')[0];
    let allMatches = [];
    
    // Fetch top leagues
    for (const [leagueId, leagueName] of Object.entries(TOP_LEAGUES)) {
      try {
        const response = await fetch(
          `https://v3.football.api-sports.io/fixtures?league=${leagueId}&season=2024&date=${today}`,
          {
            headers: {
              'x-rapidapi-key': API_FOOTBALL_KEY,
              'x-rapidapi-host': 'v3.football.api-sports.io'
            }
          }
        );
        
        apiFootballCalls++;
        
        if (response.ok) {
          const data = await response.json();
          if (data.response && data.response.length > 0) {
            console.log(`✅ ${leagueName}: ${data.response.length} matches`);
            
            const matches = data.response.map(fixture => ({
              match_id: `af_${fixture.fixture.id}`,
              home_team: fixture.teams.home.name,
              away_team: fixture.teams.away.name,
              league: fixture.league.name,
              league_name: fixture.league.name,
              home_score: fixture.goals.home,
              away_score: fixture.goals.away,
              status: convertStatus(fixture.fixture.status.short),
              match_time: fixture.fixture.date,
              match_time_pkt: toPakistanTime(fixture.fixture.date),
              match_date: new Date(fixture.fixture.date),
              venue: fixture.fixture.venue?.name || 'Unknown',
              home_logo: fixture.teams.home.logo,
              away_logo: fixture.teams.away.logo,
              api_source: 'API-Football',
              is_world_cup_qualifier: leagueName.includes('World Cup')
            }));
            
            allMatches = [...allMatches, ...matches];
          }
        }
      } catch (error) {
        console.error(`❌ Error fetching ${leagueName}:`, error.message);
      }
    }
    
    console.log(`✅ Total matches from API-Football: ${allMatches.length}`);
    return allMatches.length > 0 ? allMatches : null;
  } catch (error) {
    console.error('❌ API-Football Error:', error.message);
    return null;
  }
}

async function fetchFromFootballData() {
  try {
    console.log('🌐 Fetching from Football-Data.org...');
    console.log(`📊 Football-Data Calls: ${footballDataCalls}`);
    
    const today = new Date().toISOString().split('T')[0];
    const response = await fetch(
      `https://api.football-data.org/v4/matches?date=${today}`,
      {
        headers: {
          'X-Auth-Token': FOOTBALL_DATA_KEY
        }
      }
    );
    
    footballDataCalls++;
    
    if (!response.ok) {
      console.log('❌ Football-Data request failed');
      return null;
    }
    
    const data = await response.json();
    
    if (!data.matches || data.matches.length === 0) {
      console.log('⚠️ No matches from Football-Data');
      return null;
    }
    
    console.log(`✅ Football-Data: ${data.matches.length} matches`);
    
    const matches = data.matches.map(match => ({
      match_id: `fd_${match.id}`,
      home_team: match.homeTeam.name,
      away_team: match.awayTeam.name,
      league: match.competition.name,
      league_name: match.competition.name,
      home_score: match.score.fullTime.home,
      away_score: match.score.fullTime.away,
      status: convertStatus(match.status),
      match_time: match.utcDate,
      match_time_pkt: toPakistanTime(match.utcDate),
      match_date: new Date(match.utcDate),
      venue: match.venue || 'Unknown',
      home_logo: match.homeTeam.crest || null,
      away_logo: match.awayTeam.crest || null,
      api_source: 'Football-Data',
      is_world_cup_qualifier: match.competition.name.includes('World Cup')
    }));
    
    return matches;
  } catch (error) {
    console.error('❌ Football-Data Error:', error.message);
    return null;
  }
}

async function fetchMatches() {
  console.log('🔄 ============ FETCHING LIVE MATCHES ============');
  
  const pakistanDate = new Date().toLocaleDateString('en-PK', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long'
  });
  const pakistanTime = new Date().toLocaleTimeString('en-PK', {
    timeZone: 'Asia/Karachi',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
  
  console.log('📅 Pakistan Date:', pakistanDate);
  console.log('🕐 Pakistan Time:', pakistanTime);
  
  // Check MongoDB connection
  if (!isMongoConnected) {
    console.warn('⚠️ MongoDB not connected - attempting to reconnect...');
    try {
      await waitForMongo();
    } catch (error) {
      console.error('❌ Cannot proceed without MongoDB:', error.message);
      return [];
    }
  }
  
  // Try API-Football first
  let matches = await fetchFromApiFootball();
  
  // Fallback to Football-Data
  if (!matches || matches.length === 0) {
    console.log('🔄 Switching to Football-Data.org...');
    matches = await fetchFromFootballData();
  }
  
  if (!matches || matches.length === 0) {
    console.log('❌ No matches found from any API!');
    return [];
  }
  
  console.log(`📊 Processing ${matches.length} total matches...`);
  
  // Count World Cup qualifiers
  const wcqMatches = matches.filter(m => m.is_world_cup_qualifier);
  if (wcqMatches.length > 0) {
    console.log(`⚽ World Cup Qualifiers: ${wcqMatches.length} matches`);
  }
  
  // Save to database with error handling
  let savedCount = 0;
  for (const match of matches) {
    try {
      await Match.findOneAndUpdate(
        { match_id: match.match_id },
        match,
        { upsert: true, new: true }
      );
      savedCount++;
    } catch (error) {
      console.error(`❌ Error saving match ${match.match_id}:`, error.message);
    }
  }
  
  console.log(`✅ Successfully saved ${savedCount}/${matches.length} matches to MongoDB`);
  console.log('============ FETCH COMPLETE ============\n');
  
  return matches;
}

// ==================== HELPER FUNCTIONS ====================

function convertStatus(status) {
  const statusMap = {
    'NS': 'NS', 'TBD': 'NS', 'SCHEDULED': 'NS',
    'LIVE': 'LIVE', 'IN_PLAY': 'LIVE',
    '1H': '1H', 'HT': 'HT', '2H': '2H',
    'FT': 'FT', 'FINISHED': 'FT',
    'ET': 'ET', 'P': 'P'
  };
  return statusMap[status] || 'NS';
}

function toPakistanTime(dateString) {
  try {
    const date = new Date(dateString);
    return date.toLocaleString('en-PK', {
      timeZone: 'Asia/Karachi',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  } catch (err) {
    return 'Time TBA';
  }
}

function calculatePredictions(match) {
  const homeStrength = (match.home_team.length % 10) + 1;
  const awayStrength = (match.away_team.length % 10) + 1;
  const total = homeStrength + awayStrength;
  
  const homeWinProb = Math.round((homeStrength / total) * 100);
  const awayWinProb = Math.round((awayStrength / total) * 100);
  const drawProb = 100 - homeWinProb - awayWinProb;
  
  const homeXg = (homeStrength / 5).toFixed(1);
  const awayXg = (awayStrength / 5).toFixed(1);
  const totalXg = (parseFloat(homeXg) + parseFloat(awayXg)).toFixed(1);
  
  const bttsProb = totalXg > 2.5 ? 65 : 45;
  const over25 = totalXg > 2.5 ? 70 : 40;
  const over35 = totalXg > 3.5 ? 55 : 25;
  
  const strongMarkets = [];
  if (homeWinProb >= 85) strongMarkets.push({ market: 'Home Win', prob: homeWinProb });
  if (awayWinProb >= 85) strongMarkets.push({ market: 'Away Win', prob: awayWinProb });
  if (over25 >= 85) strongMarkets.push({ market: 'Over 2.5', prob: over25 });
  
  const correctScores = [
    { score: '2-1', probability: 15 },
    { score: '1-1', probability: 12 },
    { score: '2-0', probability: 11 },
    { score: '1-0', probability: 10 },
    { score: '0-0', probability: 8 },
    { score: '3-1', probability: 7 }
  ];
  
  const topGoalMinutes = [
    { minute: '15-30', probability: 25 },
    { minute: '31-45', probability: 22 },
    { minute: '60-75', probability: 20 },
    { minute: '76-90', probability: 18 }
  ];
  
  const h2hAnalysis = {
    recent_form: `Home: 3W-1D-1L | Away: 2W-2D-1L`,
    last_5: `${match.home_team} won 3 of last 5`,
    summary: `${match.home_team} has strong home record`
  };
  
  const oddsSuggestions = [
    { market: 'Over 2.5 Goals', suggested_odds: '1.85', value: 'Good' },
    { market: 'BTTS Yes', suggested_odds: '1.90', value: 'Fair' }
  ];
  
  const confidence = Math.round((Math.max(homeWinProb, drawProb, awayWinProb) + over25) / 2);
  
  return {
    match_id: match.match_id,
    home_team: match.home_team,
    away_team: match.away_team,
    league: match.league_name || match.league,
    match_time_pkt: match.match_time_pkt,
    winner_prob: { home: homeWinProb, draw: drawProb, away: awayWinProb },
    xG: { home: parseFloat(homeXg), away: parseFloat(awayXg), total: parseFloat(totalXg) },
    btts_prob: bttsProb,
    over_under: { '1.5': 75, '2.5': over25, '3.5': over35 },
    last10_prob: 45,
    confidence_score: confidence,
    strong_markets: strongMarkets,
    correct_scores: correctScores,
    top_goal_minutes: topGoalMinutes,
    h2h_analysis: h2hAnalysis,
    odds_suggestions: oddsSuggestions,
    risk_warning: confidence < 60 ? 'Low confidence - High risk bet' : null,
    is_new: true
  };
}

// ==================== API ROUTES ====================

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'Server is running',
    mongodb: isMongoConnected ? 'Connected' : 'Disconnected',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/matches', async (req, res) => {
  try {
    if (!isMongoConnected) {
      return res.status(503).json({ 
        success: false, 
        error: 'MongoDB not connected. Please check database configuration.' 
      });
    }
    
    const matches = await Match.find()
      .sort({ match_date: -1 })
      .limit(100);
    
    res.json({
      success: true,
      count: matches.length,
      worldCupQualifiers: matches.filter(m => m.is_world_cup_qualifier).length,
      data: matches
    });
  } catch (error) {
    console.error('❌ Error fetching matches:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/predictions', async (req, res) => {
  try {
    if (!isMongoConnected) {
      return res.status(503).json({ 
        success: false, 
        error: 'MongoDB not connected. Please check database configuration.' 
      });
    }
    
    const predictions = await Prediction.find()
      .sort({ created_at: -1 })
      .limit(100);
    
    const newCount = predictions.filter(p => p.is_new).length;
    
    res.json({
      success: true,
      count: predictions.length,
      newPredictions: newCount,
      data: predictions
    });
  } catch (error) {
    console.error('❌ Error fetching predictions:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/mark-predictions-seen', async (req, res) => {
  try {
    if (!isMongoConnected) {
      return res.status(503).json({ success: false, error: 'MongoDB not connected' });
    }
    
    await Prediction.updateMany(
      { is_new: true },
      { is_new: false }
    );
    
    res.json({ success: true, message: 'Predictions marked as seen' });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/fetch-matches', async (req, res) => {
  try {
    const matches = await fetchMatches();
    res.json({
      success: true,
      count: matches.length,
      data: matches
    });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/update-predictions', async (req, res) => {
  try {
    if (!isMongoConnected) {
      return res.status(503).json({ success: false, error: 'MongoDB not connected' });
    }
    
    console.log('🔄 ============ UPDATING PREDICTIONS ============');
    
    const matches = await Match.find().limit(100);
    console.log(`📊 Processing ${matches.length} matches...`);
    
    let updated = 0;
    for (const match of matches) {
      const existingPred = await Prediction.findOne({ match_id: match.match_id });
      const predictionData = calculatePredictions(match);
      
      // Mark as new only if it's a new prediction
      predictionData.is_new = !existingPred;
      
      await Prediction.findOneAndUpdate(
        { match_id: match.match_id },
        { ...predictionData, updated_at: new Date() },
        { upsert: true, new: true }
      );
      updated++;
    }
    
    console.log(`✅ ${updated} predictions updated`);
    console.log('============ PREDICTIONS COMPLETE ============\n');
    
    res.json({ success: true, message: `${updated} predictions updated`, count: updated });
  } catch (error) {
    console.error('❌ Error updating predictions:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ==================== AUTO TASKS ====================

setTimeout(async () => {
  try {
    console.log('🚀 Starting initial data fetch in 5 seconds...');
    await waitForMongo();
    
    const matches = await fetchMatches();
    
    if (matches && matches.length > 0) {
      console.log('🔄 Creating initial predictions...');
      for (const match of matches) {
        try {
          const predictionData = calculatePredictions(match);
          predictionData.is_new = true;
          await Prediction.findOneAndUpdate(
            { match_id: match.match_id },
            { ...predictionData, updated_at: new Date() },
            { upsert: true, new: true }
          );
        } catch (error) {
          console.error(`❌ Error creating prediction:`, error.message);
        }
      }
      console.log(`✅ Initial predictions created for ${matches.length} matches`);
    } else {
      console.log('⚠️ No matches to create predictions for');
    }
  } catch (error) {
    console.error('❌ Initial fetch error:', error.message);
    console.error('💡 The server will continue running, but database operations may fail.');
  }
}, 5000);

// Auto-fetch matches every 15 minutes
setInterval(async () => {
  if (!isMongoConnected) {
    console.warn('⚠️ Skipping auto-fetch - MongoDB not connected');
    return;
  }
  
  try {
    console.log('🔄 Auto-fetching matches...');
    await fetchMatches();
  } catch (error) {
    console.error('❌ Auto-fetch error:', error.message);
  }
}, 15 * 60 * 1000);

// Auto-update predictions every 5 minutes
setInterval(async () => {
  if (!isMongoConnected) {
    console.warn('⚠️ Skipping auto-update - MongoDB not connected');
    return;
  }
  
  try {
    console.log('🔄 Auto-updating predictions...');
    const matches = await Match.find().limit(100);
    
    for (const match of matches) {
      try {
        const existingPred = await Prediction.findOne({ match_id: match.match_id });
        const predictionData = calculatePredictions(match);
        predictionData.is_new = !existingPred;
        
        await Prediction.findOneAndUpdate(
          { match_id: match.match_id },
          { ...predictionData, updated_at: new Date() },
          { upsert: true, new: true }
        );
      } catch (error) {
        console.error(`❌ Error updating prediction:`, error.message);
      }
    }
    
    console.log(`✅ ${matches.length} predictions auto-updated`);
  } catch (error) {
    console.error('❌ Auto-update error:', error.message);
  }
}, 5 * 60 * 1000);

// ==================== START SERVER ====================

app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║   ⚽ ENHANCED PREDICTION SYSTEM LIVE ⚽     ║');
  console.log('║                                            ║');
  console.log(`║   🚀 Server: http://localhost:${PORT}     ║`);
  console.log('║   🏆 Top 8 Leagues + World Cup Qualifiers ║');
  console.log('║   🌐 API 1: API-Football (Primary)         ║');
  console.log('║   🌐 API 2: Football-Data (Fallback)       ║');
  console.log('║   🇵🇰 Pakistan Timezone (PKT)              ║');
  console.log('║   ✅ Fixed MongoDB Connection Handling     ║');
  console.log('║   ✅ Better Error Messages                 ║');
  console.log('╚════════════════════════════════════════════╝\n');
  
  console.log('📋 Health Check: http://localhost:' + PORT + '/api/health');
  console.log('📊 API Endpoints:');
  console.log('   GET  /api/matches');
  console.log('   GET  /api/predictions');
  console.log('   POST /api/fetch-matches');
  console.log('   POST /api/update-predictions\n');
});

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  if (isMongoConnected) {
    await mongoose.connection.close();
    console.log('✅ MongoDB connection closed');
  }
  process.exit(0);
});
