-- Apply this entire file as one atomic migration. Refuse inconsistent imports;
-- never choose an authoritative tenant or delete/reassign historical rows.
-- The read-only precondition precedes all DDL and includes missing parents.
-- A migration failure requires transaction rollback by the migration runner.
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM knowledge_items AS item
  WHERE NOT EXISTS (
    SELECT 1 FROM knowledge_collections AS collection
    WHERE collection.id=item.collection_id AND collection.business_id=item.business_id
  )
) OR EXISTS (
  SELECT 1 FROM assistant_knowledge_collections AS attachment
  WHERE NOT EXISTS (
    SELECT 1 FROM assistants AS assistant
    JOIN knowledge_collections AS collection ON collection.business_id=assistant.business_id
    WHERE assistant.id=attachment.assistant_id AND collection.id=attachment.collection_id
  )
) THEN json('OPENFON_0021_KNOWLEDGE_TENANT_MISMATCH') ELSE NULL END;

-- Parent business ownership remains immutable under 0013/0015. These guards
-- validate child identities only; source-call/turn SET NULL updates stay outside
-- their UPDATE scope, including when the ordinary editing quota is exhausted.
-- RAISE(ABORT) undoes the failing statement (including its trigger writes), not
-- preceding statements in an explicit transaction. D1 batch/migration callers
-- must roll back the whole failed batch; no success-path DML changes changes().
CREATE TRIGGER knowledge_item_tenant_insert
BEFORE INSERT ON knowledge_items
WHEN NOT EXISTS (
  SELECT 1 FROM knowledge_collections
  WHERE id=NEW.collection_id AND business_id=NEW.business_id
)
BEGIN
  SELECT RAISE(ABORT, 'OPENFON_KNOWLEDGE_TENANT_MISMATCH');
END;

CREATE TRIGGER knowledge_item_tenant_update
BEFORE UPDATE OF business_id,collection_id ON knowledge_items
WHEN NOT EXISTS (
  SELECT 1 FROM knowledge_collections
  WHERE id=NEW.collection_id AND business_id=NEW.business_id
)
BEGIN
  SELECT RAISE(ABORT, 'OPENFON_KNOWLEDGE_TENANT_MISMATCH');
END;

CREATE TRIGGER knowledge_attachment_tenant_insert
BEFORE INSERT ON assistant_knowledge_collections
WHEN NOT EXISTS (
  SELECT 1 FROM assistants AS assistant
  JOIN knowledge_collections AS collection ON collection.business_id=assistant.business_id
  WHERE assistant.id=NEW.assistant_id AND collection.id=NEW.collection_id
)
BEGIN
  SELECT RAISE(ABORT, 'OPENFON_KNOWLEDGE_TENANT_MISMATCH');
END;

CREATE TRIGGER knowledge_attachment_tenant_update
BEFORE UPDATE OF assistant_id,collection_id ON assistant_knowledge_collections
WHEN NOT EXISTS (
  SELECT 1 FROM assistants AS assistant
  JOIN knowledge_collections AS collection ON collection.business_id=assistant.business_id
  WHERE assistant.id=NEW.assistant_id AND collection.id=NEW.collection_id
)
BEGIN
  SELECT RAISE(ABORT, 'OPENFON_KNOWLEDGE_TENANT_MISMATCH');
END;
