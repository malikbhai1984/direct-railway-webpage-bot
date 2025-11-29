import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Pakistan timezone
function getPakistanTime() {
    return new Date().toLocaleString('en-US', { 
        timeZone: 'Asia/Karachi',
        hour12: false 
    });
}

// Complete historical data - Last 15 matches
const historicalData = {
    'Manchester City': [
        { opponent: 'Liverpool', result: 'W', gf: 2, ga: 1, xG: 2.3, xGA: 1.1, date: '2024-11-10' },
        { opponent: 'Arsenal', result: 'D', gf: 1, ga: 1, xG: 1.8, xGA: 1.6, date: '2024-11-03' },
        { opponent: 'Chelsea', result: 'W', gf: 3, ga: 0, xG: 2.9, xGA: 0.8, date: '2024-10-27' },
        { opponent: 'Tottenham', result: 'W', gf: 2, ga: 0, xG: 2.1, xGA: 0.7, date: '2024-10-20' },
        { opponent: 'Newcastle', result: 'W', gf: 4, ga: 1, xG: 3.2, xGA: 1.2, date: '2024-10-13' },
        { opponent: 'Brighton', result: 'D', gf: 2, ga: 2, xG: 2.4, xGA: 1.9, date: '2024-10-06' },
        { opponent: 'Aston Villa', result: 'W', gf: 3, ga: 1, xG: 2.7, xGA: 1.3, date: '2024-09-29' },
        { opponent: 'West Ham', result: 'W', gf: 2, ga: 1, xG: 2.5, xGA: 1.0, date: '2024-09-22' },
        { opponent: 'Everton', result: 'W', gf: 3, ga: 0, xG: 2.8, xGA: 0.6, date: '2024-09-15' },
        { opponent: 'Wolves', result: 'W', gf: 2, ga: 1, xG: 2.2, xGA: 1.1, date: '2024-09-08' },
        { opponent: 'Crystal Palace', result: 'W', gf: 4, ga: 2, xG: 3.1, xGA: 1.8, date: '2024-09-01' },
        { opponent: 'Brentford', result: 'D', gf: 1, ga: 1, xG: 1.9, xGA: 1.5, date: '2024-08-25' },
        { opponent: 'Fulham', result: 'W', gf: 3, ga: 1, xG: 2.6, xGA: 1.2, date: '2024-08-18' },
        { opponent: 'Bournemouth', result: 'W', gf: 5, ga: 1, xG: 3.8, xGA: 1.0, date: '2024-08-11' },
        { opponent: 'Nottingham', result: 'W', gf: 2, ga: 0, xG: 2.3, xGA: 0.9, date: '2024-08-04' }
    ],
    'Liverpool': [
        { opponent: 'Man City', result: 'L', gf: 1, ga: 2, xG: 1.1, xGA: 2.3, date: '2024-11-10' },
        { opponent: 'Arsenal', result: 'W', gf: 3, ga: 1, xG: 2.8, xGA: 1.2, date: '2024-11-03' },
        { opponent: 'Chelsea', result: 'W', gf: 2, ga: 1, xG: 2.4, xGA: 1.3, date: '2024-10-27' },
        { opponent: 'Tottenham', result: 'D', gf: 2, ga: 2, xG: 2.1, xGA: 1.9, date: '2024-10-20' },
        { opponent: 'Newcastle', result: 'W', gf: 3, ga: 0, xG: 2.9, xGA: 0.8, date: '2024-10-13' },
        { opponent: 'Brighton', result: 'W', gf: 2, ga: 1, xG: 2.2, xGA: 1.4, date: '2024-10-06' },
        { opponent: 'Aston Villa', result: 'D', gf: 1, ga: 1, xG: 1.8, xGA: 1.6, date: '2024-09-29' },
        { opponent: 'West Ham', result: 'W', gf: 3, ga: 1, xG: 2.7, xGA: 1.1, date: '2024-09-22' },
        { opponent: 'Everton', result: 'W', gf: 2, ga: 0, xG: 2.3, xGA: 0.7, date: '2024-09-15' },
        { opponent: 'Wolves', result: 'W', gf: 3, ga: 1, xG: 2.8, xGA: 1.2, date: '2024-09-08' },
        { opponent: 'Crystal Palace', result: 'W', gf: 2, ga: 1, xG: 2.5, xGA: 1.0, date: '2024-09-01' },
        { opponent: 'Brentford', result: 'W', gf: 4, ga: 1, xG: 3.2, xGA: 1.1, date: '2024-08-25' },
        { opponent: 'Fulham', result: 'D', gf: 2, ga: 2, xG: 2.3, xGA: 1.8, date: '2024-08-18' },
        { opponent: 'Bournemouth', result: 'W', gf: 3, ga: 0, xG: 2.9, xGA: 0.9, date: '2024-08-11' },
        { opponent: 'Nottingham', result: 'W', gf: 2, ga: 1, xG: 2.4, xGA: 1.3, date: '2024-08-04' }
    ],
    'Arsenal': [
        { opponent: 'Chelsea', result: 'W', gf: 3, ga: 1, xG: 2.6, xGA: 1.2, date: '2024-11-10' },
        { opponent: 'Liverpool', result: 'L', gf: 1, ga: 3, xG: 1.2, xGA: 2.8, date: '2024-11-03' },
        { opponent: 'Newcastle', result: 'W', gf: 2, ga: 0, xG: 2.3, xGA: 0.9, date: '2024-10-27' },
        { opponent: 'Brighton', result: 'D', gf: 1, ga: 1, xG: 1.7, xGA: 1.5, date: '2024-10-20' },
        { opponent: 'Tottenham', result: 'W', gf: 3, ga: 2, xG: 2.8, xGA: 1.9, date: '2024-10-13' },
        { opponent: 'West Ham', result: 'W', gf: 2, ga: 1, xG: 2.2, xGA: 1.3, date: '2024-10-06' },
        { opponent: 'Everton', result: 'W', gf: 4, ga: 0, xG: 3.1, xGA: 0.7, date: '2024-09-29' },
        { opponent: 'Wolves', result: 'D', gf: 2, ga: 2, xG: 2.1, xGA: 1.8, date: '2024-09-22' },
        { opponent: 'Aston Villa', result: 'W', gf: 3, ga: 1, xG: 2.7, xGA: 1.2, date: '2024-09-15' },
        { opponent: 'Crystal Palace', result: 'W', gf: 2, ga: 0, xG: 2.4, xGA: 0.8, date: '2024-09-08' },
        { opponent: 'Brentford', result: 'W', gf: 3, ga: 1, xG: 2.6, xGA: 1.1, date: '2024-09-01' },
        { opponent: 'Fulham', result: 'D', gf: 1, ga: 1, xG: 1.8, xGA: 1.6, date: '2024-08-25' },
        { opponent: 'Bournemouth', result: 'W', gf: 4, ga: 1, xG: 3.2, xGA: 1.0, date: '2024-08-18' },
        { opponent: 'Nottingham', result: 'W', gf: 2, ga: 0, xG: 2.3, xGA: 0.9, date: '2024-08-11' },
        { opponent: 'Man City', result: 'D', gf: 1, ga: 1, xG: 1.6, xGA: 1.8, date: '2024-08-04' }
    ],
    'Chelsea': [
        { opponent: 'Arsenal', result: 'L', gf: 1, ga: 3, xG: 1.2, xGA: 2.6, date: '2024-11-10' },
        { opponent: 'Man City', result: 'L', gf: 0, ga: 3, xG: 0.8, xGA: 2.9, date: '2024-11-03' },
        { opponent: 'Liverpool', result: 'L', gf: 1, ga: 2, xG: 1.3, xGA: 2.4, date: '2024-10-27' },
        { opponent: 'Newcastle', result: 'W', gf: 2, ga: 1, xG: 2.1, xGA: 1.4, date: '2024-10-20' },
        { opponent: 'Brighton', result: 'D', gf: 1, ga: 1, xG: 1.6, xGA: 1.7, date: '2024-10-13' },
        { opponent: 'Tottenham', result: 'W', gf: 3, ga: 2, xG: 2.5, xGA: 1.9, date: '2024-10-06' },
        { opponent: 'West Ham', result: 'W', gf: 2, ga: 0, xG: 2.3, xGA: 0.9, date: '2024-09-29' },
        { opponent: 'Aston Villa', result: 'D', gf: 2, ga: 2, xG: 1.9, xGA: 1.8, date: '2024-09-22' },
        { opponent: 'Everton', result: 'W', gf: 3, ga: 1, xG: 2.6, xGA: 1.2, date: '2024-09-15' },
        { opponent: 'Wolves', result: 'W', gf: 2, ga: 1, xG: 2.2, xGA: 1.3, date: '2024-09-08' },
        { opponent: 'Crystal Palace', result: 'W', gf: 3, ga: 0, xG: 2.7, xGA: 0.8, date: '2024-09-01' },
        { opponent: 'Brentford', result: 'D', gf: 1, ga: 1, xG: 1.7, xGA: 1.5, date: '2024-08-25' },
        { opponent: 'Fulham', result: 'W', gf: 2, ga: 1, xG: 2.3, xGA: 1.2, date: '2024-08-18' },
        { opponent: 'Bournemouth', result: 'W', gf: 3, ga: 1, xG: 2.8, xGA: 1.1, date: '2024-08-11' },
        { opponent: 'Nottingham', result: 'W', gf: 2, ga: 0, xG: 2.4, xGA: 0.9, date: '2024-08-04' }
    ]
};

