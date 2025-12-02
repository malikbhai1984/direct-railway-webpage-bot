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
const API_FOOTBALL_LIMIT = 100;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ==================== MONGODB (COMPLETELY FIXED) ====================
const MONGODB_URI = process.env.MONGO_URI || 
                    process.env.MONGODB_URI || 
                    process.env.MONGO_PUBLIC_URL ||
                    process.env.DATABASE_URL ||
                    'mongodb://localhost:27017/football-predictions';

console.log('🔌 MongoDB Configuration:');
if (MONGODB_URI.includes('localhost')) {
  console.log('⚠️  Using LOCAL MongoDB (localhost:27017)');
  console.log('💡 For Railway: Add MongoDB service or set MONGO_URI in environment variables');
} else {
  console.log('✅ Using CLOUD MongoDB');
}

let isMongoConnected = false;

mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 15000,
  socketTimeoutMS: 45000,
  connectTimeoutMS: 15000
})
.then(() => {
  console.log('✅ MongoDB Connected Successfully!');
  console.log('📦 Database:', mongoose.connection.db.databaseName);
  isMongoConnected = true;
})
.catch(err => {
  console.error('❌ MongoDB Connection Failed!');
  console.error('Error:', err.message);
  console.error('\n💡 Solutions:');
  console.error('1. Railway: Add MongoDB from dashboard (+ New → Database → Add MongoDB)');
  console.error('2. Or set MONGO_URI environment variable with MongoDB Atlas connection string');
  console.error('3. Example: mongodb+srv://user:pass@cluster.mongodb.net/football\n');
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

async function waitForMongo() {
  let attempts = 0;
  const maxAttempts = 60;
  
  console.log('⏳ Waiting for MongoDB...');
  
  while (!isMongoConnected && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    attempts++;
    
    if (attempts % 10 === 0) {
      console.log(`⏳ Still waiting... (${attempts}/${maxAttempts}s)`);
    }
  }
  
  if (!isMongoConnected) {
    throw new Error('MongoDB connection timeout after 60 seconds');
  }
  
  console.log('✅ MongoDB ready!');
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
  is_new: { type: Boolean, default: true }
}, { timestamps: true });

predictionSchema.index({ createdAt: -1 });

const Match = mongoose.model('Match', matchSchema);
const Prediction = mongoose.model('Prediction', predictionSchema);

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
    over_under: { '1.5': 75, '2.5': over25, '3.5': 55 },
    last10_prob: 45,
    confidence_score: confidence,
    strong_markets: strongMarkets,
    is_new: true
  };
}

