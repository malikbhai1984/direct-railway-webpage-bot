



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
  
  // STEP 1: Try API-Football first
  const apiFootballMatches = await fetchFromApiFootball();
  if (apiFootballMatches && apiFootballMatches.length > 0) {
    allMatches = [...allMatches, ...apiFootballMatches];
  }
  
  // STEP 2: If API-Football limit reached or failed, try Football-Data
  if (apiFootballCalls >= API_FOOTBALL_LIMIT || !apiFootballMatches) {
    console.log('\n🔄 Switching to Football-Data.org...');
    const footballDataMatches = await fetchFromFootballData();
    if (footballDataMatches && footballDataMatches.length > 0) {
      allMatches = [...allMatches, ...footballDataMatches];
    }
  }
  
  // Remove duplicates (same match from both APIs)
  const uniqueMatches = [];
  const seen = new Set();
  
  for (const match of allMatches) {
    const key = `${match.home_team}-${match.away_team}-${match.match_date}`;
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
  
  console.log(`✅ Saved: ${saved}/${uniqueMatches.length} to database`);
  console.log('============ FETCH COMPLETE ============\n');
  
  return uniqueMatches;
}import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// API Key
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || 'fdab0eef5743173c30f9810bef3a6742';

// Top Leagues + Arab Cup
const TOP_LEAGUES = {
  39: 'Premier League',
  140: 'La Liga',
  135: 'Serie A',
  78: 'Bundesliga',
  61: 'Ligue 1',
  94: 'Primeira Liga',
  88: 'Eredivisie',
  203: 'Super Lig',
  480: 'Arab Cup',  // IMPORTANT: Arab Cup League ID
  32: 'World Cup Qualification Africa',
  33: 'World Cup Qualification Asia',
  34: 'World Cup Qualification Europe'
};

let apiCalls = 0;
const API_LIMIT = 100;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ==================== MONGODB CONNECTION (FIXED) ====================
const MONGODB_URI = process.env.MONGO_PUBLIC_URL ||  // Priority: MONGO_PUBLIC_URL first
                    process.env.MONGO_URI || 
                    process.env.MONGODB_URI || 
                    'mongodb://localhost:27017/football-predictions';

console.log('🔌 Connecting to MongoDB...');
console.log('📍 URI:', MONGODB_URI.includes('mongodb.net') ? 'Cloud MongoDB' : 'Local MongoDB');

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
  away_logo: String
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

// ==================== HELPERS ====================
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

// ==================== FETCH FROM API-FOOTBALL ====================
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
    
    console.log('📅 Fetching:', today, '&', tomorrow);
    
    let allMatches = [];
    
    // Fetch all matches for these dates
    for (const date of [today, tomorrow]) {
      if (apiFootballCalls >= API_FOOTBALL_LIMIT) break;
      
      console.log(`\n🔍 API-Football: Fetching ${date}...`);
      
      try {
        const response = await fetch(
          `https://v3.football.api-sports.io/fixtures?date=${date}`,
          {
            headers: {
              'x-rapidapi-key': API_FOOTBALL_KEY,
              'x-rapidapi-host': 'v3.football.api-sports.io'
            }
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
        
        // Filter for target leagues
        const filtered = data.response.filter(f => 
          Object.keys(TOP_LEAGUES).includes(String(f.league.id))
        );
        
        console.log(`🎯 Filtered: ${filtered.length} from target leagues`);
        
        // Show breakdown
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
          league_name: f.league.name,
          home_score: f.goals.home,
          away_score: f.goals.away,
          status: convertStatus(f.fixture.status.short),
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
        console.error(`❌ Error: ${error.message}`);
      }
    }
    
    console.log(`\n✅ API-Football Total: ${allMatches.length} matches`);
    return allMatches.length > 0 ? allMatches : null;
    
  } catch (error) {
    console.error('❌ API-Football Error:', error.message);
    return null;
  }
}

