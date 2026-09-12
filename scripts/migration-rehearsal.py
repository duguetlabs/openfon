#!/usr/bin/env python3
"""Rehearse synthetic legacy SQLite upgrade, backup, rollback and restoration.

Usage: python3 migration-rehearsal.py [repository-path]
Only reads migrations from the repository. All database files are synthetic and
created in an automatically removed temporary directory. No provider credentials,
network requests, production databases or repository writes are involved.
This checks local SQLite restoration, not Cloudflare D1 Time Travel.
"""
import argparse
import json
import pathlib
import sqlite3
import tempfile


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('repository', nargs='?', default='.', type=pathlib.Path)
    parser.add_argument('--through', type=int, default=9, help='Explicit final migration number (default: 9)')
    args = parser.parse_args()
    root = args.repository.resolve()
    if args.through < 9:
        parser.error('--through must be at least 9')
    migrations = sorted((root / 'migrations').glob('*.sql'))
    # Intentionally scoped to the verified release, rather than silently applying
    # a future migration with different assumptions about seeded data.
    migrations = [path for path in migrations if path.name[:4].isdigit() and 1 <= int(path.name[:4]) <= args.through]
    require([int(path.name[:4]) for path in migrations] == list(range(1, args.through + 1)), 'Expected consecutive, unique migration numbers through requested target')

    with tempfile.TemporaryDirectory(prefix='openfon-upgrade-rehearsal-') as directory:
        temp = pathlib.Path(directory)
        db = sqlite3.connect(temp / 'legacy.sqlite')
        db.execute('PRAGMA foreign_keys=ON')
        for path in migrations[:6]:
            db.executescript(path.read_text())
        db.executescript('''
          INSERT INTO users(id,email,password_hash) VALUES('owner','owner@example.invalid','synthetic-only');
          INSERT INTO businesses(id,user_id,slug,name,services_json,faqs_json) VALUES
            ('main','owner','legacy-public-slug','Legacy Main','[{"name":"Repair","price":"€40"}]','[{"q":"Open?","a":"Weekdays"}]'),
            ('duplicate','owner','legacy-second-slug','Legacy Duplicate','[]','[]');
          INSERT INTO agent_settings(business_id,agent_name,persona,language,engine,realtime_model,llm_api_key) VALUES
            ('main','Maya','Calm','de','realtime','gpt-realtime-2','synthetic-only');
          INSERT INTO engine_profiles(id,business_id,name,engine,llm_api_key) VALUES('profile','main','Legacy profile','realtime','synthetic-only');
          INSERT INTO calls(id,business_id,status,started_at,ended_at,duration_s,summary,intent,message_json) VALUES
            ('history','main','completed','2025-01-01 10:00:00','2025-01-01 10:02:00',120,'Preserved conversation','message','{"caller_name":"Synthetic caller"}'),
            ('stranded','main','active','2025-01-01 10:00:00',NULL,NULL,NULL,NULL,NULL),
            ('unused','duplicate','active','2025-01-01 10:00:00',NULL,NULL,NULL,NULL,NULL);
          INSERT INTO call_turns(call_id,role,text,ts) VALUES
            ('history','caller','Preserved caller text','2025-01-01 10:00:02'),
            ('history','agent','Preserved agent text','2025-01-01 10:00:04'),
            ('stranded','caller','Real historical attempt','2025-01-01 10:00:03');
        ''')
        db.commit()
        old_columns = {
            table: [row[1] for row in db.execute(f'PRAGMA table_info({table})')]
            for table in ['businesses', 'agent_settings', 'engine_profiles', 'call_turns']
        }

        def preserved(connection):
            return {
                table: connection.execute(f'SELECT {",".join(columns)} FROM {table} ORDER BY 1').fetchall()
                for table, columns in old_columns.items()
            }

        original = preserved(db)
        history = db.execute("SELECT * FROM calls WHERE id='history'").fetchone()
        old_call_cols = [row[1] for row in db.execute('PRAGMA table_info(calls)')]
        with sqlite3.connect(temp / 'before-upgrade.sqlite') as backup:
            db.backup(backup)
        before_dump = '\n'.join(db.iterdump())
        for path in migrations[6:]:
            db.executescript(path.read_text())
        require(preserved(db) == original, 'Rehearsal check failed: preserved(db) == original')
        require(db.execute(f"SELECT {','.join(old_call_cols)} FROM calls WHERE id='history'").fetchone() == history, 'Rehearsal check failed: db.execute(f"SELECT {\',\'.join(old_call_cols)} FROM calls WHERE id=\'history\'").fetchone() == history')
        require(db.execute('SELECT public_slug FROM assistants ORDER BY public_slug').fetchall() == [('legacy-public-slug',), ('legacy-second-slug',)], "Rehearsal check failed: db.execute('SELECT public_slug FROM assistants ORDER BY public_slug').fetchall() == [('legacy-public-slug',), ('legacy-second-slug',)]")
        require(db.execute("SELECT connected_at FROM calls WHERE id='history'").fetchone()[0] == '2025-01-01 10:00:02', 'Rehearsal check failed: db.execute("SELECT connected_at FROM calls WHERE id=\'history\'").fetchone()[0] == \'2025-01-01 10:00:02\'')
        require(db.execute("SELECT status,connected_at IS NOT NULL FROM calls WHERE id='stranded'").fetchone() == ('abandoned', 1), 'Rehearsal check failed: db.execute("SELECT status,connected_at IS NOT NULL FROM calls WHERE id=\'stranded\'").fetchone() == (\'abandoned\', 1)')
        require(db.execute("SELECT status,connected_at FROM calls WHERE id='unused'").fetchone() == ('abandoned', None), 'Rehearsal check failed: db.execute("SELECT status,connected_at FROM calls WHERE id=\'unused\'").fetchone() == (\'abandoned\', None)')
        require(db.execute('SELECT COUNT(*) FROM engine_presets').fetchone()[0] == 1, "Rehearsal check failed: db.execute('SELECT COUNT(*) FROM engine_presets').fetchone()[0] == 1")
        require(db.execute('SELECT COUNT(*) FROM knowledge_items').fetchone()[0] == 2, "Rehearsal check failed: db.execute('SELECT COUNT(*) FROM knowledge_items').fetchone()[0] == 2")
        require(db.execute('SELECT COUNT(*) FROM telnyx_number_routes').fetchone()[0] == 0, "Rehearsal check failed: db.execute('SELECT COUNT(*) FROM telnyx_number_routes').fetchone()[0] == 0")
        require(db.execute('SELECT COUNT(*) FROM telnyx_call_links').fetchone()[0] == 0, "Rehearsal check failed: db.execute('SELECT COUNT(*) FROM telnyx_call_links').fetchone()[0] == 0")
        require(db.execute('SELECT COUNT(*) FROM calls WHERE reserved_at IS NOT NULL OR carrier_released_at IS NOT NULL').fetchone()[0] == 0, "Rehearsal check failed: db.execute('SELECT COUNT(*) FROM calls WHERE reserved_at IS NOT NULL OR carrier_released_at IS NOT NULL').fetchone()[0] == 0")
        require(db.execute('PRAGMA foreign_key_check').fetchall() == [], "Rehearsal check failed: db.execute('PRAGMA foreign_key_check').fetchall() == []")
        require(db.execute('PRAGMA integrity_check').fetchall() == [('ok',)], "Rehearsal check failed: db.execute('PRAGMA integrity_check').fetchall() == [('ok',)]")
        db.commit()
        upgraded_dump = '\n'.join(db.iterdump())
        with sqlite3.connect(temp / 'after-upgrade.sqlite') as backup:
            db.backup(backup)
        # Simulate a destructive operator mistake ONLY in this synthetic database.
        db.execute("DELETE FROM businesses WHERE id='main'")
        db.commit()
        require(db.execute('SELECT COUNT(*) FROM calls').fetchone()[0] == 1, "Rehearsal check failed: db.execute('SELECT COUNT(*) FROM calls').fetchone()[0] == 1")
        with sqlite3.connect(temp / 'after-upgrade.sqlite') as backup:
            backup.backup(db)
        require('\n'.join(db.iterdump()) == upgraded_dump, "Rehearsal check failed: '\\n'.join(db.iterdump()) == upgraded_dump")
        sql_restore = sqlite3.connect(temp / 'sql-restore.sqlite')
        sql_restore.executescript(upgraded_dump)
        sql_restore.execute('PRAGMA foreign_keys=ON')
        require('\n'.join(sql_restore.iterdump()) == upgraded_dump, "Rehearsal check failed: '\\n'.join(sql_restore.iterdump()) == upgraded_dump")
        require(sql_restore.execute('PRAGMA foreign_key_check').fetchall() == [], "Rehearsal check failed: sql_restore.execute('PRAGMA foreign_key_check').fetchall() == []")
        require(sql_restore.execute('PRAGMA integrity_check').fetchall() == [('ok',)], "Rehearsal check failed: sql_restore.execute('PRAGMA integrity_check').fetchall() == [('ok',)]")
        sql_restore.close()
        # A pre-upgrade rollback recovers the exact legacy schema and all data.
        with sqlite3.connect(temp / 'before-upgrade.sqlite') as backup:
            backup.backup(db)
        require('\n'.join(db.iterdump()) == before_dump, "Rehearsal check failed: '\\n'.join(db.iterdump()) == before_dump")
        require(preserved(db) == original, 'Rehearsal check failed: preserved(db) == original')
        for path in migrations[6:]:
            db.executescript(path.read_text())
        require(preserved(db) == original, 'Rehearsal check failed: preserved(db) == original')
        require(db.execute('PRAGMA foreign_key_check').fetchall() == [], "Rehearsal check failed: db.execute('PRAGMA foreign_key_check').fetchall() == []")
        db.close()

    print(json.dumps({
        'result': 'PASS', 'source_base': 'migration 0006', 'upgraded_through': f'{args.through:04d}',
        'workspaces': 2, 'historical_calls': 3, 'transcript_turns': 3,
        'checks': [
            'legacy columns unchanged', 'both public slugs preserved',
            'completed history preserved', 'connected history backfilled',
            'only stale active calls reclassified', 'presets and knowledge copied',
            'carrier tables empty and reservations null', 'SQLite integrity and FK checks',
            'binary snapshot restore after synthetic deletion', 'SQL dump restore exact',
            'pre-upgrade rollback exact', 're-upgrade succeeds',
        ],
        'temporary_files_removed': True,
    }))


if __name__ == '__main__':
    main()
