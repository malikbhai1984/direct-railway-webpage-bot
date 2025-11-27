// server.js

const express = require('express');
const mongoose = require('mongoose');
const moment = require('moment-timezone');
const axios = require('axios');
const cron = require('node-cron');
const cors = require('cors');
const path = require('path');
const { performance } = require('perf_hooks');

const app = express();
const PORT = 3000;
// *** MongoDB URI: Set your database connection here ***
const MONGO_URI = 'mongodb://localhost:27017/football_prediction_db'; 

// --- Configuration: Replace these placeholders with your actual API keys/details ---
const API_CONFIG = {
    // API 1: Primary Data Source
    FOOTBALL_API_1: {
        url: 'YOUR_API_BASE_URL_1', // e.g., 'https://api-football-v1.p.rapidapi.com/v3'
        key: 'YOUR_API_KEY_1',
        limit: 100, // Daily limit
        hits: 0,
    },
    // API 2: Secondary Data Source (for stats/odds)
    FOOTBALL_API_2: {
        url: 'YOUR_API_BASE_URL_2', // e.g., 'https://sportspredictionapi.com'
        key: 'YOUR_API_KEY_2',
        limit: 50,
        hits: 0,
    },
    // Add more APIs here (API 3, 4, 5)
};

// Point 12: Top 10 Leagues and World Cup Qualifiers (Filter list)
const TARGET_LEAGUES = ['Premier League', 'La Liga', 'Bundesliga', 'Serie A', 'Ligue 1', 'Champions League', 'Europa League', 'World Cup Qualifiers'];

app.use(cors());
// Serve index.html from the root directory
app.use(express.static(__dirname)); 
app.use(express.json());

// --- Database Connection ---
mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB connected successfully.'))
    .catch(err => console.error('MongoDB connection error:', err));

// --- Database Schema (Point 4: Automatic Saving) ---
const MatchSchema = new mongoose.Schema({
    apiSource: String,
    matchId: { type: String, unique: true },
    homeTeam: String,
    awayTeam: String,
    league: String,
    kickoffUTC: Date,
    kickoffPKT: String, // Point 2: PKT Time
    status: String,
    prediction: Object,
    timestamp: { type: Date, default: Date.now },
});

const Match = mongoose.model('Match', MatchSchema);

// Store predictions for SSE
let currentLivePredictions = [];
let clients = []; // For SSE connections

// --- 1. API Fetching and Data Consolidation (Points 1, 9, 12) ---
async function fetchMatchesFromAPI(apiConfig) {
    if (apiConfig.hits >= apiConfig.limit) return [];

    try {
        // --- ACTUAL API CALL PLACEHOLDER ---
        // Replace this MOCK DATA with a real Axios call to fetch today's matches
        // For demonstration, we use mock data:
        const rawMatches = [
            { id: 'm1', home: 'Man Utd', away: 'Chelsea', league: 'Premier League', date: moment().tz('UTC').add(2, 'hours').toISOString(), status: 'Scheduled' },
            { id: 'm2', home: 'FC Barcelona', away: 'Real Madrid', league: 'La Liga', date: moment().tz('UTC').subtract(30, 'minutes').toISOString(), status: 'Live' },
        ];
        
        apiConfig.hits++; // Increment hit counter (Point 9)

        const todayMatches = rawMatches
            .filter(m => TARGET_LEAGUES.includes(m.league))
            .map(m => {
                const kickoffUTC = moment.utc(m.date);
                const kickoffPKT = kickoffUTC.tz('Asia/Karachi').format('HH:mm'); // Point 2
                return {
                    apiSource: apiConfig.url,
                    matchId: m.id,
                    homeTeam: m.home,
                    awayTeam: m.away,
                    league: m.league,
                    kickoffUTC: kickoffUTC.toDate(),
                    kickoffPKT: kickoffPKT,
                    status: m.status,
                };
            });

        // Upsert into MongoDB (Point 4)
        await Promise.all(todayMatches.map(match => Match.updateOne(
            { matchId: match.matchId },
            { $set: match },
            { upsert: true }
        )));

        return todayMatches;

    } catch (error) {
        console.error(`Error fetching matches from ${apiConfig.url}:`, error.message);
        return [];
    }
}

async function fetchAndCombineMatches() {
    let allMatches = [];
    for (const key in API_CONFIG) {
        const matches = await fetchMatchesFromAPI(API_CONFIG[key]);
        allMatches = [...allMatches, ...matches];
    }
    // Simple deduplication
    const uniqueMatches = Array.from(new Map(allMatches.map(match => [match.matchId, match])).values());
    return uniqueMatches;
}