// ==================== FETCH FROM FOOTBALL-DATA ====================
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
      
      console.log(`\n🔍 Football-Data: Fetching ${date}...`);
      
      try {
        const response = await fetch(
          `https://api.football-data.org/v4/matches?date=${date}`,
          {
            headers: {
              'X-Auth-Token': FOOTBALL_DATA_KEY
            }
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
          home_team: m.homeTeam.name,
          away_team: m.awayTeam.name,
          league: m.competition.name,
          league_name: m.competition.name,
          home_score: m.score.fullTime.home,
          away_score: m.score.fullTime.away,
          status: convertStatus(m.status),
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
        console.error(`❌ Error: ${error.message}`);
      }
    }
    
    console.log(`\n✅ Football-Data Total: ${allMatches.length} matches`);
    return allMatches.length > 0 ? allMatches : null;
    
  } catch (error) {
    console.error('❌ Football-Data Error:', error.message);
    return null;
  }
}

// ==================== AUTO CLEANUP FINISHED ====================
async function cleanupFinished() {
  if (!isMongoConnected) return;
  
  try {
    // Delete finished matches
    const finishedResult = await Match.deleteMany({
      status: { $in: ['FT', 'AET', 'PEN'] }
    });
    
    // Delete old matches (older than today)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const oldResult = await Match.deleteMany({
      match_date: { $lt: todayStart }
    });
    
    const totalDeleted = finishedResult.deletedCount + oldResult.deletedCount;
    
    if (totalDeleted > 0) {
      console.log(`🗑️ Removed ${finishedResult.deletedCount} finished + ${oldResult.deletedCount} old matches = ${totalDeleted} total`);
      
      // Remove orphaned predictions
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
    time: new Date().toISOString()
  });
});

