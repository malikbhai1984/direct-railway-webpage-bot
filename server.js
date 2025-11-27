const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const moment = require('moment-timezone');
const cors = require('cors');
const nodeCron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());

// MongoDB Schema
const predictionSchema = new mongoose.Schema({
  matchId: String,
  homeTeam: String,
  awayTeam: String,
  league: String,
  matchTime: Date,
  prediction: {
    winnerProb: {
      home: Number,
      draw: Number,
      away: Number
    },
    bttsProb: Number,
    last10Prob: Number,
    strongMarkets: [{
      market: String,
      prob: Number
    }],
    expectedGoals: {
      home: Number,
      away: Number,
      total: Number
    }
  },
  timestamp: { type: Date, default: Date.now }
});

const Prediction = mongoose.model('Prediction', predictionSchema);

// API Configuration
const API_CONFIG = {
  rapidapi: {
    key: process.env.RAPIDAPI_KEY || 'your-rapidapi-key',
    host: 'api-football-v1.p.rapidapi.com',
    baseUrl: 'https://api-football-v1.p.rapidapi.com/v3'
  },
  thesports: {
    key: process.env.THESPORTS_KEY || 'your-thesports-key',
    baseUrl: 'https://www.thesportsdb.com/api/v1/json'
  },
  football-data: {
    key: process.env.FOOTBALL_DATA_KEY || 'your-football-data-key',
    baseUrl: 'https://api.football-data.org/v4'
  }
};

// Top 10 Leagues IDs
const TOP_LEAGUES = {
  39: 'Premier League', // England
  140: 'La Liga', // Spain
  78: 'Bundesliga', // Germany
  135: 'Serie A', // Italy
  61: 'Ligue 1', // France
  88: 'Eredivisie', // Netherlands
  94: 'Primeira Liga', // Portugal
  203: 'Super Lig', // Turkey
  262: 'Bundesliga', // Austria
  253: 'MLS' // USA
};

// Fetch Today's Matches
async function fetchTodayMatches() {
  try {
    const today = moment().tz('Asia/Karachi').format('YYYY-MM-DD');
    console.log(`Fetching matches for: ${today}`);
    
    const matches = [];
    
    // Fetch from RapidAPI
    try {
      const response = await axios.get(`${API_CONFIG.rapidapi.baseUrl}/fixtures`, {
        headers: {
          'X-RapidAPI-Key': API_CONFIG.rapidapi.key,
          'X-RapidAPI-Host': API_CONFIG.rapidapi.host
        },
        params: {
          date: today,
          league: Object.keys(TOP_LEAGUES).join(','),
          season: '2024'
        }
      });
      
      if (response.data && response.data.response) {
        response.data.response.forEach(match => {
          matches.push({
            home: match.teams.home.name,
            away: match.teams.away.name,
            league: match.league.name,
            kickoff: moment(match.fixture.date).tz('Asia/Karachi').format('HH:mm'),
            status: match.fixture.status.short
          });
        });
      }
    } catch (rapidError) {
      console.log('RapidAPI failed, trying backup API...');
    }
    
    // Backup API call if primary fails
    if (matches.length === 0) {
      try {
        const backupResponse = await axios.get(`${API_CONFIG.football-data.baseUrl}/matches`, {
          headers: {
            'X-Auth-Token': API_CONFIG.football-data.key
          },
          params: {
            dateFrom: today,
            dateTo: today,
            competitions: Object.keys(TOP_LEAGUES).join(',')
          }
        });
        
        if (backupResponse.data && backupResponse.data.matches) {
          backupResponse.data.matches.forEach(match => {
            matches.push({
              home: match.homeTeam.name,
              away: match.awayTeam.name,
              league: match.competition.name,
              kickoff: moment(match.utcDate).tz('Asia/Karachi').format('HH:mm'),
              status: match.status
            });
          });
        }
      } catch (backupError) {
        console.log('Backup API also failed');
      }
    }
    
    return matches;
  } catch (error) {
    console.error('Error fetching matches:', error.message);
    return [];
  }
}

// Prediction Engine
class PredictionEngine {
  constructor() {
    this.analysisHistory = [];
  }

