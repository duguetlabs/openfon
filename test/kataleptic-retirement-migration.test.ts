import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { SqliteD1, applyMigrations } from './sqlite-d1';

// Kataleptic retired the realtime cascade, its Piper voices, whisper-large-v3-turbo
// and the open chat models. Selections made on an explicit api.kataleptic.com
// provider move to live defaults; inherited instance ones are left to runtime
// and to the deployment script.
const migration = readFileSync(new URL('../migrations/0024_retire_kataleptic_models.sql', import.meta.url), 'utf8');
const instanceFix = readFileSync(new URL('../scripts/retire-kataleptic-instance-defaults.sql', import.meta.url), 'utf8');
const KATALEPTIC = 'https://api.kataleptic.com/v1';
let db: SqliteD1, env: Env;
const sql = (s: string) => db.exec(s);
const rows = (s: string) => db.database.prepare(s).all() as Record<string, unknown>[];
const one = (s: string) => rows(s)[0];

beforeEach(async () => {
  db = new SqliteD1(); applyMigrations(db, 1, 23);
  env = { DB: db, DEFAULT_LLM_BASE_URL: KATALEPTIC, DEFAULT_LLM_API_KEY: '', DEFAULT_LLM_MODEL: 'llama-3.3-70b',
    DEFAULT_STT_BASE_URL: KATALEPTIC, DEFAULT_STT_API_KEY: '', DEFAULT_STT_MODEL: 'gpt-transcribe', DEFAULT_TTS_PROVIDER: 'browser',
    REALTIME_BASE_URL: 'wss://api.kataleptic.com/v1/realtime', REALTIME_MODEL: 'kataleptic-realtime-hd' } as unknown as Env;
  // inst: instance defaults. kat: explicit Kataleptic everywhere. own: custom providers.
  sql(`INSERT INTO users(id,email,password_hash) VALUES('u-inst','inst@example.invalid','x'),('u-kat','kat@example.invalid','x'),('u-own','own@example.invalid','x');
    INSERT INTO sessions(token,user_id,expires_at) VALUES('s-inst','u-inst','2099-01-01'),('s-kat','u-kat','2099-01-01'),('s-own','u-own','2099-01-01');
    INSERT INTO businesses(id,user_id,slug,name) VALUES('inst','u-inst','inst','Inst'),('kat','u-kat','kat','Kat'),('own','u-own','own','Own');
    INSERT INTO provider_settings(business_id) VALUES('inst');
    INSERT INTO provider_settings(business_id,realtime_provider,realtime_base_url,realtime_api_key,llm_base_url,llm_api_key,llm_model,stt_provider,stt_base_url,stt_api_key,stt_model)
      VALUES('kat','kataleptic','wss://api.kataleptic.com/v1/realtime','k','${KATALEPTIC}','k','qwen3-8b','custom','${KATALEPTIC}','k','whisper-large-v3-turbo'),
            ('own','custom','wss://rt.example/v1/realtime','k','https://llm.example/v1','k','qwen3-8b','custom','https://stt.example/v1','k','whisper-large-v3-turbo');
    INSERT INTO agent_settings(business_id,engine,realtime_model,realtime_voice,llm_model,llm_base_url,llm_api_key) VALUES
      ('inst','realtime','kataleptic-realtime','de_DE-thorsten-medium','mistral-nemo-12b','',''),
      ('kat','realtime','llama-3.3-70b','en_US-lessac-medium','gemma3-27b','${KATALEPTIC}','k'),
      ('own','realtime','kataleptic-realtime','de_DE-thorsten-medium','qwen3-8b','https://llm.example/v1','k');`);
  // The new worker creates each Studio assistant and its compatibility snapshot from the legacy row.
  for (const token of ['s-inst', 's-kat', 's-own']) {
    const response = await worker.fetch(new Request('https://openfon.test/api/me/bootstrap', { headers: { Cookie: `ofs=${token}` } }),
      env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
    expect(response.status).toBe(200);
  }
  sql(`INSERT INTO engine_presets(id,business_id,name,engine,realtime_model,realtime_voice,llm_model) VALUES
      ('p-inst','inst','Cascade Deutsch','realtime','kataleptic-realtime','de_DE-thorsten-medium','glm4-9b'),
      ('p-live','inst','HD','realtime','kataleptic-realtime-hd','de-DE-SeraphinaMultilingualNeural','llama-3.3-70b'),
      ('p-inst-chat','inst','Chat cascade','realtime','llama-3.3-70b','de_DE-thorsten-medium',''),
      ('p-own','own','Mine','realtime','kataleptic-realtime','de_DE-thorsten-medium','qwen3-8b');
    INSERT INTO engine_profiles(id,business_id,name,engine,realtime_model,realtime_voice,llm_model) VALUES
      ('f-kat','kat','Cascade','realtime','llama-3.3-70b','en_US-lessac-medium','qwen2.5-coder-7b'),
      ('f-native','kat','Native','realtime','gpt-realtime-2.1-mini','marin','gpt-5.4-mini');
    INSERT INTO summary_settings(business_id,mode,base_url,api_key,model,revision) VALUES
      ('inst','workspace','','','glm4-9b','r-inst'),('kat','custom','${KATALEPTIC}','k','gemma3-27b','r-kat'),('own','custom','https://llm.example/v1','k','qwen3-8b','r-own');`);
});
afterEach(() => db.close());

it('moves explicit Kataleptic selections off every retired id and leaves inherited and custom ones alone', () => {
  const before = rows("SELECT * FROM assistants WHERE business_id='own' ORDER BY id");
  expect(one("SELECT realtime_model FROM assistants WHERE business_id='kat'")).toEqual({ realtime_model: 'llama-3.3-70b' });
  sql(migration);
  for (const table of ['agent_settings', 'assistants']) {
    expect(rows(`SELECT business_id,realtime_model,realtime_voice,llm_model FROM ${table} ORDER BY business_id`)).toEqual([
      // Where an inherited instance endpoint points is not known to SQL.
      { business_id: 'inst', realtime_model: 'kataleptic-realtime', realtime_voice: 'de_DE-thorsten-medium', llm_model: 'mistral-nemo-12b' },
      { business_id: 'kat', realtime_model: '', realtime_voice: '', llm_model: '' },
      { business_id: 'own', realtime_model: 'kataleptic-realtime', realtime_voice: 'de_DE-thorsten-medium', llm_model: 'qwen3-8b' },
    ]);
  }
  expect(rows("SELECT * FROM assistants WHERE business_id='own' ORDER BY id")).toEqual(before);
  expect(rows('SELECT id,realtime_model,realtime_voice,llm_model FROM engine_presets ORDER BY id')).toEqual([
    { id: 'p-inst', realtime_model: 'kataleptic-realtime', realtime_voice: 'de_DE-thorsten-medium', llm_model: 'glm4-9b' },
    { id: 'p-inst-chat', realtime_model: 'llama-3.3-70b', realtime_voice: 'de_DE-thorsten-medium', llm_model: '' },
    { id: 'p-live', realtime_model: 'kataleptic-realtime-hd', realtime_voice: 'de-DE-SeraphinaMultilingualNeural', llm_model: 'llama-3.3-70b' },
    { id: 'p-own', realtime_model: 'kataleptic-realtime', realtime_voice: 'de_DE-thorsten-medium', llm_model: 'qwen3-8b' },
  ]);
  expect(rows('SELECT id,realtime_model,realtime_voice,llm_model FROM engine_profiles ORDER BY id')).toEqual([
    { id: 'f-kat', realtime_model: '', realtime_voice: '', llm_model: '' },
    { id: 'f-native', realtime_model: 'gpt-realtime-2.1-mini', realtime_voice: 'marin', llm_model: 'gpt-5.4-mini' },
  ]);
  expect(rows('SELECT business_id,llm_model,stt_model FROM provider_settings ORDER BY business_id')).toEqual([
    { business_id: 'inst', llm_model: '', stt_model: '' },
    // An explicit Kataleptic endpoint keeps a concrete, live model.
    { business_id: 'kat', llm_model: 'llama-3.3-70b', stt_model: 'gpt-transcribe' },
    { business_id: 'own', llm_model: 'qwen3-8b', stt_model: 'whisper-large-v3-turbo' },
  ]);
  const summaries = rows('SELECT business_id,model,revision FROM summary_settings ORDER BY business_id');
  expect(summaries.map(({ business_id, model }) => ({ business_id, model }))).toEqual([
    { business_id: 'inst', model: 'glm4-9b' }, { business_id: 'kat', model: 'llama-3.3-70b' }, { business_id: 'own', model: 'qwen3-8b' },
  ]);
  expect(summaries.map(s => s.revision === `r-${s.business_id}`)).toEqual([true, false, true]);
});

it('keeps each legacy row equal to its compatibility snapshot, so no repair overwrites Studio edits', () => {
  // A legacy row that no longer matches its snapshot reads as an old-worker edit.
  const inSync = () => rows(`SELECT sync.business_id, sync.agent_snapshot = json_object(
      'agent_name', legacy.agent_name, 'greeting', legacy.greeting, 'persona', legacy.persona, 'language', legacy.language,
      'voice', legacy.voice, 'take_messages', legacy.take_messages, 'custom_instructions', legacy.custom_instructions,
      'engine', legacy.engine, 'realtime_model', legacy.realtime_model, 'realtime_voice', legacy.realtime_voice,
      'llm_model', legacy.llm_model) AS same
    FROM compatibility_sync_state sync JOIN agent_settings legacy USING (business_id) ORDER BY sync.business_id`);
  expect(inSync()).toEqual([{ business_id: 'inst', same: 1 }, { business_id: 'kat', same: 1 }, { business_id: 'own', same: 1 }]);
  sql(migration);
  expect(inSync()).toEqual([{ business_id: 'inst', same: 1 }, { business_id: 'kat', same: 1 }, { business_id: 'own', same: 1 }]);
});

it('is idempotent and leaves live selections untouched', () => {
  sql(`UPDATE agent_settings SET realtime_model='gpt-realtime-2', realtime_voice='marin', llm_model='llama-3.3-70b' WHERE business_id='inst';
    UPDATE assistants SET realtime_model='kataleptic-realtime-hd', realtime_voice='en-US-AvaMultilingualNeural' WHERE business_id='inst';`);
  sql(migration);
  const once = rows("SELECT name, sql FROM sqlite_master WHERE type='table'").map(({ name }) => rows(`SELECT * FROM "${name}" ORDER BY rowid`));
  expect(one("SELECT realtime_model,realtime_voice,llm_model FROM agent_settings WHERE business_id='inst'"))
    .toEqual({ realtime_model: 'gpt-realtime-2', realtime_voice: 'marin', llm_model: 'llama-3.3-70b' });
  expect(one("SELECT realtime_model,realtime_voice FROM assistants WHERE business_id='inst'"))
    .toEqual({ realtime_model: 'kataleptic-realtime-hd', realtime_voice: 'en-US-AvaMultilingualNeural' });
  sql(migration);
  const twice = rows("SELECT name, sql FROM sqlite_master WHERE type='table'").map(({ name }) => rows(`SELECT * FROM "${name}" ORDER BY rowid`));
  // summary revisions only move for rows that still hold a retired model
  expect(twice).toEqual(once);
});

it('clears exactly what runtime would remap, with the voice chosen for it', () => {
  sql(`UPDATE agent_settings SET realtime_model='gpt-4o-realtime-preview', realtime_voice='marin' WHERE business_id='kat';
    UPDATE assistants SET realtime_model='gpt-4o-realtime-preview', realtime_voice='marin' WHERE business_id='kat';
    UPDATE compatibility_sync_state SET agent_snapshot=json_replace(agent_snapshot,'$.realtime_model','gpt-4o-realtime-preview','$.realtime_voice','marin') WHERE business_id='kat';`);
  sql(migration);
  for (const table of ['agent_settings', 'assistants']) {
    expect(one(`SELECT realtime_model,realtime_voice FROM ${table} WHERE business_id='kat'`)).toEqual({ realtime_model: '', realtime_voice: '' });
  }
  expect(JSON.parse(String(one("SELECT agent_snapshot FROM compatibility_sync_state WHERE business_id='kat'").agent_snapshot)))
    .toMatchObject({ realtime_model: '', realtime_voice: '' });
});

it('leaves a self-hosted gateway speaking the Kataleptic protocol its own models', () => {
  sql("UPDATE provider_settings SET realtime_base_url='wss://gateway.example/v1/realtime' WHERE business_id='kat'");
  sql(migration);
  expect(one("SELECT realtime_model,realtime_voice FROM agent_settings WHERE business_id='kat'")).toEqual({ realtime_model: 'llama-3.3-70b', realtime_voice: 'en_US-lessac-medium' });
  expect(one("SELECT realtime_model,realtime_voice FROM engine_profiles WHERE id='f-kat'")).toEqual({ realtime_model: 'llama-3.3-70b', realtime_voice: 'en_US-lessac-medium' });
});

it('keeps a retired-looking model on a legacy row whose own LLM endpoint is custom', () => {
  // Legacy writers could leave agent_settings on its own endpoint; that model is not Kataleptic's.
  sql(`DROP TRIGGER legacy_provider_credentials_guard;
    UPDATE agent_settings SET llm_base_url='https://llm.example/v1', llm_api_key='k' WHERE business_id='kat';`);
  sql(migration);
  expect(one("SELECT llm_model FROM agent_settings WHERE business_id='kat'")).toEqual({ llm_model: 'gemma3-27b' });
  expect(one("SELECT llm_model FROM assistants WHERE business_id='kat'")).toEqual({ llm_model: 'gemma3-27b' });
  expect(JSON.parse(String(one("SELECT agent_snapshot FROM compatibility_sync_state WHERE business_id='kat'").agent_snapshot)))
    .toMatchObject({ llm_model: 'gemma3-27b' });
});

it('the instance-default fix clears inherited Kataleptic selections, in sync, and only those', () => {
  sql(migration);
  const own = ['assistants', 'agent_settings', 'engine_presets', 'summary_settings', 'provider_settings', 'compatibility_sync_state']
    .map(table => rows(`SELECT * FROM ${table} WHERE business_id='own' ORDER BY rowid`));
  sql(instanceFix);
  for (const table of ['agent_settings', 'assistants']) {
    expect(one(`SELECT realtime_model,realtime_voice,llm_model FROM ${table} WHERE business_id='inst'`)).toEqual({ realtime_model: '', realtime_voice: '', llm_model: '' });
  }
  expect(rows("SELECT id,realtime_model,realtime_voice,llm_model FROM engine_presets WHERE business_id='inst' ORDER BY id")).toEqual([
    { id: 'p-inst', realtime_model: '', realtime_voice: '', llm_model: '' },
    { id: 'p-inst-chat', realtime_model: '', realtime_voice: '', llm_model: '' },
    { id: 'p-live', realtime_model: 'kataleptic-realtime-hd', realtime_voice: 'de-DE-SeraphinaMultilingualNeural', llm_model: 'llama-3.3-70b' },
  ]);
  expect(one("SELECT model FROM summary_settings WHERE business_id='inst'")).toEqual({ model: '' });
  expect(['assistants', 'agent_settings', 'engine_presets', 'summary_settings', 'provider_settings', 'compatibility_sync_state']
    .map(table => rows(`SELECT * FROM ${table} WHERE business_id='own' ORDER BY rowid`))).toEqual(own);
  const synced = rows(`SELECT sync.agent_snapshot = json_object(
      'agent_name', legacy.agent_name, 'greeting', legacy.greeting, 'persona', legacy.persona, 'language', legacy.language,
      'voice', legacy.voice, 'take_messages', legacy.take_messages, 'custom_instructions', legacy.custom_instructions,
      'engine', legacy.engine, 'realtime_model', legacy.realtime_model, 'realtime_voice', legacy.realtime_voice,
      'llm_model', legacy.llm_model) AS same FROM compatibility_sync_state sync JOIN agent_settings legacy USING (business_id)`);
  expect(synced.every(r => r.same === 1)).toBe(true);
  const once = rows("SELECT name FROM sqlite_master WHERE type='table'").map(({ name }) => rows(`SELECT * FROM "${name}" ORDER BY rowid`));
  sql(instanceFix);
  expect(rows("SELECT name FROM sqlite_master WHERE type='table'").map(({ name }) => rows(`SELECT * FROM "${name}" ORDER BY rowid`))).toEqual(once);
});
