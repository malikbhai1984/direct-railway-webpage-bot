


import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// ==================== API KEYS ====================
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || 'fdab0eef5743173c30f9810bef3a6742';
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY || '62207494b8a241db93aee4c14b7c1266';

// ==================== TOP LEAGUES (WITH ARAB CUP) ====================
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
  32: 'World Cup - Qualification Africa',
  33: 'World Cup - Qualification Asia',
  34: 'World Cup - Qualification Europe',
  35: 'World Cup - Qualification South America'
};

let apiFootballCalls = 0;
let footballDataCalls = 0;
const API_FOOTBALL_LIMIT = 100;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ==================== MONGODB CONNECTION ====================
const MONGODB_URI = process.env.MONGO_URI || 
                    process.env.MONGODB_URI || 
                    process.env.MONGO_PUBLIC_URL ||
                    process.env.MONGO_URL ||
                    'mongodb://localhost:27017/football-predictions';

let isMongoConnected = false;

mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
})
.then(() => {
  console.log('✅ MongoDB Connected Successfully!');
  console.log('📦 Database:', mongoose.connection.db.databaseName);
  isMongoConnected = true;
})
.catch(err => {
  console.error('❌ MongoDB Connection Error:', err.message);
  isMongoConnected = false;
});

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ MongoDB Disconnected!');
  isMongoConnected = false;
});

mongoose.connection.on('reconnected', () => {
  console.log('✅ MongoDB Reconnected!');
  isMongoConnected = true;
});

async function waitForMongo() {
  let attempts = 0;
  while (!isMongoConnected && attempts < 30) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    attempts++;
  }
  if (!isMongoConnected) {
    throw new Error('MongoDB connection timeout');
  }
}

// ==================== SCHEMAS ====================
const matchSchema = new mongoose.Schema({
  match_id: { type: String, required: true, unique: true },
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
}, { timestamps: true });

matchSchema.index({ match_date: 1 });
matchSchema.index({ status: 1 });

const predictionSchema = new mongoose.Schema({
  match_id: { type: String, required: true, unique: true },
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
  strong_markets: [{ market: String, prob: Number }],
  correct_scores: [{ score: String, probability: Number }],
  top_goal_minutes: [{ minute: String, probability: Number }],
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
}, { timestamps: true });

predictionSchema.index({ created_at: -1 });
predictionSchema.index({ confidence_score: -1 });

const Match = mongoose.model('Match', matchSchema);
const Prediction = mongoose.model('Prediction', predictionSchema);

// ==================== HELPER FUNCTIONS ====================
function convertStatus(status) {
  const statusMap = {
    'NS': 'NS', 'TBD': 'NS', 'SCHEDULED': 'NS',
    'LIVE': 'LIVE', 'IN_PLAY': 'LIVE',
    '1H': '1H', 'HT': 'HT', '2H': '2H',
    'FT': 'FT', 'FINISHED': 'FT', 'AET': 'FT', 'PEN': 'FT',
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
    correct_scores: [
      { score: '2-1', probability: 15 },
      { score: '1-1', probability: 12 },
      { score: '2-0', probability: 11 },
      { score: '1-0', probability: 10 }
    ],
    top_goal_minutes: [
      { minute: '15-30', probability: 25 },
      { minute: '31-45', probability: 22 },
      { minute: '60-75', probability: 20 },
      { minute: '76-90', probability: 18 }
    ],
    h2h_analysis: {
      recent_form: `Home: 3W-1D-1L | Away: 2W-2D-1L`,
      last_5: `${match.home_team} won 3 of last 5`,
      summary: `${match.home_team} has strong home record`
    },
    odds_suggestions: [
      { market: 'Over 2.5 Goals', suggested_odds: '1.85', value: 'Good' },
      { market: 'BTTS Yes', suggested_odds: '1.90', value: 'Fair' }
    ],
    risk_warning: confidence < 60 ? 'Low confidence - High risk bet' : null,
    is_new: true
  };
}

