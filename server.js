import express from 'express';
import cors from 'cors';
import axios from 'axios';
import * as tf from '@tensorflow/tfjs-node';

const app = express();
app.use(cors());
app.use(express.json());

// Pakistan timezone offset
const PKT_OFFSET = 5 * 60 * 60 * 1000; // +5 hours in milliseconds

function getPakistanTime() {
    const now = new Date();
    const pktTime = new Date(now.getTime() + PKT_OFFSET);
    return pktTime.toLocaleString('en-US', { 
        timeZone: 'Asia/Karachi',
        hour12: false 
    });
}

// Static historical data for last 15 matches per team
const historicalMatchData = {
    'Manchester City': [
        { opponent: 'Liverpool', result: 'W', goalsFor: 2, goalsAgainst: 1, xG: 2.3, xGA: 1.1 },
        { opponent: 'Arsenal', result: 'D', goalsFor: 1, goalsAgainst: 1, xG: 1.8, xGA: 1.6 },
        { opponent: 'Chelsea', result: 'W', goalsFor: 3, goalsAgainst: 0, xG: 2.9, xGA: 0.8 },
        { opponent: 'Tottenham', result: 'W', goalsFor: 2, goalsAgainst: 0, xG: 2.1, xGA: 0.7 },
        { opponent: 'Newcastle', result: 'W', goalsFor: 4, goalsAgainst: 1, xG: 3.2, xGA: 1.2 },
        { opponent: 'Brighton', result: 'D', goalsFor: 2, goalsAgainst: 2, xG: 2.4, xGA: 1.9 },
        { opponent: 'Aston Villa', result: 'W', goalsFor: 3, goalsAgainst: 1, xG: 2.7, xGA: 1.3 },
        { opponent: 'West Ham', result: 'W', goalsFor: 2, goalsAgainst: 1, xG: 2.5, xGA: 1.0 },
        { opponent: 'Everton', result: 'W', goalsFor: 3, goalsAgainst: 0, xG: 2.8, xGA: 0.6 },
        { opponent: 'Wolves', result: 'W', goalsFor: 2, goalsAgainst: 1, xG: 2.2, xGA: 1.1 },
        { opponent: 'Crystal Palace', result: 'W', goalsFor: 4, goalsAgainst: 2, xG: 3.1, xGA: 1.8 },
        { opponent: 'Brentford', result: 'D', goalsFor: 1, goalsAgainst: 1, xG: 1.9, xGA: 1.5 },
        { opponent: 'Fulham', result: 'W', goalsFor: 3, goalsAgainst: 1, xG: 2.6, xGA: 1.2 },
        { opponent: 'Bournemouth', result: 'W', goalsFor: 5, goalsAgainst: 1, xG: 3.8, xGA: 1.0 },
        { opponent: 'Nottingham', result: 'W', goalsFor: 2, goalsAgainst: 0, xG: 2.3, xGA: 0.9 }
    ],
    'Liverpool': [
        { opponent: 'Manchester City', result: 'L', goalsFor: 1, goalsAgainst: 2, xG: 1.1, xGA: 2.3 },
        { opponent: 'Arsenal', result: 'W', goalsFor: 3, goalsAgainst: 1, xG: 2.8, xGA: 1.2 },
        { opponent: 'Chelsea', result: 'W', goalsFor: 2, goalsAgainst: 1, xG: 2.4, xGA: 1.3 },
        { opponent: 'Tottenham', result: 'D', goalsFor: 2, goalsAgainst: 2, xG: 2.1, xGA: 1.9 },
        { opponent: 'Newcastle', result: 'W', goalsFor: 3, goalsAgainst: 0, xG: 2.9, xGA: 0.8 },
        { opponent: 'Brighton', result: 'W', goalsFor: 2, goalsAgainst: 1, xG: 2.2, xGA: 1.4 },
        { opponent: 'Aston Villa', result: 'D', goalsFor: 1, goalsAgainst: 1, xG: 1.8, xGA: 1.6 },
        { opponent: 'West Ham', result: 'W', goalsFor: 3, goalsAgainst: 1, xG: 2.7, xGA: 1.1 },
        { opponent: 'Everton', result: 'W', goalsFor: 2, goalsAgainst: 0, xG: 2.3, xGA: 0.7 },
        { opponent: 'Wolves', result: 'W', goalsFor: 3, goalsAgainst: 1, xG: 2.8, xGA: 1.2 },
        { opponent: 'Crystal Palace', result: 'W', goalsFor: 2, goalsAgainst: 1, xG: 2.5, xGA: 1.0 },
        { opponent: 'Brentford', result: 'W', goalsFor: 4, goalsAgainst: 1, xG: 3.2, xGA: 1.1 },
        { opponent: 'Fulham', result: 'D', goalsFor: 2, goalsAgainst: 2, xG: 2.3, xGA: 1.8 },
        { opponent: 'Bournemouth', result: 'W', goalsFor: 3, goalsAgainst: 0, xG: 2.9, xGA: 0.9 },
        { opponent: 'Nottingham', result: 'W', goalsFor: 2, goalsAgainst: 1, xG: 2.4, xGA: 1.3 }
    ]
    // Add more teams as needed
};

