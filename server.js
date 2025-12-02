const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/football-predictions';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => {
  console.log('✅ MongoDB Connected Successfully!');
  console.log('📦 Database:', mongoose.connection.db.databaseName);
})
.catch(err => console.error('❌ MongoDB Connection Error:', err));

// ==================== SCHEMAS (WITHOUT DUPLICATE INDEX) ====================

// Match Schema - Fixed (No Duplicate Index)
const matchSchema = new mongoose.Schema({
  match_id: { 
    type: String, 
    required: true, 
    unique: true  // This already creates an index, no need for 'index: true'
  },
  home_team: { type: String, required: true },
  away_team: { type: String, required: true },
  league: String,
  league_name: String,
  home_score: Number,
  away_score: Number,
  status: { type: String, default: 'NS' }, // NS, LIVE, 1H, 2H, HT, FT
  match_time: String,
  match_time_pkt: String,
  match_date: Date,
  venue: String,
  home_logo: String,
  away_logo: String,
  fetched_at: { type: Date, default: Date.now }
}, { 
  timestamps: true 
});

// Only ONE index definition - at schema level
matchSchema.index({ match_date: -1 });
matchSchema.index({ status: 1 });

// Prediction Schema - Fixed
const predictionSchema = new mongoose.Schema({
  match_id: { 
    type: String, 
    required: true, 
    unique: true  // Already creates index
  },
  home_team: { type: String, required: true },
  away_team: { type: String, required: true },
  league: String,
  match_time_pkt: String,
  
  // Winner Probabilities
  winner_prob: {
    home: { type: Number, default: 0 },
    draw: { type: Number, default: 0 },
    away: { type: Number, default: 0 }
  },
  
  // Expected Goals
  xG: {
    home: { type: Number, default: 0 },
    away: { type: Number, default: 0 },
    total: { type: Number, default: 0 }
  },
  
  // Markets
  btts_prob: { type: Number, default: 0 },
  over_under: {
    '1.5': { type: Number, default: 0 },
    '2.5': { type: Number, default: 0 },
    '3.5': { type: Number, default: 0 }
  },
  last10_prob: { type: Number, default: 0 },
  
  // Enhanced Features
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
  
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
}, { 
  timestamps: true 
});

// Indexes for predictions
predictionSchema.index({ created_at: -1 });
predictionSchema.index({ confidence_score: -1 });

// Models
const Match = mongoose.model('Match', matchSchema);
const Prediction = mongoose.model('Prediction', predictionSchema);

// ==================== HELPER FUNCTIONS ====================

// Calculate predictions (deterministic)
function calculatePredictions(match) {
  // Simple deterministic calculation based on team names and match data
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
  
  // Strong markets (≥85%)
  const strongMarkets = [];
  if (homeWinProb >= 85) strongMarkets.push({ market: 'Home Win', prob: homeWinProb });
  if (awayWinProb >= 85) strongMarkets.push({ market: 'Away Win', prob: awayWinProb });
  if (over25 >= 85) strongMarkets.push({ market: 'Over 2.5', prob: over25 });
  
  // Correct scores
  const correctScores = [
    { score: '2-1', probability: 15 },
    { score: '1-1', probability: 12 },
    { score: '2-0', probability: 11 },
    { score: '1-0', probability: 10 },
    { score: '0-0', probability: 8 },
    { score: '3-1', probability: 7 }
  ];
  
  // Top goal minutes
  const topGoalMinutes = [
    { minute: '15-30', probability: 25 },
    { minute: '31-45', probability: 22 },
    { minute: '60-75', probability: 20 },
    { minute: '76-90', probability: 18 }
  ];
  
  // H2H Analysis (simulated)
  const h2hAnalysis = {
    recent_form: `Home: 3W-1D-1L | Away: 2W-2D-1L`,
    last_5: `${match.home_team} won 3 of last 5`,
    summary: `${match.home_team} has strong home record`
  };
  
  // Odds suggestions
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
    winner_prob: {
      home: homeWinProb,
      draw: drawProb,
      away: awayWinProb
    },
    xG: {
      home: parseFloat(homeXg),
      away: parseFloat(awayXg),
      total: parseFloat(totalXg)
    },
    btts_prob: bttsProb,
    over_under: {
      '1.5': 75,
      '2.5': over25,
      '3.5': over35
    },
    last10_prob: 45,
    confidence_score: confidence,
    strong_markets: strongMarkets,
    correct_scores: correctScores,
    top_goal_minutes: topGoalMinutes,
    h2h_analysis: h2hAnalysis,
    odds_suggestions: oddsSuggestions,
    risk_warning: confidence < 60 ? 'Low confidence - High risk bet' : null
  };
}

// Convert Pakistan Time
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

// ==================== API ROUTES ====================