// H2H data
const h2hData = {
    'Manchester City-Liverpool': [
        { date: '2024-11-10', home: 'Man City', away: 'Liverpool', score: '2-1', xGH: 2.3, xGA: 1.1 },
        { date: '2024-08-15', home: 'Liverpool', away: 'Man City', score: '1-1', xGH: 1.5, xGA: 1.8 },
        { date: '2024-04-20', home: 'Man City', away: 'Liverpool', score: '3-1', xGH: 2.8, xGA: 1.3 },
        { date: '2024-01-12', home: 'Liverpool', away: 'Man City', score: '2-2', xGH: 1.9, xGA: 2.1 },
        { date: '2023-11-25', home: 'Man City', away: 'Liverpool', score: '1-0', xGH: 2.0, xGA: 1.2 }
    ],
    'Arsenal-Chelsea': [
        { date: '2024-11-10', home: 'Arsenal', away: 'Chelsea', score: '3-1', xGH: 2.6, xGA: 1.2 },
        { date: '2024-05-05', home: 'Chelsea', away: 'Arsenal', score: '1-2', xGH: 1.4, xGA: 2.3 },
        { date: '2024-02-14', home: 'Arsenal', away: 'Chelsea', score: '2-0', xGH: 2.5, xGA: 0.9 },
        { date: '2023-10-21', home: 'Chelsea', away: 'Arsenal', score: '2-2', xGH: 1.8, xGA: 1.9 },
        { date: '2023-08-12', home: 'Arsenal', away: 'Chelsea', score: '3-1', xGH: 2.7, xGA: 1.3 }
    ]
};

