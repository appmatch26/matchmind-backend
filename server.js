// ════════════════════════════════════════════════════════════════
// MatchMind Backend Server
// Connects API-Football to your MatchMind app
// Runs on Railway (free tier)
// ════════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// API-Football config
const API_KEY = process.env.API_FOOTBALL_KEY;
const API_HOST = 'v3.football.api-sports.io';
const API_BASE = `https://${API_HOST}`;

// Simple in-memory cache (refreshes every 30 minutes)
const cache = {};
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

function getCached(key) {
  const item = cache[key];
  if (!item) return null;
  if (Date.now() - item.timestamp > CACHE_DURATION) {
    delete cache[key];
    return null;
  }
  return item.data;
}

function setCache(key, data) {
  cache[key] = { data, timestamp: Date.now() };
}

// Helper to call API-Football
async function callAPI(endpoint, params = {}) {
  const cacheKey = endpoint + JSON.stringify(params);
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const url = new URL(API_BASE + endpoint);
  Object.keys(params).forEach(k => url.searchParams.append(k, params[k]));

  const response = await fetch(url, {
    headers: {
      'x-rapidapi-key': API_KEY,
      'x-rapidapi-host': API_HOST,
    },
  });

  if (!response.ok) throw new Error(`API error: ${response.status}`);
  const data = await response.json();
  setCache(cacheKey, data);
  return data;
}

// ════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'MatchMind Backend Running ✅',
    apiKeyConfigured: !!API_KEY,
    endpoints: [
      'GET /fixtures?league=39&season=2025',
      'GET /injuries?team=42',
      'GET /lineups?fixture=12345',
      'GET /h2h?team1=42&team2=33',
      'GET /standings?league=39&season=2025',
      'GET /team-stats?team=42&league=39&season=2025',
      'GET /odds?fixture=12345',
    ],
  });
});