// Get all matches
app.get('/api/matches', async (req, res) => {
  try {
    const matches = await Match.find()
      .sort({ match_date: -1 })
      .limit(100);
    
    res.json({
      success: true,
      count: matches.length,
      data: matches
    });
  } catch (error) {
    console.error('❌ Error fetching matches:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get all predictions
app.get('/api/predictions', async (req, res) => {
  try {
    const predictions = await Prediction.find()
      .sort({ created_at: -1 })
      .limit(100);
    
    res.json({
      success: true,
      count: predictions.length,
      data: predictions
    });
  } catch (error) {
    console.error('❌ Error fetching predictions:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get single prediction
app.get('/api/predictions/:matchId', async (req, res) => {
  try {
    const prediction = await Prediction.findOne({ 
      match_id: req.params.matchId 
    });
    
    if (!prediction) {
      return res.status(404).json({
        success: false,
        error: 'Prediction not found'
      });
    }
    
    res.json({
      success: true,
      data: prediction
    });
  } catch (error) {
    console.error('❌ Error fetching prediction:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Update predictions for all matches
app.post('/api/update-predictions', async (req, res) => {
  try {
    console.log('🔄 ============ UPDATING PREDICTIONS ============');
    
    const matches = await Match.find({ status: 'NS' }).limit(100);
    console.log(`📊 Processing ${matches.length} matches...`);
    
    let updated = 0;
    for (const match of matches) {
      const predictionData = calculatePredictions(match);
      
      await Prediction.findOneAndUpdate(
        { match_id: match.match_id },
        { 
          ...predictionData,
          updated_at: new Date()
        },
        { upsert: true, new: true }
      );
      updated++;
    }
    
    console.log(`✅ ${updated} predictions updated`);
    console.log('============ PREDICTIONS COMPLETE ============\n');
    
    res.json({
      success: true,
      message: `${updated} predictions updated`,
      count: updated
    });
  } catch (error) {
    console.error('❌ Error updating predictions:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Fetch live matches (mock data for testing)
app.post('/api/fetch-matches', async (req, res) => {
  try {
    console.log('🔄 ============ FETCHING LIVE MATCHES ============');
    
    const pakistanDate = new Date().toLocaleDateString('en-PK', {
      timeZone: 'Asia/Karachi'
    });
    console.log('📅 Pakistan Date:', pakistanDate);
    
    // Mock data for testing (replace with actual API call)
    const mockMatches = [
      {
        match_id: `test_${Date.now()}_1`,
        home_team: 'Manchester United',
        away_team: 'Liverpool',
        league: 'Premier League',
        league_name: 'Premier League',
        status: 'NS',
        match_time: new Date().toISOString(),
        match_time_pkt: toPakistanTime(new Date()),
        match_date: new Date(),
        venue: 'Old Trafford',
        home_logo: 'https://media.api-sports.io/football/teams/33.png',
        away_logo: 'https://media.api-sports.io/football/teams/40.png'
      },
      {
        match_id: `test_${Date.now()}_2`,
        home_team: 'Barcelona',
        away_team: 'Real Madrid',
        league: 'La Liga',
        league_name: 'La Liga',
        status: 'NS',
        match_time: new Date().toISOString(),
        match_time_pkt: toPakistanTime(new Date()),
        match_date: new Date(),
        venue: 'Camp Nou',
        home_logo: 'https://media.api-sports.io/football/teams/529.png',
        away_logo: 'https://media.api-sports.io/football/teams/541.png'
      }
    ];
    
    console.log(`✅ ${mockMatches.length} matches found`);
    
    // Save matches to database
    for (const match of mockMatches) {
      await Match.findOneAndUpdate(
        { match_id: match.match_id },
        match,
        { upsert: true, new: true }
      );
    }
    
    console.log('✅ Matches saved to database');
    console.log('============ FETCH COMPLETE ============\n');
    
    res.json({
      success: true,
      count: mockMatches.length,
      data: mockMatches
    });
  } catch (error) {
    console.error('❌ Error fetching matches:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== AUTO TASKS ====================

// Auto-update predictions every 5 minutes
setInterval(async () => {
  try {
    console.log('🔄 Auto-updating predictions...');
    const matches = await Match.find({ status: 'NS' }).limit(100);
    
    for (const match of matches) {
      const predictionData = calculatePredictions(match);
      await Prediction.findOneAndUpdate(
        { match_id: match.match_id },
        { ...predictionData, updated_at: new Date() },
        { upsert: true, new: true }
      );
    }
    
    console.log(`✅ ${matches.length} predictions auto-updated`);
  } catch (error) {
    console.error('❌ Auto-update error:', error);
  }
}, 5 * 60 * 1000); // Every 5 minutes

// ==================== START SERVER ====================

app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║   ⚽ ENHANCED PREDICTION SYSTEM LIVE ⚽     ║');
  console.log('║                                            ║');
  console.log(`║   🚀 Server: http://localhost:${PORT}     ║`);
  console.log('║   🎯 NEW: Correct Scores                   ║');
  console.log('║   🎯 NEW: Top Goal Minutes                 ║');
  console.log('║   🎯 NEW: H2H Analysis                     ║');
  console.log('║   🎯 NEW: Odds Suggestions                 ║');
  console.log('║   🎯 NEW: Risk Warnings                    ║');
  console.log('║   ✅ Deterministic Calculations            ║');
  console.log('║   ✅ NO Duplicate Schema Index             ║');
  console.log('╚════════════════════════════════════════════╝\n');
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await mongoose.connection.close();
  console.log('✅ MongoDB connection closed');
  process.exit(0);
});