  // Analyze match and generate predictions
  async analyzeMatch(match) {
    try {
      // Get team statistics
      const homeStats = await this.getTeamStats(match.home);
      const awayStats = await this.getTeamStats(match.away);
      
      // Head to head analysis
      const h2h = await this.getHeadToHead(match.home, match.away);
      
      // Calculate probabilities
      const winnerProb = this.calculateWinnerProbability(homeStats, awayStats, h2h);
      const bttsProb = this.calculateBTTSProbability(homeStats, awayStats);
      const last10Prob = this.calculateLast10Probability(homeStats, awayStats);
      const expectedGoals = this.calculateExpectedGoals(homeStats, awayStats);
      
      // Identify strong markets
      const strongMarkets = this.identifyStrongMarkets({
        winnerProb,
        bttsProb,
        last10Prob,
        expectedGoals
      });
      
      return {
        winnerProb,
        bttsProb,
        last10Prob,
        strongMarkets,
        expectedGoals
      };
    } catch (error) {
      console.error('Error analyzing match:', error);
      return this.getDefaultPrediction();
    }
  }

  // Get team statistics (mock implementation - replace with actual API calls)
  async getTeamStats(teamName) {
    // In real implementation, fetch from API
    return {
      attack: Math.random() * 100,
      defense: Math.random() * 100,
      form: Math.random() * 100,
      goalsScored: Math.floor(Math.random() * 50) + 20,
      goalsConceded: Math.floor(Math.random() * 40) + 15,
      corners: Math.floor(Math.random() * 150) + 50,
      last10Goals: Math.floor(Math.random() * 20) + 5
    };
  }

  // Get head to head statistics
  async getHeadToHead(homeTeam, awayTeam) {
    // In real implementation, fetch from API
    return {
      totalMatches: Math.floor(Math.random() * 20) + 5,
      homeWins: Math.floor(Math.random() * 10),
      awayWins: Math.floor(Math.random() * 8),
      draws: Math.floor(Math.random() * 5),
      goalsHome: Math.floor(Math.random() * 30) + 10,
      goalsAway: Math.floor(Math.random() * 25) + 8
    };
  }

  // Calculate winner probability
  calculateWinnerProbability(homeStats, awayStats, h2h) {
    const homeAdvantage = 1.2; // Home advantage factor
    
    const homeStrength = (homeStats.attack * 0.4 + homeStats.defense * 0.3 + homeStats.form * 0.3) * homeAdvantage;
    const awayStrength = awayStats.attack * 0.4 + awayStats.defense * 0.3 + awayStats.form * 0.3;
    
    const totalStrength = homeStrength + awayStrength;
    
    // Adjust based on H2H
    const h2hFactor = h2h.homeWins / (h2h.totalMatches || 1);
    
    const homeProb = Math.min(95, Math.max(5, (homeStrength / totalStrength) * 100 + h2hFactor * 10));
    const awayProb = Math.min(95, Math.max(5, (awayStrength / totalStrength) * 100 - h2hFactor * 10));
    const drawProb = Math.min(95, Math.max(5, 100 - homeProb - awayProb));
    
    // Normalize to ensure sum = 100
    const total = homeProb + drawProb + awayProb;
    
    return {
      home: Math.round((homeProb / total) * 100),
      draw: Math.round((drawProb / total) * 100),
      away: Math.round((awayProb / total) * 100)
    };
  }

  // Calculate BTTS probability
  calculateBTTSProbability(homeStats, awayStats) {
    const homeAttack = homeStats.attack / 100;
    const awayAttack = awayStats.attack / 100;
    const homeDefense = (100 - homeStats.defense) / 100;
    const awayDefense = (100 - awayStats.defense) / 100;
    
    const bttsProb = (homeAttack * awayDefense + awayAttack * homeDefense) * 50;
    return Math.min(95, Math.max(10, Math.round(bttsProb)));
  }

  // Calculate last 10 minutes goal probability
  calculateLast10Probability(homeStats, awayStats) {
    const homeLateGoals = homeStats.last10Goals / 10;
    const awayLateGoals = awayStats.last10Goals / 10;
    
    const lateGoalProb = (homeLateGoals + awayLateGoals) * 3;
    return Math.min(80, Math.max(5, Math.round(lateGoalProb)));
  }

  // Calculate expected goals
  calculateExpectedGoals(homeStats, awayStats) {
    const homeXG = (homeStats.attack / 100) * 2.5 + (awayStats.defense / 100) * 0.5;
    const awayXG = (awayStats.attack / 100) * 2.0 + (homeStats.defense / 100) * 0.5;
    
    return {
      home: parseFloat(homeXG.toFixed(1)),
      away: parseFloat(awayXG.toFixed(1)),
      total: parseFloat((homeXG + awayXG).toFixed(1))
    };
  }