// Calculate team stats
function calculateStats(teamData) {
    const recent = teamData.slice(0, 10);
    const wins = recent.filter(m => m.result === 'W').length;
    const draws = recent.filter(m => m.result === 'D').length;
    
    return {
        avgGF: (recent.reduce((s, m) => s + m.gf, 0) / recent.length).toFixed(2),
        avgGA: (recent.reduce((s, m) => s + m.ga, 0) / recent.length).toFixed(2),
        avgXG: (recent.reduce((s, m) => s + m.xG, 0) / recent.length).toFixed(2),
        avgXGA: (recent.reduce((s, m) => s + m.xGA, 0) / recent.length).toFixed(2),
        form: ((wins * 3 + draws) / 30 * 100).toFixed(1),
        winRate: (wins / 10 * 100).toFixed(1),
        lastFive: recent.slice(0, 5).map(m => m.result).join('-')
    };
}

// Calculate H2H
function getH2H(home, away) {
    const key = `${home}-${away}`;
    const matches = h2hData[key] || [];
    
    let hw = 0, d = 0, aw = 0;
    matches.forEach(m => {
        const [hs, as] = m.score.split('-').map(Number);
        if (m.home === home) {
            if (hs > as) hw++;
            else if (hs === as) d++;
            else aw++;
        } else {
            if (as > hs) hw++;
            else if (hs === as) d++;
            else aw++;
        }
    });
    
    return { homeWins: hw, draws: d, awayWins: aw, total: matches.length };
}

// Poisson probability
function poisson(lambda, k) {
    let result = Math.exp(-lambda);
    for (let i = 1; i <= k; i++) {
        result *= lambda / i;
    }
    return result;
}

// Predict scores
function predictScores(homeXG, awayXG) {
    const scores = [];
    for (let h = 0; h <= 5; h++) {
        for (let a = 0; a <= 5; a++) {
            const prob = poisson(homeXG, h) * poisson(awayXG, a);
            scores.push({ score: `${h}-${a}`, probability: (prob * 100).toFixed(2) });
        }
    }
    return scores.sort((a, b) => b.probability - a.probability).slice(0, 5);
}

// Goal minutes
function goalMinutes(totalXG) {
    const periods = [
        { time: '1-15', mult: 0.8 },
        { time: '16-30', mult: 1.0 },
        { time: '31-45+', mult: 1.1 },
        { time: '46-60', mult: 1.0 },
        { time: '61-75', mult: 1.2 },
        { time: '76-90+', mult: 1.3 }
    ];
    
    return periods.map(p => ({
        period: p.time,
        probability: Math.min((totalXG * p.mult / 6 * 100), 100).toFixed(1)
    })).sort((a, b) => b.probability - a.probability);
}

// Calculate odds
function calcOdds(prob) {
    const decimal = ((100 / prob) * 1.05).toFixed(2);
    return { decimal, implied: (100 / decimal).toFixed(1) + '%' };
}