// Get ONLY ACTIVE matches (NS, LIVE, HT, 1H, 2H, ET)
app.get('/api/matches', async (req, res) => {
  try {
    if (!isMongoConnected) {
      return res.status(503).json({ success: false, error: 'MongoDB offline' });
    }
    
    // Get current time in UTC
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    
    const tomorrowEnd = new Date(now);
    tomorrowEnd.setDate(tomorrowEnd.getDate() + 2);
    tomorrowEnd.setHours(23, 59, 59, 999);
    
    console.log('📅 Filtering matches:');
    console.log('   From:', todayStart.toISOString());
    console.log('   To:', tomorrowEnd.toISOString());
    
    const matches = await Match.find({
      status: { $in: ['NS', 'LIVE', '1H', '2H', 'HT', 'ET'] },
      match_date: { 
        $gte: todayStart,  // From today onwards
        $lte: tomorrowEnd   // Until tomorrow end
      }
    })
      .sort({ match_date: 1 })
      .limit(100);
    
    console.log(`📊 Active matches returned: ${matches.length}`);
    
    if (matches.length > 0) {
      console.log(`   Sample: ${matches[0].home_team} vs ${matches[0].away_team}`);
      console.log(`   League: ${matches[0].league}`);
      console.log(`   Date: ${matches[0].match_date}`);
    }
    
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

// Get predictions for active matches only
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
    tomorrowEnd.setHours(23, 59, 59, 999);
    
    const activeIds = await Match.find({
      status: { $in: ['NS', 'LIVE', '1H', '2H', 'HT', 'ET'] },
      match_date: { 
        $gte: todayStart,
        $lte: tomorrowEnd
      }
    }).distinct('match_id');
    
    const predictions = await Prediction.find({
      match_id: { $in: activeIds }
    })
      .sort({ createdAt: -1 })
      .limit(100);
    
    const newCount = predictions.filter(p => p.is_new).length;
    
    console.log(`📊 Predictions returned: ${predictions.length} (${newCount} new)`);
    
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

app.post('/api/mark-predictions-seen', async (req, res) => {
  try {
    await Prediction.updateMany({ is_new: true }, { is_new: false });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// EMERGENCY: Delete old matches (older than today)
app.get('/api/cleanup-old-matches', async (req, res) => {
  try {
    if (!isMongoConnected) {
      return res.status(503).json({ success: false, error: 'MongoDB offline' });
    }
    
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    console.log('🗑️ Deleting matches older than:', todayStart.toISOString());
    
    const result = await Match.deleteMany({
      match_date: { $lt: todayStart }
    });
    
    console.log(`🗑️ Deleted ${result.deletedCount} old matches`);
    
    // Also delete orphaned predictions
    const activeIds = await Match.find().distinct('match_id');
    const predResult = await Prediction.deleteMany({
      match_id: { $nin: activeIds }
    });
    
    console.log(`🗑️ Deleted ${predResult.deletedCount} old predictions`);
    
    res.json({
      success: true,
      matchesDeleted: result.deletedCount,
      predictionsDeleted: predResult.deletedCount,
      message: `Cleaned up ${result.deletedCount} old matches`
    });
  } catch (err) {
    console.error('❌ Cleanup error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ==================== AUTO TASKS ====================

// Initial fetch (10s delay)
setTimeout(async () => {
  if (!isMongoConnected) {
    console.log('⚠️ Waiting for MongoDB...');
    let attempts = 0;
    while (!isMongoConnected && attempts < 30) {
      await new Promise(r => setTimeout(r, 1000));
      attempts++;
    }
  }
  
  if (isMongoConnected) {
    console.log('🚀 Initial fetch starting...');
    const matches = await fetchMatches();
    
    if (matches.length > 0) {
      console.log('🔄 Creating predictions...');
      for (const match of matches) {
        const pred = calculatePredictions(match);
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

// Auto-fetch every 15 min
setInterval(async () => {
  if (isMongoConnected) {
    await fetchMatches();
  }
}, 15 * 60 * 1000);

// Auto-update + cleanup every 5 min
setInterval(async () => {
  if (!isMongoConnected) return;
  
  console.log('\n🔄 Auto-update...');
  
  await cleanupFinished();
  
  const activeMatches = await Match.find({
    status: { $in: ['NS', 'LIVE', '1H', '2H', 'HT', 'ET'] }
  }).limit(100);
  
  console.log(`📊 Updating ${activeMatches.length} predictions`);
  
  for (const match of activeMatches) {
    const existing = await Prediction.findOne({ match_id: match.match_id });
    const pred = calculatePredictions(match);
    pred.is_new = !existing;
    
    await Prediction.findOneAndUpdate(
      { match_id: match.match_id },
      pred,
      { upsert: true, new: true }
    );
  }
  
  console.log('✅ Update complete\n');
}, 5 * 60 * 1000);

// Aggressive cleanup every 2 min
setInterval(async () => {
  if (isMongoConnected) {
    await cleanupFinished();
  }
}, 2 * 60 * 1000);

// ==================== START ====================
app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║   ⚽ FOOTBALL PREDICTION SYSTEM ⚽          ║');
  console.log('║                                            ║');
  console.log(`║   🚀 Server: http://localhost:${PORT}     ║`);
  console.log('║   📅 Fetches: Today + Tomorrow             ║');
  console.log('║   🌐 API 1: API-Football (100 calls)       ║');
  console.log('║   🌐 API 2: Football-Data (50 calls)       ║');
  console.log('║   🔄 Auto-switch on limit                  ║');
  console.log('║   🗑️  Auto-cleanup finished                ║');
  console.log('║   🏆 Arab Cup + World Cup Qualifiers       ║');
  console.log('║   🇵🇰 Pakistan Time                         ║');
  console.log('╚════════════════════════════════════════════╝\n');
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 SIGTERM received, shutting down...');
  if (isMongoConnected) {
    await mongoose.connection.close();
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n🛑 SIGINT received, shutting down...');
  if (isMongoConnected) {
    await mongoose.connection.close();
  }
  process.exit(0);
});
