-- Additive managed business information. Existing voice choices remain untouched.
ALTER TABLE businesses ADD COLUMN contact_email TEXT NOT NULL DEFAULT '';
ALTER TABLE businesses ADD COLUMN default_language TEXT NOT NULL DEFAULT 'en';
ALTER TABLE businesses ADD COLUMN shared_instructions TEXT NOT NULL DEFAULT '';
CREATE TABLE action_items (
 id TEXT PRIMARY KEY,
 business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
 source_key TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('booking_request','message','callback','todo')),
 content TEXT NOT NULL,
 caller_name TEXT NOT NULL DEFAULT '',
 caller_phone TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','handled')),
 urgent INTEGER NOT NULL DEFAULT 0 CHECK(urgent IN (0,1)),
 due_at TEXT,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 updated_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(call_id,source_key)
);
CREATE INDEX action_items_business_status ON action_items(business_id,status,created_at DESC,id);
CREATE TRIGGER action_items_owner_insert BEFORE INSERT ON action_items
WHEN NOT EXISTS(SELECT 1 FROM calls WHERE id=NEW.call_id AND business_id=NEW.business_id)
BEGIN SELECT RAISE(ABORT,'action call must belong to business'); END;
CREATE TRIGGER action_items_owner_update BEFORE UPDATE OF call_id,business_id ON action_items
WHEN NOT EXISTS(SELECT 1 FROM calls WHERE id=NEW.call_id AND business_id=NEW.business_id)
BEGIN SELECT RAISE(ABORT,'action call must belong to business'); END;
-- Historical intent is a request, never evidence of a confirmed appointment.
INSERT INTO action_items(id,business_id,call_id,source_key,kind,content,created_at)
SELECT 'action_booking_'||id,business_id,id,'booking','booking_request',COALESCE(NULLIF(summary,''),'Appointment requested'),started_at
FROM calls WHERE intent='booking' AND status!='active';
INSERT INTO action_items(id,business_id,call_id,source_key,kind,content,caller_name,caller_phone,created_at)
SELECT 'action_message_'||id,business_id,id,'message','message',json_extract(message_json,'$.message'),
 CASE WHEN json_type(message_json,'$.caller_name')='text' THEN json_extract(message_json,'$.caller_name') ELSE '' END,
 CASE WHEN json_type(message_json,'$.caller_phone')='text' THEN json_extract(message_json,'$.caller_phone') ELSE '' END,started_at
FROM calls WHERE status!='active' AND CASE WHEN json_valid(message_json) THEN json_type(message_json,'$.message')='text' AND trim(json_extract(message_json,'$.message'))!='' ELSE 0 END;

-- Project legacy summary writers once at the write boundary, never during inbox reads.
CREATE TRIGGER calls_action_projection_insert AFTER INSERT ON calls
WHEN NEW.status!='active'
BEGIN
INSERT OR IGNORE INTO action_items(id,business_id,call_id,source_key,kind,content,created_at)
SELECT 'action_booking_'||id,business_id,id,'booking','booking_request',COALESCE(NULLIF(summary,''),'Appointment requested'),started_at
FROM calls WHERE id=NEW.id AND intent='booking' AND status!='active';
INSERT OR IGNORE INTO action_items(id,business_id,call_id,source_key,kind,content,caller_name,caller_phone,created_at)
SELECT 'action_message_'||id,business_id,id,'message','message',json_extract(message_json,'$.message'),
 CASE WHEN json_type(message_json,'$.caller_name')='text' THEN json_extract(message_json,'$.caller_name') ELSE '' END,
 CASE WHEN json_type(message_json,'$.caller_phone')='text' THEN json_extract(message_json,'$.caller_phone') ELSE '' END,started_at
FROM calls WHERE id=NEW.id AND status!='active' AND CASE WHEN json_valid(message_json) THEN json_type(message_json,'$.message')='text' AND trim(json_extract(message_json,'$.message'))!='' ELSE 0 END;
END;
CREATE TRIGGER calls_action_projection_update AFTER UPDATE OF status,summary,intent,message_json ON calls
WHEN NEW.status!='active'
BEGIN
INSERT OR IGNORE INTO action_items(id,business_id,call_id,source_key,kind,content,created_at)
SELECT 'action_booking_'||id,business_id,id,'booking','booking_request',COALESCE(NULLIF(summary,''),'Appointment requested'),started_at
FROM calls WHERE id=NEW.id AND intent='booking' AND status!='active';
INSERT OR IGNORE INTO action_items(id,business_id,call_id,source_key,kind,content,caller_name,caller_phone,created_at)
SELECT 'action_message_'||id,business_id,id,'message','message',json_extract(message_json,'$.message'),
 CASE WHEN json_type(message_json,'$.caller_name')='text' THEN json_extract(message_json,'$.caller_name') ELSE '' END,
 CASE WHEN json_type(message_json,'$.caller_phone')='text' THEN json_extract(message_json,'$.caller_phone') ELSE '' END,started_at
FROM calls WHERE id=NEW.id AND status!='active' AND CASE WHEN json_valid(message_json) THEN json_type(message_json,'$.message')='text' AND trim(json_extract(message_json,'$.message'))!='' ELSE 0 END;
END;