// Head-to-head history
const h2hHistory = {
    'Manchester City-Liverpool': [
        { date: '2024-11-10', homeTeam: 'Manchester City', awayTeam: 'Liverpool', score: '2-1', xGHome: 2.3, xGAway: 1.1 },
        { date: '2024-08-15', homeTeam: 'Liverpool', awayTeam: 'Manchester City', score: '1-1', xGHome: 1.5, xGAway: 1.8 },
        { date: '2024-04-20', homeTeam: 'Manchester City', awayTeam: 'Liverpool', score: '3-1', xGHome: 2.8, xGAway: 1.3 },
        { date: '2024-01-12', homeTeam: 'Liverpool', awayTeam: 'Manchester City', score: '2-2', xGHome: 1.9, xGAway: 2.1 },
        { date: '2023-11-25', homeTeam: 'Manchester City', awayTeam: 'Liverpool', score: '1-0', xGHome: 2.0, xGAway: 1.2 }
    ]
};

// Simple ML model for predictions
class PredictionModel {
    constructor() {
        this.model = null;
        this.initModel();
    }

    async initModel() {
        // Simple neural network for match prediction
        this.model = tf.sequential({
            layers: [
                tf.layers.dense({ inputShape: [10], units: 32, activation: 'relu' }),
                tf.layers.dropout({ rate: 0.2 }),
                tf.layers.dense({ units: 16, activation: 'relu' }),
                tf.layers.dense({ units: 3, activation: 'softmax' }) // Win, Draw, Loss
            ]
        });

        this.model.compile({
            optimizer: 'adam',
            loss: 'categoricalCrossentropy',
            metrics: ['accuracy']
        });
    }

    async predict(features) {
        const tensor = tf.tensor2d([features]);
        const prediction = this.model.predict(tensor);
        const probs = await prediction.data();
        tensor.dispose();
        prediction.dispose();
        return {
            home_win: probs[0],
            draw: probs[1],
            away_win: probs[2]
        };
    }
}

const mlModel = new PredictionModel();

// Calculate team statistics
function calculateTeamStats(teamData) {
    if (!teamData || teamData.length === 0) {
        return {
            avgGoalsFor: 0,
            avgGoalsAgainst: 0,
            avgXG: 0,
            avgXGA: 0,
            form: 0,
            winRate: 0
        };
    }

    const recentMatches = teamData.slice(0, 10); // Last 10 matches
    const wins = recentMatches.filter(m => m.result === 'W').length;
    const draws = recentMatches.filter(m => m.result === 'D').length;

    return {
        avgGoalsFor: recentMatches.reduce((sum, m) => sum + m.goalsFor, 0) / recentMatches.length,
        avgGoalsAgainst: recentMatches.reduce((sum, m) => sum + m.goalsAgainst, 0) / recentMatches.length,
        avgXG: recentMatches.reduce((sum, m) => sum + m.xG, 0) / recentMatches.length,
        avgXGA: recentMatches.reduce((sum, m) => sum + m.xGA, 0) / recentMatches.length,
        form: (wins * 3 + draws) / (recentMatches.length * 3), // Points percentage
        winRate: wins / recentMatches.length
    };
}

// Calculate H2H stats
function calculateH2HStats(homeTeam, awayTeam) {
    const h2hKey = `${homeTeam}-${awayTeam}`;
    const reverseKey = `${awayTeam}-${homeTeam}`;
    const matches = h2hHistory[h2hKey] || h2hHistory[reverseKey] || [];

    if (matches.length === 0) {
        return { homeWins: 0, draws: 0, awayWins: 0, avgGoalsHome: 0, avgGoalsAway: 0 };
    }

    let homeWins = 0, draws = 0, awayWins = 0;
    let totalHomeGoals = 0, totalAwayGoals = 0;

    matches.forEach(match => {
        const [homeScore, awayScore] = match.score.split('-').map(Number);
        totalHomeGoals += homeScore;
        totalAwayGoals += awayScore;

        if (match.homeTeam === homeTeam) {
            if (homeScore > awayScore) homeWins++;
            else if (homeScore < awayScore) awayWins++;
            else draws++;
        } else {
            if (awayScore > homeScore) homeWins++;
            else if (awayScore < homeScore) awayWins++;
            else draws++;
        }
    });

    return {
        homeWins,
        draws,
        awayWins,
        avgGoalsHome: totalHomeGoals / matches.length,
        avgGoalsAway: totalAwayGoals / matches.length
    };
}