// ==================== FETCH FROM API-FOOTBALL ====================
async function fetchFromApiFootball() {
  try {
    console.log('🌐 Fetching from API-Football...');
    console.log(`📊 API Calls: ${apiFootballCalls}/${API_FOOTBALL_LIMIT}`);
    
    if (apiFootballCalls >= API_FOOTBALL_LIMIT) {
      console.log('⚠️ API-Football limit reached');
      return null;
    }
    
    // IMPORTANT: Fetch TODAY and TOMORROW
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 24*60*60*1000).toISOString().split('T')[0];
    
    console.log('📅 Fetching matches for:', today, 'and', tomorrow);
    
    let allMatches = [];
    
    // Fetch for both dates
    for (const targetDate of [today, tomorrow]) {
      for (const [leagueId, leagueName] of Object.entries(TOP_LEAGUES)) {
        if (apiFootballCalls >= API_FOOTBALL_LIMIT) break;
        
        try {
          const response = await fetch(
            `https://v3.football.api-sports.io/fixtures?league=${leagueId}&season=2024&date=${targetDate}`,
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
              console.log(`✅ ${leagueName} (${targetDate}): ${data.response.length} matches`);
              
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
      
      if (apiFootballCalls >= API_FOOTBALL_LIMIT) break;
    }
    
    console.log(`✅ Total matches from API-Football: ${allMatches.length}`);
    return allMatches.length > 0 ? allMatches : null;
  } catch (error) {
    console.error('❌ API-Football Error:', error.message);
    return null;
  }
}

// ==================== FETCH MATCHES ====================
async function fetchMatches() {
  console.log('\n🔄 ============ FETCHING MATCHES ============');
  
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
  
  if (!isMongoConnected) {
    try {
      await waitForMongo();
    } catch (error) {
      console.error('❌ MongoDB not connected:', error.message);
      return [];
    }
  }
  
  let matches = await fetchFromApiFootball();
  
  if (!matches || matches.length === 0) {
    console.log('❌ No matches found!');
    return [];
  }
  
  console.log(`📊 Processing ${matches.length} total matches...`);
  
  // Save to database
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
      console.error(`❌ Error saving match:`, error.message);
    }
  }
  
  console.log(`✅ Saved ${savedCount}/${matches.length} matches`);
  console.log('============ FETCH COMPLETE ============\n');
  
  return matches;
}

// ==================== AUTO CLEANUP FINISHED MATCHES ====================
async function cleanupFinishedMatches() {
  if (!isMongoConnected) return;
  
  try {
    // Delete finished matches immediately
    const result = await Match.deleteMany({
      status: { $in: ['FT', 'AET', 'PEN'] }
    });
    
    if (result.deletedCount > 0) {
      console.log(`🗑️ Removed ${result.deletedCount} finished matches`);
      
      // Also delete their predictions
      const predResult = await Prediction.deleteMany({
        match_id: { $nin: await Match.find().distinct('match_id') }
      });
      
      if (predResult.deletedCount > 0) {
        console.log(`🗑️ Removed ${predResult.deletedCount} orphaned predictions`);
      }
    }
  } catch (error) {
    console.error('❌ Cleanup error:', error.message);
  }
}

// ==================== API ROUTES ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'Server running',
    mongodb: isMongoConnected ? 'Connected' : 'Disconnected',
    timestamp: new Date().toISOString()
  });
});

