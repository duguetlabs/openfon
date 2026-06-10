-- OpenFon initial schema
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE businesses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'Europe/Vienna',
  hours_json TEXT NOT NULL DEFAULT '[]',     -- [{day, open, close, closed}]
  services_json TEXT NOT NULL DEFAULT '[]',  -- [{name, price, duration, notes}]
  faqs_json TEXT NOT NULL DEFAULT '[]',      -- [{q, a}]
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE agent_settings (
  business_id TEXT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL DEFAULT 'Alex',
  greeting TEXT NOT NULL DEFAULT '',
  persona TEXT NOT NULL DEFAULT 'friendly and professional',
  language TEXT NOT NULL DEFAULT 'en',
  voice TEXT NOT NULL DEFAULT '',            -- empty = instance default
  take_messages INTEGER NOT NULL DEFAULT 1,
  custom_instructions TEXT NOT NULL DEFAULT '',
  -- Per-business provider overrides; empty = instance defaults
  llm_base_url TEXT NOT NULL DEFAULT '',
  llm_api_key TEXT NOT NULL DEFAULT '',
  llm_model TEXT NOT NULL DEFAULT ''
);

CREATE TABLE calls (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'web',       -- web | twilio | acs
  caller_id TEXT NOT NULL DEFAULT 'anonymous',
  status TEXT NOT NULL DEFAULT 'active',     -- active | completed | failed
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  duration_s INTEGER,
  summary TEXT,
  intent TEXT,                               -- question | booking | message | other
  message_json TEXT                          -- {caller_name, caller_phone, message} when a message was taken
);
CREATE INDEX idx_calls_business ON calls(business_id, started_at DESC);

CREATE TABLE call_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                        -- caller | agent
  text TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_turns_call ON call_turns(call_id, id);