// Predict correct scores based on xG
function predictCorrectScores(homeXG, awayXG) {
    const scores = [];
    
    // Poisson distribution simulation for goals
    function poissonProb(lambda, k) {
        return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
    }
    
    function factorial(n) {
        if (n <= 1) return 1;
        return n * factorial(n - 1);
    }

    // Generate probability distribution for scores 0-5 for each team
    for (let homeGoals = 0; homeGoals <= 5; homeGoals++) {
        for (let awayGoals = 0; awayGoals <= 5; awayGoals++) {
            const prob = poissonProb(homeXG, homeGoals) * poissonProb(awayXG, awayGoals);
            scores.push({
                score: `${homeGoals}-${awayGoals}`,
                probability: prob * 100
            });
        }
    }

    // Sort by probability and return top 5
    return scores.sort((a, b) => b.probability - a.probability).slice(0, 5);
}

// Predict goal minutes with time-based probability
function predictGoalMinutes(homeXG, awayXG) {
    const minutes = [];
    const totalXG = homeXG + awayXG;
    
    // Time periods with different goal probabilities
    const timePeriods = [
        { range: '1-15', multiplier: 0.8 },
        { range: '16-30', multiplier: 1.0 },
        { range: '31-45', multiplier: 1.1 },
        { range: '46-60', multiplier: 1.0 },
        { range: '61-75', multiplier: 1.2 },
        { range: '76-90', multiplier: 1.3 }
    ];

    timePeriods.forEach(period => {
        const probability = (totalXG * period.multiplier / 6) * 100;
        minutes.push({
            period: period.range,
            probability: Math.min(probability, 100)
        });
    });

    return minutes.sort((a, b) => b.probability - a.probability);
}

// Calculate suggested odds based on probability
function calculateOdds(probability) {
    const margin = 1.05; // 5% bookmaker margin
    const decimal = (100 / probability) * margin;
    return {
        decimal: decimal.toFixed(2),
        fractional: decimalToFractional(decimal),
        implied: (100 / decimal).toFixed(2) + '%'
    };
}

function decimalToFractional(decimal) {
    const fraction = decimal - 1;
    const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
    const numerator = Math.round(fraction * 100);
    const denominator = 100;
    const divisor = gcd(numerator, denominator);
    return `${numerator / divisor}/${denominator / divisor}`;
}

