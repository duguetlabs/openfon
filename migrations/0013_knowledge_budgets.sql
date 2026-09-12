-- Cumulative persistence limits apply to every writer, including compatibility paths.
-- Rejections occur before the counter write; each successful statement and its
-- counter update are atomic. Existing data is preserved and may be shrunk/deleted.
-- Daily counters share the existing scheduled retention cleanup.
CREATE INDEX idx_knowledge_items_business ON knowledge_items(business_id);

CREATE TRIGGER knowledge_insert_budget BEFORE INSERT ON knowledge_items BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM knowledge_items WHERE business_id=NEW.business_id)>=500
    OR COALESCE((SELECT SUM(length(CAST(title AS BLOB))+length(CAST(question AS BLOB))+length(CAST(answer AS BLOB))+length(CAST(content AS BLOB))+length(CAST(kind AS BLOB))) FROM knowledge_items WHERE business_id=NEW.business_id),0)+length(CAST(NEW.title AS BLOB))+length(CAST(NEW.question AS BLOB))+length(CAST(NEW.answer AS BLOB))+length(CAST(NEW.content AS BLOB))+length(CAST(NEW.kind AS BLOB))>2097152
    THEN RAISE(ABORT,'OPENFON_KNOWLEDGE_STORAGE_LIMIT') END;
  SELECT CASE WHEN COALESCE((SELECT count FROM rate_counters WHERE bucket='knowledge:'||NEW.business_id AND window_start=CAST(strftime('%s',datetime('now')) AS INTEGER)/86400*86400),0)>=500 THEN RAISE(ABORT,'OPENFON_KNOWLEDGE_WRITE_LIMIT') END;
  INSERT INTO rate_counters(bucket,window_start,count)
    VALUES('knowledge:'||NEW.business_id,CAST(strftime('%s',datetime('now')) AS INTEGER)/86400*86400,1)
    ON CONFLICT(bucket,window_start) DO UPDATE SET count=count+1;
END;
CREATE TRIGGER knowledge_update_budget BEFORE UPDATE OF id,business_id,collection_id,kind,status,title,question,answer,content,activated_at,updated_at ON knowledge_items BEGIN
  SELECT CASE WHEN NEW.business_id<>OLD.business_id THEN RAISE(ABORT,'OPENFON_KNOWLEDGE_WORKSPACE_CHANGE') END;
  SELECT CASE WHEN length(CAST(NEW.title AS BLOB))+length(CAST(NEW.question AS BLOB))+length(CAST(NEW.answer AS BLOB))+length(CAST(NEW.content AS BLOB))+length(CAST(NEW.kind AS BLOB))>length(CAST(OLD.title AS BLOB))+length(CAST(OLD.question AS BLOB))+length(CAST(OLD.answer AS BLOB))+length(CAST(OLD.content AS BLOB))+length(CAST(OLD.kind AS BLOB))
    AND (SELECT SUM(length(CAST(title AS BLOB))+length(CAST(question AS BLOB))+length(CAST(answer AS BLOB))+length(CAST(content AS BLOB))+length(CAST(kind AS BLOB))) FROM knowledge_items WHERE business_id=NEW.business_id)-(length(CAST(OLD.title AS BLOB))+length(CAST(OLD.question AS BLOB))+length(CAST(OLD.answer AS BLOB))+length(CAST(OLD.content AS BLOB))+length(CAST(OLD.kind AS BLOB)))+length(CAST(NEW.title AS BLOB))+length(CAST(NEW.question AS BLOB))+length(CAST(NEW.answer AS BLOB))+length(CAST(NEW.content AS BLOB))+length(CAST(NEW.kind AS BLOB))>2097152
    THEN RAISE(ABORT,'OPENFON_KNOWLEDGE_STORAGE_LIMIT') END;
  SELECT CASE WHEN COALESCE((SELECT count FROM rate_counters WHERE bucket='knowledge:'||NEW.business_id AND window_start=CAST(strftime('%s',datetime('now')) AS INTEGER)/86400*86400),0)>=500 THEN RAISE(ABORT,'OPENFON_KNOWLEDGE_WRITE_LIMIT') END;
  INSERT INTO rate_counters(bucket,window_start,count)
    VALUES('knowledge:'||NEW.business_id,CAST(strftime('%s',datetime('now')) AS INTEGER)/86400*86400,1)
    ON CONFLICT(bucket,window_start) DO UPDATE SET count=count+1;
END;