// --- 2. Pro-Level Prediction Engine (Points 3, 4, 5, 6, 7, 8, 11) ---
function runProLevelPrediction(match) {
    // Point 7: Simulate comprehensive statistical analysis 
    const historicalFormScore = Math.random() * 0.4; // Last 10 matches, H2H
    const liveStatsScore = match.status === 'Live' ? Math.random() * 0.4 : 0.1; // Corners, Attack/Defense Index
    
    // Simulate probability calculation (Point 11: ML/AI Model Sim)
    const homeProbRaw = 0.5 + historicalFormScore + liveStatsScore;
    const awayProbRaw = 0.5 + (1 - historicalFormScore) + (1 - liveStatsScore);
    
    const totalRaw = homeProbRaw + awayProbRaw + 1.0; // Adding a draw factor (1.0)
    
    // Calculate Winner Probabilities (Point 4)
    const homeProb = Math.floor((homeProbRaw / totalRaw) * 100);
    const awayProb = Math.floor((awayProbRaw / totalRaw) * 100);
    const drawProb = 100 - homeProb - awayProb; 

    // Point 5: BTTS Probability
    const bttsProb = Math.floor(60 + Math.random() * 35); 

    // Point 3: Expected Goals
    const expectedTotalGoals = parseFloat((Math.random() * 3.5 + 0.5).toFixed(2));
    const expectedGoals = { total: expectedTotalGoals.toFixed(2) };

    // Point 6: Last 10 Minutes Goal Check (High probability if score is tight and attacking stats are high)
    const last10Prob = match.status === 'Live' ? Math.floor(50 + Math.random() * 45) : 0; 
    
    // --- Strong Market Identification (85%+ Confidence) (Point 8) ---
    const strongMarkets = [];
    
    // Winner Check
    if (homeProb >= 85) strongMarkets.push({ market: `Winner: ${match.homeTeam}`, prob: homeProb });
    if (awayProb >= 85) strongMarkets.push({ market: `Winner: ${match.awayTeam}`, prob: awayProb });
    
    // BTTS Check
    if (bttsProb >= 85) strongMarkets.push({ market: 'BTTS: YES', prob: bttsProb });

    // Over/Under Check (Point 3: 0.5 to 5.5 Over/Under)
    if (expectedTotalGoals >= 1.5 && bttsProb > 70) {
        strongMarkets.push({ market: 'Over 1.5 Goals', prob: 90 + Math.floor(Math.random() * 5) });
    }
    
    // Last 10 Min Goal Check
    if (last10Prob >= 85) strongMarkets.push({ market: `Late Goal: ${match.homeTeam} or ${match.awayTeam}`, prob: last10Prob });


    return {
        winnerProb: { home: homeProb, draw: drawProb, away: awayProb },
        bttsProb: bttsProb,
        last10Prob: last10Prob,
        expectedGoals: expectedGoals,
        strongMarkets: strongMarkets,
    };
}

// --- 3. Cron Scheduler and SSE Update (Points 5, 10) ---

async function runPredictionCycle() {
    console.log(`--- Starting Prediction Cycle: ${moment().format('HH:mm:ss')} ---`);
    
    // 1. Fetch and save match data (Point 10: New API hit)
    await fetchAndCombineMatches();
    
    // 2. Get all today's matches
    const todayMatches = await Match.find({ 
        kickoffUTC: { $gte: moment().startOf('day').toDate(), $lt: moment().endOf('day').toDate() },
        status: { $in: ['Scheduled', 'Live'] }
    });
    
    // 3. Run prediction and update DB
    const predictions = todayMatches.map(match => {
        const prediction = runProLevelPrediction(match);
        
        // Update prediction in DB (Point 4)
        Match.updateOne({ matchId: match.matchId }, { $set: { prediction: prediction } }).exec();
        
        return {
            teams: `${match.homeTeam} vs ${match.awayTeam}`,
            matchDate: `${match.kickoffPKT} PKT / ${match.league}`,
            prediction: prediction
        };
    });

    currentLivePredictions = predictions;
    
    // 4. Push update to frontend
    sendSSEUpdate();
    console.log(`--- Prediction Cycle Finished. ${predictions.length} predictions generated. ---`);
}

function sendSSEUpdate() {
    const updateData = { 
        ts: moment().tz('Asia/Karachi').format('YYYY-MM-DD HH:mm:ss z'), 
        matches: currentLivePredictions 
    };
    const dataString = `data: ${JSON.stringify(updateData)}\n\n`;
    
    clients.forEach(client => {
        try {
            client.res.write(dataString);
        } catch (e) {
            clients = clients.filter(c => c.id !== client.id); // Remove broken client
        }
    });
}

// Initial run and Cron Schedule (Runs every 5 minutes)
runPredictionCycle(); 
cron.schedule('*/5 * * * *', runPredictionCycle); // Point 5

// Daily API reset (Point 9)
cron.schedule('0 0 * * *', () => {
    for (const key in API_CONFIG) { API_CONFIG[key].hits = 0; }
    console.log('Daily API hit counter reset.');
});


// --- 4. EXPRESS ROUTES ---

// Route for Today's Matches (Left Side)
app.get('/today', async (req, res) => {
    try {
        const todayMatches = await Match.find({ 
            kickoffUTC: { $gte: moment().startOf('day').toDate(), $lt: moment().endOf('day').toDate() }
        }).sort({ kickoffUTC: 1 });

        const formattedData = todayMatches.map(m => ({
            home: m.homeTeam,
            away: m.awayTeam,
            league: m.league,
            kickoff: m.kickoffPKT,
            status: m.status
        }));
        
        res.json({ success: true, data: formattedData });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// Server-Sent Events (SSE) Route (Right Side)
app.get('/events', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    
    const clientId = Date.now();
    const newClient = { id: clientId, res };
    clients.push(newClient);
    
    // Send initial snapshot
    newClient.res.write(`data: ${JSON.stringify({ 
        ts: moment().tz('Asia/Karachi').format('YYYY-MM-DD HH:mm:ss z'), 
        matches: currentLivePredictions 
    })}\n\n`);

    req.on('close', () => {
        clients = clients.filter(c => c.id !== clientId);
    });
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
