-- Abuse limits for the public widget API and the login form, plus the state the
-- stale-call sweeper needs. See the "abuse limits" section of src/index.ts.

-- Fixed-window request counters. One row per (limiter + subject + window); the
-- cron sweep deletes windows older than a day. D1 rather than the Cloudflare
-- Rate Limiting binding: no account-level resource for self-hosters to
-- provision, and it is the only store that can also hold the per-day counts.
CREATE TABLE rate_counters (
  bucket TEXT NOT NULL,           -- "<limiter>:<subject>", e.g. "start:203.0.113.7"
  window_start INTEGER NOT NULL,  -- unix seconds, floored to the window size
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX idx_rate_counters_window ON rate_counters(window_start);

-- Per-business call caps. Owners can raise or lower these via PUT /api/me/business/:id.
ALTER TABLE businesses ADD COLUMN max_concurrent_calls INTEGER NOT NULL DEFAULT 5;
ALTER TABLE businesses ADD COLUMN max_calls_per_day INTEGER NOT NULL DEFAULT 500;

-- Set when GET /ws/call/:callId hands the row to a Durable Object. NULL means
-- the row never got a WebSocket, which is what a burst of /call/start leaves
-- behind and is the difference between "abandoned" and "cut off mid-call".
ALTER TABLE calls ADD COLUMN connected_at TEXT;

CREATE INDEX idx_calls_sweep ON calls(status, started_at);

-- Every historical row starts with connected_at NULL, which the dashboard reads
-- as "never connected". Applied to real history that is a lie: a stranded call
-- with a saved transcript, and a message a customer left, would be presented as
-- a call that never happened. Any row with turns did reach a Durable Object, so
-- give it a connected_at before the reclassification below can label it.
--
-- Both values here are estimates and the migration should admit it. call_turns.ts
-- is when a turn was *written*, so MIN(ts) trails the real connect by one
-- greeting — a few seconds late, and it is the closest thing the schema records.
-- Where a turn somehow carries no timestamp we fall back to started_at, which is
-- early by at most the attach window (15 minutes). Either beats NULL, which would
-- assert something known to be false. Nothing downstream needs this to be exact:
-- it decides a dashboard label, and an age compared against a 60-minute cutoff.
UPDATE calls SET connected_at = COALESCE(
    (SELECT MIN(ts) FROM call_turns WHERE call_turns.call_id = calls.id),
    started_at
  )
 WHERE connected_at IS NULL
   AND EXISTS (SELECT 1 FROM call_turns WHERE call_turns.call_id = calls.id);

-- calls.status gains 'abandoned' (still 'active' past the stale window). Clear
-- out the rows that were already stranded before the sweeper existed, so the
-- dashboard stops showing them as "Call in progress…" forever. Rows backfilled
-- above now read as "Call interrupted" instead, which is what they were.
UPDATE calls SET status = 'abandoned', ended_at = datetime('now')
 WHERE status = 'active' AND started_at < datetime('now', '-60 minutes');
