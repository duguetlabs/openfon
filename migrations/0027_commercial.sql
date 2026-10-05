-- Additive commercial ledger. No existing accounts, credentials or calls rewritten.
CREATE TABLE commercial_accounts (
 business_id TEXT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
 provider_mode TEXT NOT NULL CHECK(provider_mode IN ('test','live')),
 customer_id TEXT NOT NULL,
 subscription_id TEXT,
 plan_id TEXT CHECK(plan_id IN ('flex','small','growth')),
 cadence TEXT CHECK(cadence IN ('monthly','annual')),
 status TEXT NOT NULL DEFAULT 'pending',
 anchor_at TEXT,
 activated_at TEXT,
 retail_stopped_at TEXT,
 paid_through TEXT,
 period_end TEXT,
 updated_event_at TEXT,
 UNIQUE(provider_mode,customer_id),
 UNIQUE(provider_mode,subscription_id)
);
CREATE TABLE commercial_checkout_intents (
 id TEXT PRIMARY KEY,
 business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 provider_mode TEXT NOT NULL,
 plan_id TEXT NOT NULL,
 cadence TEXT NOT NULL,
 product_id TEXT NOT NULL,
 usage_product_id TEXT,
 meter_id TEXT NOT NULL,
 event_name TEXT NOT NULL,
 session_id TEXT,
 checkout_url TEXT,
 state TEXT NOT NULL DEFAULT 'pending',
 created_at TEXT NOT NULL
);
CREATE INDEX commercial_checkout_business ON commercial_checkout_intents(business_id,created_at);
CREATE UNIQUE INDEX commercial_one_open_checkout ON commercial_checkout_intents(business_id) WHERE state IN ('pending','ready');
CREATE TABLE commercial_webhook_events (
 provider_mode TEXT NOT NULL,
 event_id TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 event_type TEXT NOT NULL,
 received_at TEXT NOT NULL,
 processed_at TEXT,
 PRIMARY KEY(provider_mode,event_id)
);
CREATE TABLE commercial_payment_events (
 provider_mode TEXT NOT NULL,
 event_id TEXT NOT NULL,
 business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 event_type TEXT NOT NULL,
 payment_id TEXT,
 refund_id TEXT,
 amount_minor INTEGER,
 currency TEXT,
 occurred_at TEXT NOT NULL,
 PRIMARY KEY(provider_mode,event_id)
);
CREATE TABLE commercial_provider_observations (
 event_id TEXT PRIMARY KEY,
 business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 call_id TEXT REFERENCES calls(id) ON DELETE CASCADE,
 operation_id TEXT NOT NULL,
 source TEXT NOT NULL,
 usage_key TEXT NOT NULL,
 observed_at TEXT NOT NULL,
 is_final INTEGER NOT NULL CHECK(is_final IN(0,1)),
 payload_hash TEXT NOT NULL,
 metrics_json TEXT NOT NULL,
 model TEXT
);
CREATE INDEX commercial_provider_identity ON commercial_provider_observations(business_id,source,usage_key);
CREATE TABLE commercial_provider_metrics (
 business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 source TEXT NOT NULL,
 usage_key TEXT NOT NULL,
 metric TEXT NOT NULL,
 value INTEGER NOT NULL CHECK(value>=0),
 is_final INTEGER NOT NULL CHECK(is_final IN(0,1)),
 PRIMARY KEY(business_id,source,usage_key,metric)
);
CREATE TABLE commercial_call_usage (
 call_id TEXT PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE,
 business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 connected_at_ms INTEGER NOT NULL,
 ended_at_ms INTEGER NOT NULL,
 duration_ms INTEGER NOT NULL CHECK(duration_ms>=0),
 recorded_at TEXT NOT NULL,
 CHECK(ended_at_ms>=connected_at_ms)
);
CREATE INDEX commercial_call_usage_cycle ON commercial_call_usage(business_id,connected_at_ms,ended_at_ms);
CREATE TABLE commercial_qa_calls (
 call_id TEXT PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE,
 marked_by TEXT NOT NULL,
 marked_at TEXT NOT NULL
);
-- Corrections append provenance rather than rewriting previously exported usage.
CREATE TABLE commercial_usage_adjustments (
 id TEXT PRIMARY KEY,
 business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
 delta_ms INTEGER NOT NULL,
 cycle_start TEXT NOT NULL,
 cycle_end TEXT NOT NULL,
 reason TEXT NOT NULL,
 created_at TEXT NOT NULL,
 actor TEXT NOT NULL
);
CREATE TABLE commercial_usage_exports (
 id TEXT PRIMARY KEY,
 business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 cycle_start TEXT NOT NULL,
 cycle_end TEXT NOT NULL,
 usage_ms INTEGER NOT NULL,
 overage_minor INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending',
 provider_reference TEXT,
 computed_hash TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(business_id,cycle_start,cycle_end)
);
CREATE TABLE commercial_phone_quotes (
 id TEXT PRIMARY KEY,
 business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 phone_number TEXT NOT NULL,
 country TEXT NOT NULL,
 number_type TEXT NOT NULL,
 currency TEXT NOT NULL,
 setup_minor INTEGER NOT NULL,
 monthly_minor INTEGER NOT NULL,
 requirements_json TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 used_at TEXT
);
CREATE TABLE commercial_phone_orders (
 id TEXT PRIMARY KEY,
 business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 assistant_id TEXT NOT NULL,
 quote_id TEXT NOT NULL UNIQUE REFERENCES commercial_phone_quotes(id),
 provider_order_id TEXT UNIQUE,
 provider_number_id TEXT UNIQUE,
 connection_id TEXT,
 phone_number TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending',
 created_at TEXT NOT NULL,
 FOREIGN KEY(assistant_id,business_id) REFERENCES assistants(id,business_id)
);

CREATE TABLE commercial_subscription_components (
 business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('base','usage')),
 provider_mode TEXT NOT NULL,
 subscription_id TEXT NOT NULL,
 customer_id TEXT NOT NULL,
 product_id TEXT NOT NULL,
 status TEXT NOT NULL,
 period_start TEXT NOT NULL,
 period_end TEXT NOT NULL,
 updated_event_at TEXT NOT NULL,
 PRIMARY KEY(business_id,role),
 UNIQUE(provider_mode,subscription_id)
);
CREATE TABLE commercial_billing_periods (
 business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 subscription_id TEXT NOT NULL,
 period_start TEXT NOT NULL,
 period_end TEXT NOT NULL,
 plan_id TEXT NOT NULL,
 cadence TEXT NOT NULL,
 recorded_at TEXT NOT NULL,
 PRIMARY KEY(business_id,period_start),
 CHECK(period_end>period_start)
);
CREATE TABLE commercial_deletion_jobs (
 business_id TEXT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
 requested_at TEXT NOT NULL,
 completed_at TEXT
);

CREATE TABLE commercial_cancellations (
 business_id TEXT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
 term_end TEXT NOT NULL,
 state TEXT NOT NULL,
 requested_at TEXT NOT NULL
);

CREATE TABLE commercial_payment_updates (
 business_id TEXT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
 id TEXT NOT NULL,
 source_subscription_id TEXT NOT NULL,
 payment_id TEXT,
 payment_link TEXT,
 method_id TEXT,
 state TEXT NOT NULL,
 created_at TEXT NOT NULL
);
