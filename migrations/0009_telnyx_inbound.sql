-- Carrier features remain opt-in. Routes are provisioned by the instance operator,
-- never inferred from the business contact phone or tenant-submitted numbers.
ALTER TABLE calls ADD COLUMN reserved_at TEXT;
ALTER TABLE calls ADD COLUMN carrier_released_at TEXT;
CREATE INDEX idx_calls_carrier_reservations ON calls(business_id, environment, carrier_released_at)
  WHERE reserved_at IS NOT NULL;
CREATE UNIQUE INDEX idx_assistants_workspace_identity ON assistants(id, business_id);
CREATE TABLE telnyx_number_routes (
  connection_id TEXT NOT NULL,
  phone_number TEXT NOT NULL CHECK (phone_number GLOB '+[1-9]*' AND substr(phone_number, 2) NOT GLOB '*[^0-9]*' AND length(phone_number) BETWEEN 3 AND 16),
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  assistant_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  PRIMARY KEY (connection_id, phone_number),
  FOREIGN KEY (assistant_id, business_id) REFERENCES assistants(id, business_id) ON DELETE CASCADE
);
-- Do not join these carrier command capabilities into public call DTOs.
CREATE TABLE telnyx_call_links (
  call_id TEXT PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  call_leg_id TEXT NOT NULL,
  call_session_id TEXT NOT NULL,
  call_control_id TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  carrier_state TEXT NOT NULL DEFAULT 'reserved',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (connection_id, call_leg_id)
);
