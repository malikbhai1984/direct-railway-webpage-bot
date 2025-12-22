



// =============================================================================
// SYNDICATE v18.1 ML/AI - HIGH SCORE WIN/DRAW FIXED (3-1 = 85% HOME)
// =============================================================================

import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = 8080;
const PKT_OFFSET = 5 * 60 * 60 * 1000;

class SimpleCache {
  constructor(ttl = 10) { this.data = new Map(); this.ttl = ttl * 1000; }
  set(key, value) { this.data.set(key, { value, expiry: Date.now() + this.ttl }); }
  get(key) {
    const item = this.data.get(key);
    if (!item || Date.now() > item.expiry) { this.data.delete(key); return null; }
    return item.value;
  }
}

const MATCH_CACHE = new SimpleCache(15);
const NOTIF_CACHE = new SimpleCache(60);
const SOFASCORE_CACHE = new SimpleCache(30);

class MLNotificationSystem {
  constructor() { this.notifications = []; }
  
  addNotification(match) {
    const analysis = match.analysis;
    if (analysis.ai_confidence < 70) return;
    
    const notification = {
      id: Date.now() + Math.random(),
      league: match.league,
      teams: `${match.home_team} vs ${match.away_team}`,
      score: `${match.home_score}-${match.away_score}`,
      minute: match.minute,
      bestMarket: analysis.recommendation.market,
      bestConf: analysis.recommendation.conf,
      homeWin: analysis.dynamicWinDraw.homeWin,
      awayWin: analysis.dynamicWinDraw.awayWin,
      drawChance: analysis.dynamicWinDraw.draw,
      timestamp: Date.now(),
      isNew: true
    };
    
    this.notifications.unshift(notification);
    this.notifications = this.notifications.slice(0, 25);
  }
  
  getNotifications() {
    this.notifications = this.notifications.map(n => ({
      ...n,
      isNew: Date.now() - n.timestamp < 45000
    }));
    return this.notifications;
  }
}

const TOP_NOTIFICATIONS = new MLNotificationSystem();

class MLAIEngineV181 {
  constructor() {}
  
  poissonCDF(lambda, k) {
    let sum = 0;
    for (let i = 0; i <= k; i++) {
      sum += Math.exp(-lambda) * Math.pow(lambda, i) / this.factorial(i);
    }
    return sum;
  }
  
  factorial(n) {
    if (n <= 1) return 1; let result = 1;
    for (let i = 2; i <= n; i++) result *= i;
    return result;
  }
  
  // ✅ FIXED HIGH SCORE LOGIC - 3-1 = HOME 85% WIN
  calculateDynamicWinDraw(homeScore, awayScore, minute, lambda_h, lambda_a, totalLambda) {
    const scoreDiff = homeScore - awayScore;
    const totalGoals = homeScore + awayScore;
    
    let homeWinBase = (1 - Math.exp(-lambda_h)) * 100;
    let awayWinBase = (1 - Math.exp(-lambda_a)) * 100;
    let drawBase = Math.exp(-totalLambda) * 100;
    
    // ✅ SCORE DIFFERENTIAL (BIG SCORE = BIG IMPACT)
    if (Math.abs(scoreDiff) >= 2) {
      if (scoreDiff >= 2) { // 3-1, 2-0 etc = HOME DOMINATES
        homeWinBase *= 3.5;  
        awayWinBase *= 0.2;  
        drawBase *= 0.15;    
      } else { // AWAY LEADING BY 2+
        awayWinBase *= 3.5;
        homeWinBase *= 0.2;
        drawBase *= 0.15;
      }
    } else if (Math.abs(scoreDiff) === 1) {
      if (scoreDiff === 1) { // 1-0, 2-1
        homeWinBase *= 1.8;
        awayWinBase *= 0.5;
        drawBase *= 0.7;
      } else { // 0-1
        awayWinBase *= 1.8;
        homeWinBase *= 0.5;
        drawBase *= 0.7;
      }
    }
    
    // ✅ HIGH GOALS = LOW DRAW
    if (totalGoals >= 3) {
      drawBase *= 0.25;
      if (homeScore > awayScore) homeWinBase *= 2.0;
      else if (awayScore > homeScore) awayWinBase *= 2.0;
    }
    
    // ✅ LATE GAME DRAW BOOST
    if (minute > 75) {
      drawBase *= 1.5;
      homeWinBase *= 0.9;
      awayWinBase *= 0.9;
    }
    
    // ✅ NORMALIZE
    const total = homeWinBase + awayWinBase + drawBase;
    let homeWin = Math.round((homeWinBase / total) * 100);
    let awayWin = Math.round((awayWinBase / total) * 100);
    let draw = 100 - homeWin - awayWin;
    
    // ✅ MINIMUM FLOOR
    homeWin = Math.max(5, homeWin);
    awayWin = Math.max(5, awayWin);
    draw = Math.max(8, draw);
    
    return { homeWin, awayWin, draw };
  }
  