// Main prediction endpoint
app.post('/api/predict', async (req, res) => {
    try {
        const { homeTeam, awayTeam, league } = req.body;

        // Get team statistics
        const homeStats = calculateTeamStats(historicalMatchData[homeTeam]);
        const awayStats = calculateTeamStats(historicalMatchData[awayTeam]);
        const h2hStats = calculateH2HStats(homeTeam, awayTeam);

        // Calculate expected goals with form weighting
        const homeFormWeight = 1 + (homeStats.form * 0.3);
        const awayFormWeight = 1 + (awayStats.form * 0.3);
        
        const homeXG = (homeStats.avgXG * homeFormWeight + h2hStats.avgGoalsHome * 0.3);
        const awayXG = (awayStats.avgXG * awayFormWeight + h2hStats.avgGoalsAway * 0.3);

        // Calculate match probabilities using xG-based model
        const totalXG = homeXG + awayXG;
        const homeWinProb = ((homeXG / totalXG) * 0.7 + homeStats.form * 0.2 + (h2hStats.homeWins / Math.max(h2hStats.homeWins + h2hStats.draws + h2hStats.awayWins, 1)) * 0.1) * 100;
        const drawProb = (1 - Math.abs(homeXG - awayXG) / (homeXG + awayXG)) * 25;
        const awayWinProb = 100 - homeWinProb - drawProb;

        // Over/Under calculations (deterministic based on xG)
        const totalGoalsExpected = homeXG + awayXG;
        const over25Prob = totalGoalsExpected > 2.5 ? 
            Math.min(((totalGoalsExpected - 2.5) / 2.5) * 100 + 50, 95) : 
            Math.max(50 - ((2.5 - totalGoalsExpected) / 2.5) * 50, 5);
        
        const over35Prob = totalGoalsExpected > 3.5 ? 
            Math.min(((totalGoalsExpected - 3.5) / 3.5) * 100 + 40, 85) : 
            Math.max(40 - ((3.5 - totalGoalsExpected) / 3.5) * 40, 5);

        // BTTS probability
        const bttsProb = Math.min((homeXG / 2.5 * awayXG / 2.5) * 100, 85);

        // Correct scores
        const correctScores = predictCorrectScores(homeXG, awayXG);

        // Goal minutes
        const goalMinutes = predictGoalMinutes(homeXG, awayXG);

        // High confidence markets (>85%)
        const predictions = [
            { market: 'Home Win', probability: homeWinProb, confidence: homeWinProb >= 85 ? 'HIGH' : homeWinProb >= 70 ? 'MEDIUM' : 'LOW', odds: calculateOdds(homeWinProb) },
            { market: 'Draw', probability: drawProb, confidence: drawProb >= 85 ? 'HIGH' : drawProb >= 70 ? 'MEDIUM' : 'LOW', odds: calculateOdds(drawProb) },
            { market: 'Away Win', probability: awayWinProb, confidence: awayWinProb >= 85 ? 'HIGH' : awayWinProb >= 70 ? 'MEDIUM' : 'LOW', odds: calculateOdds(awayWinProb) },
            { market: 'Over 2.5', probability: over25Prob, confidence: over25Prob >= 85 ? 'HIGH' : over25Prob >= 70 ? 'MEDIUM' : 'LOW', odds: calculateOdds(over25Prob) },
            { market: 'Under 2.5', probability: 100 - over25Prob, confidence: (100 - over25Prob) >= 85 ? 'HIGH' : (100 - over25Prob) >= 70 ? 'MEDIUM' : 'LOW', odds: calculateOdds(100 - over25Prob) },
            { market: 'Over 3.5', probability: over35Prob, confidence: over35Prob >= 85 ? 'HIGH' : over35Prob >= 70 ? 'MEDIUM' : 'LOW', odds: calculateOdds(over35Prob) },
            { market: 'BTTS', probability: bttsProb, confidence: bttsProb >= 85 ? 'HIGH' : bttsProb >= 70 ? 'MEDIUM' : 'LOW', odds: calculateOdds(bttsProb) }
        ];

        // Risk assessment
        const riskFactors = [];
        if (Math.abs(homeXG - awayXG) < 0.5) {
            riskFactors.push('Match is closely contested - result uncertain');
        }
        if (homeStats.form < 0.4 || awayStats.form < 0.4) {
            riskFactors.push('One or both teams in poor form - unpredictable outcomes');
        }
        if (h2hStats.draws / Math.max(h2hStats.homeWins + h2hStats.draws + h2hStats.awayWins, 1) > 0.3) {
            riskFactors.push('High draw rate in head-to-head history');
        }

        const response = {
            timestamp: getPakistanTime(),
            match: {
                homeTeam,
                awayTeam,
                league
            },
            expectedGoals: {
                home: homeXG.toFixed(2),
                away: awayXG.toFixed(2),
                total: (homeXG + awayXG).toFixed(2)
            },
            predictions,
            correctScores,
            goalMinutes,
            statistics: {
                home: homeStats,
                away: awayStats,
                h2h: h2hStats
            },
            riskFactors: riskFactors.length > 0 ? riskFactors : ['Low risk - confident prediction'],
            recommendation: predictions.filter(p => p.confidence === 'HIGH')[0]?.market || 'No high-confidence bet available'
        };

        res.json(response);

    } catch (error) {
        console.error('Prediction error:', error);
        res.status(500).json({ error: 'Prediction failed', details: error.message });
    }
});

// Get today's matches
app.get('/api/matches/today', async (req, res) => {
    try {
        // Mock data - replace with real API call
        const matches = [
            {
                id: 1,
                homeTeam: 'Manchester City',
                awayTeam: 'Liverpool',
                league: 'Premier League',
                time: '20:00',
                date: getPakistanTime().split(',')[0]
            },
            {
                id: 2,
                homeTeam: 'Arsenal',
                awayTeam: 'Chelsea',
                league: 'Premier League',
                time: '22:30',
                date: getPakistanTime().split(',')[0]
            }
        ];

        res.json(matches);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch matches' });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`🚀 Professional Prediction Server running on port ${PORT}`);
    console.log(`📍 Pakistan Time: ${getPakistanTime()}`);
    console.log(`🤖 ML Model initialized`);
});
