# MatchMind Backend

Backend server that connects API-Football data to the MatchMind app.

## Setup

1. Get an API-Football API key from https://rapidapi.com/api-sports/api/api-football
2. Deploy to Railway: https://railway.app
3. Add `API_FOOTBALL_KEY` environment variable in Railway with your key
4. Generate a public domain in Railway → Settings → Networking
5. Use this URL in your MatchMind app

## Endpoints

- `GET /` — Health check
- `GET /fixtures?league=39&season=2025` — League fixtures
- `GET /injuries?team=42` — Team injuries
- `GET /lineups?fixture=12345` — Match lineups
- `GET /h2h?team1=42&team2=33` — Head to head
- `GET /standings?league=39&season=2025` — League standings
- `GET /team-stats?team=42&league=39&season=2025` — Team statistics
- `GET /live` — Live fixtures

## League IDs (API-Football)

- 39 = Premier League
- 140 = La Liga
- 78 = Bundesliga
- 135 = Serie A
- 61 = Ligue 1
- 2 = Champions League
- 3 = Europa League
- 848 = Conference League
- 88 = Eredivisie
- 94 = Liga Portugal
- 253 = MLS
- 40 = Championship
- 1 = World Cup
