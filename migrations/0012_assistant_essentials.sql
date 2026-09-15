-- Repair installations that applied an earlier 0008 before Unicode essentials
-- were enforced. Preserve settings/public slugs; incomplete rows become private.
DROP TRIGGER IF EXISTS assistants_active_essentials_insert;
DROP TRIGGER IF EXISTS assistants_active_essentials_update;
UPDATE assistants SET state='draft', activated_at=NULL
 WHERE state='active' AND (
   trim(name, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))='' OR
   trim(persona, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))='' OR
   trim(language, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))=''
 );

CREATE TRIGGER assistants_active_essentials_insert
BEFORE INSERT ON assistants
WHEN NEW.state = 'active'
  AND (
    trim(NEW.name, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) = ''
    OR trim(NEW.persona, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) = ''
    OR trim(NEW.language, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) = ''
  )
BEGIN
  SELECT RAISE(ABORT, 'active assistant requires complete essentials');
END;
CREATE TRIGGER assistants_active_essentials_update
BEFORE UPDATE OF state, name, persona, language ON assistants
WHEN NEW.state = 'active'
  AND (
    trim(NEW.name, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) = ''
    OR trim(NEW.persona, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) = ''
    OR trim(NEW.language, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) = ''
  )
BEGIN
  SELECT RAISE(ABORT, 'active assistant requires complete essentials');
END;

