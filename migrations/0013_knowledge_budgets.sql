-- Cumulative persistence limits apply to every writer, including compatibility paths.
-- Rejections occur before the counter write; each successful statement and its
-- counter update are atomic. Existing data is preserved and may be shrunk/deleted.
-- Daily counters share the existing scheduled retention cleanup.
CREATE INDEX idx_knowledge_items_business ON knowledge_items(business_id);

CREATE TRIGGER knowledge_insert_budget BEFORE INSERT ON knowledge_items BEGIN
  SELECT RAISE(ABORT,'OPENFON_KNOWLEDGE_STORAGE_LIMIT') WHERE (SELECT COUNT(*) FROM knowledge_items WHERE business_id=NEW.business_id)>=500
    OR COALESCE((SELECT SUM(length(CAST(title AS BLOB))+length(CAST(question AS BLOB))+length(CAST(answer AS BLOB))+length(CAST(content AS BLOB))+length(CAST(kind AS BLOB))) FROM knowledge_items WHERE business_id=NEW.business_id),0)+length(CAST(NEW.title AS BLOB))+length(CAST(NEW.question AS BLOB))+length(CAST(NEW.answer AS BLOB))+length(CAST(NEW.content AS BLOB))+length(CAST(NEW.kind AS BLOB))>2097152;
  SELECT RAISE(ABORT,'OPENFON_KNOWLEDGE_WRITE_LIMIT') WHERE COALESCE((SELECT count FROM rate_counters WHERE bucket='knowledge:'||NEW.business_id AND window_start=CAST(strftime('%s',datetime('now')) AS INTEGER)/86400*86400),0)>=500;
  INSERT INTO rate_counters(bucket,window_start,count)
    VALUES('knowledge:'||NEW.business_id,CAST(strftime('%s',datetime('now')) AS INTEGER)/86400*86400,1)
    ON CONFLICT(bucket,window_start) DO UPDATE SET count=count+1;
END;
CREATE TRIGGER knowledge_update_budget BEFORE UPDATE OF id,business_id,collection_id,kind,status,title,question,answer,content,activated_at,updated_at ON knowledge_items BEGIN
  SELECT RAISE(ABORT,'OPENFON_KNOWLEDGE_WORKSPACE_CHANGE') WHERE NEW.business_id<>OLD.business_id;
  SELECT RAISE(ABORT,'OPENFON_KNOWLEDGE_STORAGE_LIMIT') WHERE length(CAST(NEW.title AS BLOB))+length(CAST(NEW.question AS BLOB))+length(CAST(NEW.answer AS BLOB))+length(CAST(NEW.content AS BLOB))+length(CAST(NEW.kind AS BLOB))>length(CAST(OLD.title AS BLOB))+length(CAST(OLD.question AS BLOB))+length(CAST(OLD.answer AS BLOB))+length(CAST(OLD.content AS BLOB))+length(CAST(OLD.kind AS BLOB))
    AND (SELECT SUM(length(CAST(title AS BLOB))+length(CAST(question AS BLOB))+length(CAST(answer AS BLOB))+length(CAST(content AS BLOB))+length(CAST(kind AS BLOB))) FROM knowledge_items WHERE business_id=NEW.business_id)-(length(CAST(OLD.title AS BLOB))+length(CAST(OLD.question AS BLOB))+length(CAST(OLD.answer AS BLOB))+length(CAST(OLD.content AS BLOB))+length(CAST(OLD.kind AS BLOB)))+length(CAST(NEW.title AS BLOB))+length(CAST(NEW.question AS BLOB))+length(CAST(NEW.answer AS BLOB))+length(CAST(NEW.content AS BLOB))+length(CAST(NEW.kind AS BLOB))>2097152;
  SELECT RAISE(ABORT,'OPENFON_KNOWLEDGE_WRITE_LIMIT') WHERE COALESCE((SELECT count FROM rate_counters WHERE bucket='knowledge:'||NEW.business_id AND window_start=CAST(strftime('%s',datetime('now')) AS INTEGER)/86400*86400),0)>=500;
  INSERT INTO rate_counters(bucket,window_start,count)
    VALUES('knowledge:'||NEW.business_id,CAST(strftime('%s',datetime('now')) AS INTEGER)/86400*86400,1)
    ON CONFLICT(bucket,window_start) DO UPDATE SET count=count+1;
END;

-- Collection metadata is also knowledge persistence; it cannot bypass item budgets.
CREATE INDEX idx_knowledge_collections_business_budget ON knowledge_collections(business_id);
CREATE TRIGGER knowledge_collection_insert_budget BEFORE INSERT ON knowledge_collections BEGIN
  SELECT RAISE(ABORT,'OPENFON_KNOWLEDGE_COLLECTION_STORAGE_LIMIT') WHERE (SELECT COUNT(*) FROM knowledge_collections WHERE business_id=NEW.business_id)>=64
    OR COALESCE((SELECT SUM(length(CAST(name AS BLOB))+length(CAST(description AS BLOB))) FROM knowledge_collections WHERE business_id=NEW.business_id),0)
      +length(CAST(NEW.name AS BLOB))+length(CAST(NEW.description AS BLOB))>262144;
  SELECT RAISE(ABORT,'OPENFON_KNOWLEDGE_COLLECTION_WRITE_LIMIT') WHERE COALESCE((SELECT count FROM rate_counters WHERE bucket='knowledge-collections:'||NEW.business_id
    AND window_start=CAST(strftime('%s',datetime('now')) AS INTEGER)/86400*86400),0)>=100;
  INSERT INTO rate_counters(bucket,window_start,count)
    VALUES('knowledge-collections:'||NEW.business_id,CAST(strftime('%s',datetime('now')) AS INTEGER)/86400*86400,1)
    ON CONFLICT(bucket,window_start) DO UPDATE SET count=count+1;
END;
CREATE TRIGGER knowledge_collection_update_budget BEFORE UPDATE OF id,business_id,name,description ON knowledge_collections BEGIN
  SELECT RAISE(ABORT,'OPENFON_KNOWLEDGE_WORKSPACE_CHANGE') WHERE NEW.business_id<>OLD.business_id;
  SELECT RAISE(ABORT,'OPENFON_KNOWLEDGE_COLLECTION_STORAGE_LIMIT') WHERE length(CAST(NEW.name AS BLOB))+length(CAST(NEW.description AS BLOB))>length(CAST(OLD.name AS BLOB))+length(CAST(OLD.description AS BLOB))
    AND (SELECT SUM(length(CAST(name AS BLOB))+length(CAST(description AS BLOB))) FROM knowledge_collections WHERE business_id=NEW.business_id)
      -length(CAST(OLD.name AS BLOB))-length(CAST(OLD.description AS BLOB))
      +length(CAST(NEW.name AS BLOB))+length(CAST(NEW.description AS BLOB))>262144;
  SELECT RAISE(ABORT,'OPENFON_KNOWLEDGE_COLLECTION_WRITE_LIMIT') WHERE COALESCE((SELECT count FROM rate_counters WHERE bucket='knowledge-collections:'||NEW.business_id
    AND window_start=CAST(strftime('%s',datetime('now')) AS INTEGER)/86400*86400),0)>=100;
  INSERT INTO rate_counters(bucket,window_start,count)
    VALUES('knowledge-collections:'||NEW.business_id,CAST(strftime('%s',datetime('now')) AS INTEGER)/86400*86400,1)
    ON CONFLICT(bucket,window_start) DO UPDATE SET count=count+1;
END;