// Get fixtures for a league
app.get('/fixtures', async (req, res) => {
  try {
    const { league, season = '2025', date, team, last, next, id } = req.query;
    const params = {};
    if (league) params.league = league;
    if (season) params.season = season;
    if (date) params.date = date;
    if (team) params.team = team;
    if (last) params.last = last;
    if (next) params.next = next;
    if (id) params.id = id;

    const data = await callAPI('/fixtures', params);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
// TEAM STRENGTH ANALYZER (DATA-DRIVEN, REPLACES HARDCODED TIERS)
// Analyzes last 3 seasons of finished matches to calculate real
// team strength based on actual win rates and goal differentials.
// Cached for 7 days to minimize API requests.
// ════════════════════════════════════════════════════════════════

const TEAM_STRENGTH_CACHE = {};
const STRENGTH_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

// Calculate team strength score (0-100) from historical results
function calculateStrength(team) {
  if (!team || team.games === 0) return 60; // Default for new teams
  
  // Base score from win rate (0-50 points)
  const winRate = team.wins / team.games;
  const winRateScore = winRate * 50;
  
  // Goal differential factor (0-30 points)
  const gdPerGame = (team.goalsFor - team.goalsAgainst) / team.games;
  const gdScore = Math.max(0, Math.min(30, 15 + gdPerGame * 8));
  
  // Recent form bonus (0-20 points) - last 10 matches weighted heavier
  const recentWinRate = team.recentGames > 0 ? team.recentWins / team.recentGames : winRate;
  const formScore = recentWinRate * 20;
  
  const total = Math.round(winRateScore + gdScore + formScore);
  return Math.max(40, Math.min(95, total)); // Clamp between 40-95
}

// Process a season's fixtures and aggregate team stats
function processSeasonFixtures(fixtures, teamStats, isRecent = false) {
  if (!fixtures || !Array.isArray(fixtures)) return;
  
  for (const f of fixtures) {
    if (!f.fixture || f.fixture.status?.short !== 'FT') continue; // Only finished matches
    
    const homeId = f.teams?.home?.id;
    const awayId = f.teams?.away?.id;
    const homeGoals = f.goals?.home;
    const awayGoals = f.goals?.away;
    
    if (!homeId || !awayId || homeGoals === null || awayGoals === null) continue;
    
    // Initialize team records
    if (!teamStats[homeId]) teamStats[homeId] = { id: homeId, name: f.teams.home.name, games: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, recentGames: 0, recentWins: 0 };
    if (!teamStats[awayId]) teamStats[awayId] = { id: awayId, name: f.teams.away.name, games: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, recentGames: 0, recentWins: 0 };
    
    const home = teamStats[homeId];
    const away = teamStats[awayId];
    
    home.games++; away.games++;
    home.goalsFor += homeGoals; home.goalsAgainst += awayGoals;
    away.goalsFor += awayGoals; away.goalsAgainst += homeGoals;
    
    if (homeGoals > awayGoals) {
      home.wins++; away.losses++;
      if (isRecent) { home.recentGames++; home.recentWins++; away.recentGames++; }
    } else if (homeGoals < awayGoals) {
      away.wins++; home.losses++;
      if (isRecent) { away.recentGames++; away.recentWins++; home.recentGames++; }
    } else {
      home.draws++; away.draws++;
      if (isRecent) { home.recentGames++; away.recentGames++; }
    }
  }
}

// Get team strengths for a league using last 3 seasons
app.get('/team-strengths', async (req, res) => {
  try {
    const { league } = req.query;
    if (!league) return res.status(400).json({ error: 'league required' });
    
    const cacheKey = 'strengths_' + league;
    const cached = TEAM_STRENGTH_CACHE[cacheKey];
    if (cached && (Date.now() - cached.timestamp) < STRENGTH_CACHE_DURATION) {
      return res.json({ cached: true, ageHours: Math.round((Date.now() - cached.timestamp) / 3600000), ...cached.data });
    }
    
    const teamStats = {};
    const seasons = ['2025', '2024', '2023']; // Last 3 seasons
    let totalFixtures = 0;
    
    // Pull each season - current season counts as "recent" for form weighting
    for (let i = 0; i < seasons.length; i++) {
      const season = seasons[i];
      const isRecent = (i === 0); // Current season = recent form
      try {
        const data = await callAPI('/fixtures', { league, season });
        if (data && data.response) {
          processSeasonFixtures(data.response, teamStats, isRecent);
          totalFixtures += data.response.length;
        }
      } catch (e) {
        console.log(`Season ${season} skipped: ${e.message}`);
      }
    }
    
    // Calculate strengths
    const strengths = {};
    Object.values(teamStats).forEach(team => {
      strengths[team.name] = {
        id: team.id,
        strength: calculateStrength(team),
        games: team.games,
        wins: team.wins,
        winRate: team.games > 0 ? Math.round((team.wins / team.games) * 100) : 0,
        gd: team.goalsFor - team.goalsAgainst,
        recentWinRate: team.recentGames > 0 ? Math.round((team.recentWins / team.recentGames) * 100) : 0
      };
    });
    
    const result = {
      league,
      seasonsAnalyzed: seasons,
      totalFixtures,
      teamCount: Object.keys(strengths).length,
      strengths,
      generatedAt: new Date().toISOString()
    };
    
    TEAM_STRENGTH_CACHE[cacheKey] = { data: result, timestamp: Date.now() };
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get all leagues team strengths in one call (for bulk frontend loading)
app.get('/all-strengths', async (req, res) => {
  try {
    const leagueIds = ['39', '140', '78', '135', '61', '253', '2', '3', '1', '88', '94', '40', '45']; // EPL, La Liga, Bundesliga, Serie A, Ligue 1, MLS, UCL, Europa, WC, Eredivisie, Liga Portugal, Champ, FA Cup
    const allStrengths = {};
    
    for (const leagueId of leagueIds) {
      const cacheKey = 'strengths_' + leagueId;
      const cached = TEAM_STRENGTH_CACHE[cacheKey];
      if (cached && (Date.now() - cached.timestamp) < STRENGTH_CACHE_DURATION) {
        allStrengths[leagueId] = cached.data.strengths;
      }
    }
    
    res.json({ leagues: allStrengths, cached: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
// END TEAM STRENGTH ANALYZER
// ════════════════════════════════════════════════════════════════

// Get injuries for a team
app.get('/injuries', async (req, res) => {
  try {
    const { team, league, season = '2025' } = req.query;
    const params = { season };
    if (team) params.team = team;
    if (league) params.league = league;

    const data = await callAPI('/injuries', params);
    
    // Deduplicate injuries by player name + injury type
    // API-Football returns duplicates (one entry per fixture the player was injured in)
    if (data && data.response && Array.isArray(data.response)) {
      const seen = new Set();
      const deduped = [];
      // Sort by fixture date DESC so we keep the most recent injury report
      const sorted = [...data.response].sort((a, b) => {
        const aDate = a.fixture && a.fixture.date ? new Date(a.fixture.date).getTime() : 0;
        const bDate = b.fixture && b.fixture.date ? new Date(b.fixture.date).getTime() : 0;
        return bDate - aDate;
      });
      for (const item of sorted) {
        if (!item.player || !item.player.name) continue;
        // Dedup key: player name + injury type (so same player with diff injuries kept)
        const key = (item.player.name || '').toLowerCase().trim() + '|' + (item.player.type || '').toLowerCase().trim();
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(item);
      }
      data.response = deduped;
      data.results = deduped.length;
    }
    
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get lineups for a fixture
app.get('/lineups', async (req, res) => {
  try {
    const { fixture } = req.query;
    if (!fixture) return res.status(400).json({ error: 'fixture id required' });

    const data = await callAPI('/fixtures/lineups', { fixture });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 🎯 KEY PLAYERS / TOP PLAYERS endpoint (frontend calls this as /top-players)
// Returns top scorers + top assisters per league as proxy for "star players"
// Cached for 24 hours since this changes slowly
const KEY_PLAYERS_CACHE = {};
const KEY_PLAYERS_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

app.get('/top-players', async (req, res) => {
  try {
    const { league, season = '2025' } = req.query;
    if (!league) return res.status(400).json({ error: 'league required' });
    
    const cacheKey = `topplayers_${league}_${season}`;
    const cached = KEY_PLAYERS_CACHE[cacheKey];
    if (cached && (Date.now() - cached.timestamp) < KEY_PLAYERS_CACHE_DURATION) {
      return res.json({ cached: true, ...cached.data });
    }
    
    // Fetch top scorers (top ~20)
    const scorersData = await callAPI('/players/topscorers', { league, season });
    // Fetch top assisters
    let assistersData = null;
    try {
      assistersData = await callAPI('/players/topassists', { league, season });
    } catch(e) { /* assist endpoint may not work for all leagues */ }
    
    // Build a "stars by team" map matching frontend contract
    const starsByTeam = {};
    
    const processPlayer = (item, role) => {
      if (!item || !item.player || !item.statistics) return;
      const playerName = item.player.name;
      if (!playerName) return;
      const stat = item.statistics[0] || {};
      const teamId = stat.team?.id;
      const teamName = stat.team?.name;
      if (!teamId || !teamName) return;
      
      if (!starsByTeam[teamId]) {
        starsByTeam[teamId] = { teamName, players: [] };
      }
      // Avoid duplicates (player might be top scorer AND assister)
      if (!starsByTeam[teamId].players.find(p => p.name === playerName)) {
        starsByTeam[teamId].players.push({
          name: playerName,
          role: role,
          goals: stat.goals?.total || 0,
          assists: stat.goals?.assists || 0,
          appearances: stat.games?.appearences || 0,
        });
      }
    };
    
    if (scorersData?.response && Array.isArray(scorersData.response)) {
      // Take top 15 scorers
      scorersData.response.slice(0, 15).forEach(item => processPlayer(item, 'scorer'));
    }
    if (assistersData?.response && Array.isArray(assistersData.response)) {
      // Take top 10 assisters
      assistersData.response.slice(0, 10).forEach(item => processPlayer(item, 'assister'));
    }
    
    const result = {
      league,
      season,
      starsByTeam,
      totalTeamsCovered: Object.keys(starsByTeam).length,
      generatedAt: new Date().toISOString(),
    };
    
    KEY_PLAYERS_CACHE[cacheKey] = { data: result, timestamp: Date.now() };
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get head-to-head between two teams
app.get('/h2h', async (req, res) => {
  try {
    const { team1, team2, last = 10 } = req.query;
    if (!team1 || !team2) return res.status(400).json({ error: 'team1 and team2 required' });

    const data = await callAPI('/fixtures/headtohead', {
      h2h: `${team1}-${team2}`,
      last,
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get standings
app.get('/standings', async (req, res) => {
  try {
    const { league, season = '2025' } = req.query;
    if (!league) return res.status(400).json({ error: 'league required' });

    const data = await callAPI('/standings', { league, season });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get team statistics
// 🆕 Team season statistics — parsed/cleaned for Poisson model use.
// Returns goals scored/conceded per match (overall, home, away), clean sheets, etc.
// 30-min cache via callAPI is sufficient.
app.get('/team-stats', async (req, res) => {
  try {
    const { team, league, season = '2025' } = req.query;
    if (!team || !league) return res.status(400).json({ error: 'team and league required' });

    const data = await callAPI('/teams/statistics', { team, league, season });
    const r = data.response;
    if (!r) return res.json({ error: 'no stats available', team, league });

    // Parse into a flat, easy-to-consume shape
    const matchesPlayed = (r.fixtures?.played?.total) || 0;
    const matchesHome = (r.fixtures?.played?.home) || 0;
    const matchesAway = (r.fixtures?.played?.away) || 0;

    const parsed = {
      teamId: parseInt(team),
      teamName: r.team?.name || '',
      leagueId: parseInt(league),
      season: parseInt(season),
      matchesPlayed,
      matchesHome,
      matchesAway,
      // Goals SCORED per match
      goalsForAvg: {
        total: parseFloat(r.goals?.for?.average?.total) || 0,
        home: parseFloat(r.goals?.for?.average?.home) || 0,
        away: parseFloat(r.goals?.for?.average?.away) || 0
      },
      goalsForTotal: {
        total: r.goals?.for?.total?.total || 0,
        home: r.goals?.for?.total?.home || 0,
        away: r.goals?.for?.total?.away || 0
      },
      // Goals CONCEDED per match
      goalsAgainstAvg: {
        total: parseFloat(r.goals?.against?.average?.total) || 0,
        home: parseFloat(r.goals?.against?.average?.home) || 0,
        away: parseFloat(r.goals?.against?.average?.away) || 0
      },
      goalsAgainstTotal: {
        total: r.goals?.against?.total?.total || 0,
        home: r.goals?.against?.total?.home || 0,
        away: r.goals?.against?.total?.away || 0
      },
      // Clean sheets / failed to score (rates)
      cleanSheets: {
        total: r.clean_sheet?.total || 0,
        home: r.clean_sheet?.home || 0,
        away: r.clean_sheet?.away || 0
      },
      failedToScore: {
        total: r.failed_to_score?.total || 0,
        home: r.failed_to_score?.home || 0,
        away: r.failed_to_score?.away || 0
      },
      // Win/draw/loss record
      wins: r.fixtures?.wins?.total || 0,
      draws: r.fixtures?.draws?.total || 0,
      losses: r.fixtures?.loses?.total || 0,
      // Form string from API (e.g. "WWDLW") for sanity comparison
      form: r.form || ''
    };

    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 🆕 ODDS endpoint — fetches pre-match odds for a fixture across multiple bookmakers,
// computes the MEDIAN implied probability for home/draw/away.
// API-Football returns dozens of bookmakers; we median to smooth out outliers.
//
// We compute probability by INVERTING decimal odds (1/odds), then normalizing so
// home+draw+away = 100% (this removes the bookmaker's vig/margin).
//
// Output is plain probability percentages — no betting language for App Store safety.
app.get('/odds', async (req, res) => {
  try {
    const { fixture } = req.query;
    if (!fixture) return res.status(400).json({ error: 'fixture id required' });

    const data = await callAPI('/odds', { fixture });
    const bookmakers = data.response?.[0]?.bookmakers || [];

    if (bookmakers.length === 0) {
      return res.json({
        fixtureId: parseInt(fixture),
        available: false,
        reason: 'no odds posted for this fixture'
      });
    }

    // Each bookmaker has a "bets" array; find the "Match Winner" (1X2) market
    const homeOdds = [];
    const drawOdds = [];
    const awayOdds = [];

    for (const bk of bookmakers) {
      const winnerBet = (bk.bets || []).find(b =>
        b.name === 'Match Winner' || b.id === 1
      );
      if (!winnerBet || !winnerBet.values) continue;

      const homeVal = winnerBet.values.find(v => v.value === 'Home' || v.value === '1');
      const drawVal = winnerBet.values.find(v => v.value === 'Draw' || v.value === 'X');
      const awayVal = winnerBet.values.find(v => v.value === 'Away' || v.value === '2');

      const h = homeVal && parseFloat(homeVal.odd);
      const d = drawVal && parseFloat(drawVal.odd);
      const a = awayVal && parseFloat(awayVal.odd);

      if (h > 1 && d > 1 && a > 1) {
        homeOdds.push(h);
        drawOdds.push(d);
        awayOdds.push(a);
      }
    }

    if (homeOdds.length === 0) {
      return res.json({
        fixtureId: parseInt(fixture),
        available: false,
        reason: 'no Match Winner market in bookmaker data'
      });
    }

    // Median helper — robust against outlier bookmakers
    const median = (arr) => {
      const s = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    };

    const medH = median(homeOdds);
    const medD = median(drawOdds);
    const medA = median(awayOdds);

    // Invert to implied probability (1/odds), then normalize to remove vig
    const rawH = 1 / medH;
    const rawD = 1 / medD;
    const rawA = 1 / medA;
    const sum = rawH + rawD + rawA;

    const homeProb = Math.round((rawH / sum) * 100);
    const drawProb = Math.round((rawD / sum) * 100);
    // Force home+draw+away = 100 exactly
    const awayProb = 100 - homeProb - drawProb;

    res.json({
      fixtureId: parseInt(fixture),
      available: true,
      bookmakerCount: homeOdds.length,
      homeProb,
      drawProb,
      awayProb,
      // Also return raw median decimal odds for advanced use
      medianOdds: {
        home: Math.round(medH * 100) / 100,
        draw: Math.round(medD * 100) / 100,
        away: Math.round(medA * 100) / 100
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Live fixtures
app.get('/live', async (req, res) => {
  try {
    const data = await callAPI('/fixtures', { live: 'all' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
// START SERVER
// ════════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║    MatchMind Backend Started ⚽       ║
║    Port: ${PORT}                          ║
║    API Key: ${API_KEY ? 'CONFIGURED ✅' : 'MISSING ❌'}              ║
╚══════════════════════════════════════╝
  `);
});