  // Identify strong markets (85%+ confidence)
  identifyStrongMarkets(prediction) {
    const strongMarkets = [];
    
    // Check winner markets
    if (prediction.winnerProb.home >= 85) {
      strongMarkets.push({ market: 'Home Win', prob: prediction.winnerProb.home });
    }
    if (prediction.winnerProb.away >= 85) {
      strongMarkets.push({ market: 'Away Win', prob: prediction.winnerProb.away });
    }
    if (prediction.winnerProb.draw >= 85) {
      strongMarkets.push({ market: 'Draw', prob: prediction.winnerProb.draw });
    }
    
    // Check BTTS
    if (prediction.bttsProb >= 85) {
      strongMarkets.push({ market: 'BTTS Yes', prob: prediction.bttsProb });
    } else if (prediction.bttsProb <= 15) {
      strongMarkets.push({ market: 'BTTS No', prob: 100 - prediction.bttsProb });
    }
    
    // Check over/under markets based on expected goals
    if (prediction.expectedGoals.total >= 3.5) {
      strongMarkets.push({ market: 'Over 3.5 Goals', prob: 85 });
    } else if (prediction.expectedGoals.total >= 2.5) {
      strongMarkets.push({ market: 'Over 2.5 Goals', prob: 75 });
    } else if (prediction.expectedGoals.total <= 1.5) {
      strongMarkets.push({ market: 'Under 2.5 Goals', prob: 85 });
    }
    
    return strongMarkets;
  }

  getDefaultPrediction() {
    return {
      winnerProb: { home: 33, draw: 34, away: 33 },
      bttsProb: 50,
      last10Prob: 30,
      strongMarkets: [],
      expectedGoals: { home: 1.2, away: 1.1, total: 2.3 }
    };
  }
}

// Initialize prediction engine
const predictionEngine = new PredictionEngine();

// Routes
app.get('/today', async (req, res) => {
  try {
    const matches = await fetchTodayMatches();
    res.json({
      success: true,
      data: matches,
      timestamp: new Date()
    });
  } catch (error) {
    res.json({
      success: false,
      error: error.message,
      data: []
    });
  }
});

app.get('/predictions', async (req, res) => {
  try {
    const matches = await fetchTodayMatches();
    const predictions = [];
    
    // Generate predictions for each match
    for (const match of matches.slice(0, 10)) { // Limit to 10 matches
      const prediction = await predictionEngine.analyzeMatch(match);
      
      predictions.push({
        teams: `${match.home} vs ${match.away}`,
        matchDate: `Today, ${match.kickoff} PKT`,
        prediction: prediction
      });
      
      // Save to database
      const predictionRecord = new Prediction({
        matchId: `${match.home}-${match.away}-${Date.now()}`,
        homeTeam: match.home,
        awayTeam: match.away,
        league: match.league,
        matchTime: new Date(),
        prediction: prediction
      });
      
      await predictionRecord.save();
    }
    
    res.json({
      success: true,
      matches: predictions,
      ts: new Date()
    });
  } catch (error) {
    res.json({
      success: false,
      error: error.message,
      matches: []
    });
  }
});

// SSE for live updates
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // Send initial data
  sendPredictions(res);

  // Update every 5 minutes
  const interval = setInterval(() => {
    sendPredictions(res);
  }, 5 * 60 * 1000);

  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });
});

async function sendPredictions(res) {
  try {
    const matches = await fetchTodayMatches();
    const predictions = [];
    
    for (const match of matches.slice(0, 8)) {
      const prediction = await predictionEngine.analyzeMatch(match);
      predictions.push({
        teams: `${match.home} vs ${match.away}`,
        matchDate: `Today, ${match.kickoff} PKT`,
        prediction: prediction
      });
    }
    
    res.write(`data: ${JSON.stringify({
      matches: predictions,
      ts: new Date()
    })}\n\n`);
  } catch (error) {
    res.write(`data: ${JSON.stringify({
      error: error.message,
      matches: []
    })}\n\n`);
  }
}

// Cron job to update predictions every 5 minutes
nodeCron.schedule('*/5 * * * *', async () => {
  console.log('Running scheduled prediction update...');
  try {
    const matches = await fetchTodayMatches();
    
    for (const match of matches.slice(0, 10)) {
      const prediction = await predictionEngine.analyzeMatch(match);
      
      // Save to database
      const predictionRecord = new Prediction({
        matchId: `${match.home}-${match.away}-${Date.now()}`,
        homeTeam: match.home,
        awayTeam: match.away,
        league: match.league,
        matchTime: new Date(),
        prediction: prediction
      });
      
      await predictionRecord.save();
    }
    
    console.log('Predictions updated successfully');
  } catch (error) {
    console.error('Error updating predictions:', error);
  }
});

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/football-predictions', {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('Connected to MongoDB'))
.catch(err => console.error('MongoDB connection error:', err));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Frontend: http://localhost:${PORT}`);
});
