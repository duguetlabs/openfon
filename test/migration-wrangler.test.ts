import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { unstable_splitSqlQuery } from 'wrangler';
import { SqliteD1, applyMigrations } from './sqlite-d1';

it('executes managed migrations as individual statements emitted by the deployed Wrangler splitter', () => {
  const db = new SqliteD1();
  const reference = new SqliteD1();
  try {
    applyMigrations(db);
    applyMigrations(reference);
    db.exec("INSERT INTO users(id,email,password_hash) VALUES('owner','migration@example.invalid','synthetic'); INSERT INTO businesses(id,user_id,slug,name) VALUES('business','owner','migration','Migration fixture'); INSERT INTO calls(id,business_id,status,intent,summary) VALUES('failed','business','failed','booking','Synthetic internal failure');");
    for (const name of ['0026_business_actions.sql', '0027_commercial.sql']) {
      const sql = readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8');
      reference.exec(sql);
      for (const statement of unstable_splitSqlQuery(sql)) {
        // Execute each emitted statement separately: a wrongly merged tail can
        // lose trigger definitions even when an executescript rehearsal passes.
        db.database.prepare(statement).run();
      }
    }
    const schema = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
    const definitions = (database: SqliteD1) => database.database.prepare(schema).all().map(row => ({
      ...row,
      // Wrangler strips full-line comments before sending statements to D1.
      sql: typeof row.sql === 'string' ? row.sql.split('\n').filter(line => line.trim() && !line.trim().startsWith('--')).join('\n') : row.sql,
    }));
    expect(definitions(db)).toEqual(definitions(reference));
    expect(db.database.prepare("SELECT content FROM action_items WHERE call_id='failed'").get()).toEqual({ content: 'Appointment requested. Review the source call for details.' });
    db.exec("INSERT INTO calls(id,business_id,status,intent,summary) VALUES('inserted','business','failed','booking','Synthetic insert failure'),('updated','business','active','booking','Synthetic update failure'); UPDATE calls SET status='failed' WHERE id='updated';");
    expect(db.database.prepare("SELECT COUNT(*) AS count FROM action_items WHERE content='Appointment requested. Review the source call for details.'").get()).toEqual({ count: 3 });
    expect(db.database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name LIKE 'calls_action_projection_%'").get()).toEqual({ count: 2 });
    expect(db.database.prepare("SELECT name FROM sqlite_master WHERE name='commercial_accounts'").get()).toEqual({ name: 'commercial_accounts' });
    expect(db.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { db.close(); reference.close(); }
});