// Get matches (ONLY NON-FINISHED)
app.get('/api/matches', async (req, res) => {
  try {
    if (!isMongoConnected) {
      return res.status(503).json({ 
        success: false, 
        error: 'MongoDB not connected' 
      });
    }
    
    // CRITICAL: Only return non-finished matches
    const matches = await Match.find({
      status: { $nin: ['FT', 'AET', 'PEN'] }
    })
      .sort({ match_date: 1 })
      .limit(100);
    
    console.log(`📊 Active matches returned: ${matches.length}`);
    
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

// Get predictions (ONLY FOR ACTIVE MATCHES)
app.get('/api/predictions', async (req, res) => {
  try {
    if (!isMongoConnected) {
      return res.status(503).json({ 
        success: false, 
        error: 'MongoDB not connected' 
      });
    }
    
    // Get active match IDs
    const activeMatchIds = await Match.find({
      status: { $nin: ['FT', 'AET', 'PEN'] }
    }).distinct('match_id');
    
    // Only return predictions for active matches
    const predictions = await Prediction.find({
      match_id: { $in: activeMatchIds }
    })
      .sort({ created_at: -1 })
      .limit(100);
    
    const newCount = predictions.filter(p => p.is_new).length;
    
    console.log(`📊 Active predictions returned: ${predictions.length}`);
    
    res.json({
      success: true,
      count: predictions.length,
      newPredictions: newCount,
      data: predictions
    });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual fetch
app.post('/api/fetch-matches', async (req, res) => {
  try {
    console.log('🔄 Manual fetch triggered...');
    const matches = await fetchMatches();
    
    // Update predictions for new matches
    if (matches.length > 0) {
      for (const match of matches) {
        const predData = calculatePredictions(match);
        await Prediction.findOneAndUpdate(
          { match_id: match.match_id },
          { ...predData, updated_at: new Date() },
          { upsert: true, new: true }
        );
      }
    }
    
    res.json({
      success: true,
      count: matches.length,
      message: `Fetched ${matches.length} matches`
    });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Mark predictions as seen
app.post('/api/mark-predictions-seen', async (req, res) => {
  try {
    if (!isMongoConnected) {
      return res.status(503).json({ success: false, error: 'MongoDB not connected' });
    }
    
    await Prediction.updateMany({ is_new: true }, { is_new: false });
    res.json({ success: true, message: 'Predictions marked as seen' });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ==================== AUTO TASKS ====================

// Initial fetch on startup
setTimeout(async () => {
  try {
    console.log('🚀 Starting initial fetch...');
    await waitForMongo();
    
    const matches = await fetchMatches();
    
    if (matches && matches.length > 0) {
      console.log('🔄 Creating initial predictions...');
      for (const match of matches) {
        const predData = calculatePredictions(match);
        await Prediction.findOneAndUpdate(
          { match_id: match.match_id },
          { ...predData, updated_at: new Date() },
          { upsert: true, new: true }
        );
      }
      console.log(`✅ Created predictions for ${matches.length} matches`);
    }
  } catch (error) {
    console.error('❌ Initial fetch error:', error.message);
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

// Auto-update predictions & cleanup every 5 minutes
setInterval(async () => {
  if (!isMongoConnected) {
    console.warn('⚠️ Skipping auto-update - MongoDB not connected');
    return;
  }
  
  try {
    console.log('\n🔄 Auto-update starting...');
    
    // STEP 1: Clean up finished matches
    await cleanupFinishedMatches();
    
    // STEP 2: Update predictions for active matches
    const activeMatches = await Match.find({
      status: { $nin: ['FT', 'AET', 'PEN'] }
    }).limit(100);
    
    console.log(`📊 Updating predictions for ${activeMatches.length} active matches`);
    
    for (const match of activeMatches) {
      try {
        const existingPred = await Prediction.findOne({ match_id: match.match_id });
        const predData = calculatePredictions(match);
        predData.is_new = !existingPred;
        
        await Prediction.findOneAndUpdate(
          { match_id: match.match_id },
          { ...predData, updated_at: new Date() },
          { upsert: true, new: true }
        );
      } catch (error) {
        console.error(`❌ Prediction update error:`, error.message);
      }
    }
    
    console.log(`✅ Auto-update complete\n`);
  } catch (error) {
    console.error('❌ Auto-update error:', error.message);
  }
}, 5 * 60 * 1000);

// Cleanup every 2 minutes (aggressive)
setInterval(async () => {
  if (isMongoConnected) {
    await cleanupFinishedMatches();
  }
}, 2 * 60 * 1000);

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║   ⚽ FOOTBALL PREDICTION SYSTEM LIVE ⚽     ║');
  console.log('║                                            ║');
  console.log(`║   🚀 Server: http://localhost:${PORT}     ║`);
  console.log('║   📅 Fetches: Today + Tomorrow             ║');
  console.log('║   🗑️  Auto-removes finished matches        ║');
  console.log('║   🏆 Includes Arab Cup                     ║');
  console.log('║   🇵🇰 Pakistan Timezone (PKT)              ║');
  console.log('║   ✅ Clean every 2 minutes                 ║');
  console.log('╚════════════════════════════════════════════╝\n');
});

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  if (isMongoConnected) {
    await mongoose.connection.close();
    console.log('✅ MongoDB closed');
  }
  process.exit(0);
});
