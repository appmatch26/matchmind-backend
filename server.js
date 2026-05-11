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

// Get injuries for a team
app.get('/injuries', async (req, res) => {
  try {
    const { team, league, season = '2025' } = req.query;
    const params = { season };
    if (team) params.team = team;
    if (league) params.league = league;

    const data = await callAPI('/injuries', params);
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
app.get('/team-stats', async (req, res) => {
  try {
    const { team, league, season = '2025' } = req.query;
    if (!team || !league) return res.status(400).json({ error: 'team and league required' });

    const data = await callAPI('/teams/statistics', { team, league, season });
    res.json(data);
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