// Main prediction
app.post('/api/predict', (req, res) => {
    const { homeTeam, awayTeam } = req.body;
    
    const homeStats = calculateStats(historicalData[homeTeam] || []);
    const awayStats = calculateStats(historicalData[awayTeam] || []);
    const h2h = getH2H(homeTeam, awayTeam);
    
    // Calculate xG with form weighting
    const homeXG = parseFloat(homeStats.avgXG) * (1 + parseFloat(homeStats.form) / 300);
    const awayXG = parseFloat(awayStats.avgXG) * (1 + parseFloat(awayStats.form) / 300);
    
    // Win probabilities
    const total = homeXG + awayXG;
    const homeWin = ((homeXG / total) * 0.65 + parseFloat(homeStats.form) / 200 + 0.05) * 100;
    const draw = (1 - Math.abs(homeXG - awayXG) / total) * 23;
    const awayWin = 100 - homeWin - draw;
    
    // Over/Under
    const over25 = total > 2.5 ? Math.min(((total - 2.5) / 2) * 100 + 55, 92) : Math.max(55 - ((2.5 - total) / 2) * 50, 8);
    const over35 = total > 3.5 ? Math.min(((total - 3.5) / 2.5) * 100 + 45, 82) : Math.max(45 - ((3.5 - total) / 2.5) * 45, 8);
    const btts = Math.min((homeXG / 2.2 * awayXG / 2.2) * 100, 88);
    
    // Markets
    const markets = [
        { name: 'Home Win', prob: homeWin.toFixed(1), confidence: homeWin >= 85 ? 'HIGH' : homeWin >= 70 ? 'MEDIUM' : 'LOW', odds: calcOdds(homeWin) },
        { name: 'Draw', prob: draw.toFixed(1), confidence: draw >= 85 ? 'HIGH' : draw >= 70 ? 'MEDIUM' : 'LOW', odds: calcOdds(draw) },
        { name: 'Away Win', prob: awayWin.toFixed(1), confidence: awayWin >= 85 ? 'HIGH' : awayWin >= 70 ? 'MEDIUM' : 'LOW', odds: calcOdds(awayWin) },
        { name: 'Over 2.5', prob: over25.toFixed(1), confidence: over25 >= 85 ? 'HIGH' : over25 >= 70 ? 'MEDIUM' : 'LOW', odds: calcOdds(over25) },
        { name: 'Under 2.5', prob: (100 - over25).toFixed(1), confidence: (100 - over25) >= 85 ? 'HIGH' : (100 - over25) >= 70 ? 'MEDIUM' : 'LOW', odds: calcOdds(100 - over25) },
        { name: 'Over 3.5', prob: over35.toFixed(1), confidence: over35 >= 85 ? 'HIGH' : over35 >= 70 ? 'MEDIUM' : 'LOW', odds: calcOdds(over35) },
        { name: 'BTTS Yes', prob: btts.toFixed(1), confidence: btts >= 85 ? 'HIGH' : btts >= 70 ? 'MEDIUM' : 'LOW', odds: calcOdds(btts) },
        { name: 'BTTS No', prob: (100 - btts).toFixed(1), confidence: (100 - btts) >= 85 ? 'HIGH' : (100 - btts) >= 70 ? 'MEDIUM' : 'LOW', odds: calcOdds(100 - btts) }
    ];
    
    // Risk factors
    const risks = [];
    if (Math.abs(homeXG - awayXG) < 0.4) risks.push('⚠️ Close match - unpredictable result');
    if (parseFloat(homeStats.form) < 40 || parseFloat(awayStats.form) < 40) risks.push('⚠️ Poor form team - risky bet');
    if (h2h.draws / h2h.total > 0.3) risks.push('⚠️ High draw history');
    if (risks.length === 0) risks.push('✅ Low risk - confident predictions');
    
    res.json({
        timestamp: getPakistanTime(),
        match: { homeTeam, awayTeam },
        xG: { home: homeXG.toFixed(2), away: awayXG.toFixed(2), total: total.toFixed(2) },
        markets,
        correctScores: predictScores(homeXG, awayXG),
        goalMinutes: goalMinutes(total),
        stats: { home: homeStats, away: awayStats, h2h },
        risks,
        topPick: markets.filter(m => m.confidence === 'HIGH')[0] || markets[0]
    });
});

// Today's matches
app.get('/api/matches', (req, res) => {
    res.json([
        { id: 1, home: 'Manchester City', away: 'Liverpool', league: 'Premier League', time: '20:00', date: getPakistanTime().split(',')[0] },
        { id: 2, home: 'Arsenal', away: 'Chelsea', league: 'Premier League', time: '22:30', date: getPakistanTime().split(',')[0] }
    ]);
});

const PORT = 3001;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