  analyzeAllMarkets(homeScore, awayScore, minute, league, xG_home, xG_away, shots_h, shots_a) {
    const totalGoals = homeScore + awayScore;
    const timeLeft = (90 - minute) / 90;
    const lambda_h = xG_home * timeLeft * (1 + shots_h / 10);
    const lambda_a = xG_away * timeLeft * (1 + shots_a / 10);
    const totalLambda = lambda_h + lambda_a;

    // ✅ ONLY MAIN MARKETS
    const markets = {};
    const MAIN_MARKETS = ['O0.5', 'O1.5', 'O2.5', 'O3.5', 'O4.5', 'O5.5'];
    
    MAIN_MARKETS.forEach(market => {
      const line = parseFloat(market.slice(1));
      if (totalGoals < line) {
        const k = Math.floor(line);
        const prob = 1 - this.poissonCDF(totalLambda, k - totalGoals - 1);
        markets[market] = Math.round(prob * 100);
      }
    });

    const dynamicWinDraw = this.calculateDynamicWinDraw(
      homeScore, awayScore, minute, lambda_h, lambda_a, totalLambda
    );

    const highConfMarkets = Object.entries(markets)
      .filter(([_, val]) => val > 70)
      .sort((a, b) => b[1] - a[1]);
    
    const bestMarket = highConfMarkets[0] ? {
      market: highConfMarkets[0][0],
      conf: highConfMarkets[0][1]
    } : null;

    return {
      activeMarkets: markets,
      dynamicWinDraw,
      recommendation: bestMarket,
      status: dynamicWinDraw.homeWin > dynamicWinDraw.awayWin ? "🏠 HOME LOCK" : 
              dynamicWinDraw.awayWin > dynamicWinDraw.homeWin ? "✈️ AWAY LOCK" : "🤝 DRAW RISK",
      totalLambda: Math.round(totalLambda * 100) / 100,
      highConfCount: highConfMarkets.length,
      ai_confidence: bestMarket ? bestMarket.conf : 0
    };
  }
  
  isValidData(xG_home, xG_away, shots_h, shots_a, minute) {
    return xG_home > 0 && xG_away > 0 && (shots_h + shots_a) >= 2 && 
           minute >= 10 && minute <= 90;
  }
}

const AI_ENGINE_V181 = new MLAIEngineV181();

function getPKTTime() {
  const now = new Date(Date.now() + PKT_OFFSET);
  return now.toTimeString().slice(0, 5);
}

async function fetchSofaScoreLive() {
  const cached = SOFASCORE_CACHE.get('sofascore_live');
  if (cached) return cached;
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch('https://api.sofascore.com/api/v1/sport/football/events/live', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json', 'Referer': 'https://www.sofascore.com/'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const data = await response.json();
    SOFASCORE_CACHE.set('sofascore_live', data.events || []);
    return data.events || [];
  } catch {
    return [];
  }
}

async function processSofaScoreMatch(rawMatch) {
  try {
    if (!rawMatch.id || !rawMatch.homeTeam?.name || !rawMatch.awayTeam?.name) return null;
    
    const homeScore = rawMatch.homeScore?.current ?? rawMatch.homeScore?.normaltime ?? 0;
    const awayScore = rawMatch.awayScore?.current ?? rawMatch.awayScore?.normaltime ?? 0;
    const minute = parseInt(rawMatch.minute?.display ?? rawMatch.minute ?? 45) || 45;
    const league = rawMatch.tournament?.uniqueTournament?.name ?? 'Live Match';
    
    const stats = rawMatch.statistics || {};
    const xG_home = parseFloat(rawMatch.xg?.home) || parseFloat(stats.home?.xg) || 0.4;
    const xG_away = parseFloat(rawMatch.xg?.away) || parseFloat(stats.away?.xg) || 0.4;
    const shots_h = parseFloat(stats.home?.shotsOnTarget || stats.home?.totalShots) || 2;
    const shots_a = parseFloat(stats.away?.shotsOnTarget || stats.away?.totalShots) || 2;
    
    if (!AI_ENGINE_V181.isValidData(xG_home, xG_away, shots_h, shots_a, minute)) return null;
    
    const analysis = AI_ENGINE_V181.analyzeAllMarkets(
      homeScore, awayScore, minute, league, xG_home, xG_away, shots_h, shots_a
    );
    
    if (analysis.ai_confidence >= 70) {
      TOP_NOTIFICATIONS.addNotification({
        id: rawMatch.id, league, home_team: rawMatch.homeTeam.name,
        home_score: homeScore, away_score: awayScore, 
        away_team: rawMatch.awayTeam.name, minute, analysis
      });
    }
    
    return {
      id: rawMatch.id, league, home_team: rawMatch.homeTeam.name,
      away_team: rawMatch.awayTeam.name, home_score: homeScore,
      away_score: awayScore, minute: Math.min(95, minute),
      total_goals: homeScore + awayScore, pk_time: getPKTTime(), analysis
    };
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const htmlPath = join(__dirname, 'index.html');
      const html = await readFile(htmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<h1>🧠 SYNDICATE v18.1 ML/AI</h1>`);
    }
    return;
  }
  
  if (url.pathname === '/api/matches') {
    try {
      const cacheKey = 'syndicate_v181_matches';
      let data = MATCH_CACHE.get(cacheKey);
      
      if (!data) {
        console.log(`🧠 v18.1 FIXED - ${getPKTTime()} PKT`);
        const events = await fetchSofaScoreLive();
        
        const processed = [];
        for (const event of events.slice(0, 80)) {
          const match = await processSofaScoreMatch(event);
          if (match) processed.push(match);
        }
        
        processed.sort((a, b) => b.analysis.ai_confidence - a.analysis.ai_confidence);
        
        data = {
          live: processed.slice(0, 25),
          live_count: processed.length,
          total_scanned: events.length,
          notifications: TOP_NOTIFICATIONS.getNotifications(),
          pkt_time: getPKTTime(),
          version: 'v18.1 HIGH SCORE FIXED'
        };
        MATCH_CACHE.set(cacheKey, data);
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ live: [], notifications: [] }));
    }
    return;
  }
  
  res.writeHead(404); res.end();
});

server.listen(PORT, () => {
  console.log(`\n🚀🧠 SYNDICATE v18.1 ML/AI STARTED! ✅`);
  console.log(`📱 http://localhost:${PORT}`);
  console.log(`✅ HIGH SCORE FIXED | 3-1=85% HOME | MAIN MARKETS | TOP NOTIFS`);
});
