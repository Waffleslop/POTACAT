# POTACAT Telemetry Worker

Cloudflare Worker + KV for anonymous usage tracking.

## Deploy

```bash
cd worker
wrangler deploy
```

## How DAU/MAU Data Collection Works

### Client Side (`main.js`)
- Heartbeat pings every 30 minutes include `active: true/false`
- Active = user performed a meaningful action (tune, log QSO, respot, refresh, save settings, WSJT-X reply) within the last 30 minutes
- Launch ping always counts as active
- Close ping always sends (for session duration) with current active state

### Worker Side (`telemetry-worker.js`)
- On each active ping, writes `day:{YYYY-MM-DD}:{userId}` → `"1"` (90-day TTL)
- Same user pinging 10 times = 1 key (idempotent)
- DAU = count of `day:{date}:*` keys for a given date

### Cron (05:00 UTC daily)
- Counts yesterday's `day:` keys → DAU
- Writes `summary:{YYYY-MM-DD}` with `{ dau, versions, platforms, totalQsos, totalRespots }` (2-year TTL)
- On the 1st of each month, scans all `day:{YYYY-MM}-*` keys for unique users → MAU
- Writes `summary-month:{YYYY-MM}` with `{ mau, versions, platforms }` (2-year TTL)

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/ping` | POST | App telemetry (launch/heartbeat/close) |
| `/qso` | POST | QSO counter increment |
| `/respot` | POST | Re-spot counter increment |
| `/stats` | GET | Legacy JSON stats (all user records) |
| `/api/timeseries` | GET | DAU/MAU time series + current stats for dashboard |
| `/dashboard` | GET | Self-contained HTML dashboard with charts |

## KV Key Schema

| Key Pattern | TTL | Description |
|-------------|-----|-------------|
| `user:{id}` | 90 days | Per-user record (version, os, sessions, seconds) |
| `day:{YYYY-MM-DD}:{id}` | 90 days | Daily active presence marker |
| `summary:{YYYY-MM-DD}` | 730 days | Daily rollup (DAU, versions, platforms) |
| `summary-month:{YYYY-MM}` | 730 days | Monthly rollup (MAU, versions, platforms) |
| `global:qsos` | none | Total QSO count |
| `global:qsos:{source}` | none | Per-source QSO count |
| `global:respots` | none | Total re-spot count |
| `global:respots:{source}` | none | Per-source re-spot count |

## Timeline After Deploy

- **Immediately**: "Active Today" count works (live query of `day:{today}:*` keys)
- **Next day (05:00 UTC)**: First DAU data point appears in chart
- **1st of next month**: First MAU data point appears
- **90 days**: Full DAU chart fills out

## Testing

```bash
# Local dev
wrangler dev

# Test cron locally
wrangler dev --test-scheduled

# Manual ping test
curl -X POST http://localhost:8787/ping \
  -H 'Content-Type: application/json' \
  -d '{"id":"test-user-1","version":"0.9.9","os":"win32","sessionSeconds":0,"active":true}'

# Check dashboard
open http://localhost:8787/dashboard

# Check API
curl http://localhost:8787/api/timeseries
```

## Privacy

- No callsigns, IPs, or PII collected
- User IDs are random UUIDs generated client-side
- Day keys auto-expire after 90 days
- Summaries contain only aggregate counts
- `active` flag is boolean only — no activity details sent