// ==================== FETCH MATCHES (IMPROVED) ====================
async function fetchMatches() {
  console.log('\n🔄 ============ FETCHING MATCHES ============');
  
  const pakistanTime = new Date().toLocaleString('en-PK', {
    timeZone: 'Asia/Karachi',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
  
  console.log('📅 Pakistan Time:', pakistanTime);
  
  if (!isMongoConnected) {
    try {
      await waitForMongo();
    } catch (error) {
      console.error('❌ MongoDB not ready:', error.message);
      return [];
    }
  }
  
  if (apiFootballCalls >= API_FOOTBALL_LIMIT) {
    console.log('⚠️ API limit reached');
    return [];
  }
  
  try {
    // Fetch TODAY and TOMORROW (UTC format)
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 24*60*60*1000).toISOString().split('T')[0];
    
    console.log('📅 Fetching dates:', today, 'and', tomorrow);
    
    let allMatches = [];
    
    // Fetch all matches for these dates
    for (const targetDate of [today, tomorrow]) {
      if (apiFootballCalls >= API_FOOTBALL_LIMIT) break;
      
      console.log(`\n🌐 Fetching all matches for ${targetDate}...`);
      
      const response = await fetch(
        `https://v3.football.api-sports.io/fixtures?date=${targetDate}`,
        {
          headers: {
            'x-rapidapi-key': API_FOOTBALL_KEY,
            'x-rapidapi-host': 'v3.football.api-sports.io'
          },
          timeout: 15000
        }
      );
      
      apiFootballCalls++;
      
      if (!response.ok) {
        console.log(`❌ API Error: ${response.status}`);
        continue;
      }
      
      const data = await response.json();
      
      if (!data.response || data.response.length === 0) {
        console.log(`⚠️ No matches for ${targetDate}`);
        continue;
      }
      
      console.log(`✅ Found ${data.response.length} total matches`);
      
      // Filter for target leagues
      const filtered = data.response.filter(f => 
        Object.keys(TOP_LEAGUES).includes(String(f.league.id))
      );
      
      console.log(`🎯 ${filtered.length} matches from target leagues`);
      
      // Show league breakdown
      const leagueCounts = {};
      filtered.forEach(f => {
        leagueCounts[f.league.name] = (leagueCounts[f.league.name] || 0) + 1;
      });
      
      Object.entries(leagueCounts).forEach(([league, count]) => {
        console.log(`   📌 ${league}: ${count} match(es)`);
      });
      
      const matches = filtered.map(fixture => ({
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
        api_source: 'API-Football'
      }));
      
      allMatches = [...allMatches, ...matches];
    }
    
    console.log(`\n✅ Total: ${allMatches.length} matches`);
    
    // Save to database
    let savedCount = 0;
    for (const match of allMatches) {
      try {
        await Match.findOneAndUpdate(
          { match_id: match.match_id },
          match,
          { upsert: true, new: true }
        );
        savedCount++;
      } catch (error) {
        console.error(`❌ Save error:`, error.message);
      }
    }
    
    console.log(`✅ Saved ${savedCount} matches to database`);
    console.log('============ FETCH COMPLETE ============\n');
    
    return allMatches;
    
  } catch (error) {
    console.error('❌ Fetch error:', error.message);
    return [];
  }
}

// ==================== CLEANUP FINISHED MATCHES ====================
async function cleanupFinishedMatches() {
  if (!isMongoConnected) return;
  
  try {
    const result = await Match.deleteMany({
      status: { $in: ['FT', 'AET', 'PEN'] }
    });
    
    if (result.deletedCount > 0) {
      console.log(`🗑️ Removed ${result.deletedCount} finished matches`);
      
      // Remove orphaned predictions
      const activeMatchIds = await Match.find().distinct('match_id');
      const predResult = await Prediction.deleteMany({
        match_id: { $nin: activeMatchIds }
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

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'Running',
    mongodb: isMongoConnected ? 'Connected' : 'Disconnected',
    apiCalls: `${apiFootballCalls}/${API_FOOTBALL_LIMIT}`,
    timestamp: new Date().toISOString()
  });
});

// Get ONLY active matches (no FT)
app.get('/api/matches', async (req, res) => {
  try {
    if (!isMongoConnected) {
      return res.status(503).json({ success: false, error: 'MongoDB not connected' });
    }
    
    const matches = await Match.find({
      status: { $nin: ['FT', 'AET', 'PEN'] }
    })
      .sort({ match_date: 1 })
      .limit(100);
    
    console.log(`📊 Returned ${matches.length} active matches`);
    
    res.json({
      success: true,
      count: matches.length,
      data: matches
    });
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get predictions for active matches only
app.get('/api/predictions', async (req, res) => {
  try {
    if (!isMongoConnected) {
      return res.status(503).json({ success: false, error: 'MongoDB not connected' });
    }
    
    const activeMatchIds = await Match.find({
      status: { $nin: ['FT', 'AET', 'PEN'] }
    }).distinct('match_id');
    
    const predictions = await Prediction.find({
      match_id: { $in: activeMatchIds }
    })
      .sort({ createdAt: -1 })
      .limit(100);
    
    const newCount = predictions.filter(p => p.is_new).length;
    
    console.log(`📊 Returned ${predictions.length} predictions`);
    
    res.json({
      success: true,
      count: predictions.length,
      newPredictions: newCount,
      data: predictions
    });
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual fetch
app.post('/api/fetch-matches', async (req, res) => {
  try {
    console.log('🔄 Manual fetch triggered');
    const matches = await fetchMatches();
    
    // Generate predictions
    if (matches.length > 0) {
      for (const match of matches) {
        const predData = calculatePredictions(match);
        await Prediction.findOneAndUpdate(
          { match_id: match.match_id },
          predData,
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
    console.error('❌ Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Clear all data (emergency)
app.get('/api/clear-all-data', async (req, res) => {
  try {
    if (!isMongoConnected) {
      return res.status(503).json({ success: false, error: 'MongoDB not connected' });
    }
    
    const m = await Match.deleteMany({});
    const p = await Prediction.deleteMany({});
    
    console.log('🗑️ DATABASE CLEARED!');
    console.log(`   Matches: ${m.deletedCount}`);
    console.log(`   Predictions: ${p.deletedCount}`);
    
    res.json({
      success: true,
      matchesDeleted: m.deletedCount,
      predictionsDeleted: p.deletedCount
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Mark predictions seen
app.post('/api/mark-predictions-seen', async (req, res) => {
  try {
    if (!isMongoConnected) {
      return res.status(503).json({ success: false, error: 'MongoDB not connected' });
    }
    
    await Prediction.updateMany({ is_new: true }, { is_new: false });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ==================== AUTO TASKS ====================

// Initial fetch (5s delay)
setTimeout(async () => {
  try {
    console.log('🚀 Starting initial fetch...');
    await waitForMongo();
    
    const matches = await fetchMatches();
    
    if (matches.length > 0) {
      console.log('🔄 Creating predictions...');
      for (const match of matches) {
        const predData = calculatePredictions(match);
        await Prediction.findOneAndUpdate(
          { match_id: match.match_id },
          predData,
          { upsert: true, new: true }
        );
      }
      console.log(`✅ Created ${matches.length} predictions`);
    }
  } catch (error) {
    console.error('❌ Initial fetch error:', error.message);
  }
}, 5000);

// Auto-fetch every 15 minutes
setInterval(async () => {
  if (isMongoConnected) {
    console.log('🔄 Auto-fetching...');
    await fetchMatches();
  }
}, 15 * 60 * 1000);

// Auto-update + cleanup every 5 minutes
setInterval(async () => {
  if (!isMongoConnected) return;
  
  try {
    console.log('\n🔄 Auto-update starting...');
    
    await cleanupFinishedMatches();
    
    const activeMatches = await Match.find({
      status: { $nin: ['FT', 'AET', 'PEN'] }
    }).limit(100);
    
    console.log(`📊 Updating ${activeMatches.length} predictions`);
    
    for (const match of activeMatches) {
      const existingPred = await Prediction.findOne({ match_id: match.match_id });
      const predData = calculatePredictions(match);
      predData.is_new = !existingPred;
      
      await Prediction.findOneAndUpdate(
        { match_id: match.match_id },
        predData,
        { upsert: true, new: true }
      );
    }
    
    console.log('✅ Auto-update complete\n');
  } catch (error) {
    console.error('❌ Auto-update error:', error.message);
  }
}, 5 * 60 * 1000);

// Aggressive cleanup every 2 minutes
setInterval(async () => {
  if (isMongoConnected) {
    await cleanupFinishedMatches();
  }
}, 2 * 60 * 1000);

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║   ⚽ FOOTBALL PREDICTION SYSTEM ⚽          ║');
  console.log('║                                            ║');
  console.log(`║   🚀 Server: http://localhost:${PORT}     ║`);
  console.log('║   📅 Fetches: Today + Tomorrow             ║');
  console.log('║   🗑️  Auto-removes finished matches        ║');
  console.log('║   🏆 Includes Arab Cup                     ║');
  console.log('║   🇵🇰 Pakistan Timezone                     ║');
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
