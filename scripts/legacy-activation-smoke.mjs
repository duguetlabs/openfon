// Synthetic local D1/Worker evidence; no deployed bindings or provider calls.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';

const root = resolve(process.env.OPENFON_SOURCE_ROOT || resolve(import.meta.dirname,'..'));
const built = await build({ entryPoints:[join(root,'src/index.ts')],bundle:true,write:false,
  format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'] });
const mf = new Miniflare(convertV4MiniflareOptions({ modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-09-01',
  d1Databases:['DB'],bindings:{DEFAULT_LLM_BASE_URL:'https://provider.invalid/v1',DEFAULT_LLM_MODEL:'synthetic',
    DEFAULT_STT_BASE_URL:'https://provider.invalid/v1',DEFAULT_STT_MODEL:'synthetic',DEFAULT_TTS_PROVIDER:'browser'} }));
try {
  const db = await mf.getD1Database('DB');
  const sql = text => db.batch(unstable_splitSqlQuery(text).map(statement=>db.prepare(statement)));
  const files = (await readdir(join(root,'migrations'))).filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
  for (const file of files.filter(name=>Number(name.slice(0,4))<=7)) await sql(await readFile(join(root,'migrations',file),'utf8'));
  await sql(`INSERT INTO users(id,email,password_hash) VALUES('u1','one@example.invalid','unused');
    INSERT INTO sessions(token,user_id,expires_at) VALUES('s1','u1','2099-01-01');
    INSERT INTO businesses(id,user_id,slug,name,description) VALUES('b1','u1','one','One','Synthetic repair shop');`);
  for (const file of files.filter(name=>Number(name.slice(0,4))>7)) await sql(await readFile(join(root,'migrations',file),'utf8'));
  const request = (path,token) => mf.dispatchFetch(`https://openfon.test${path}`,{headers:{Cookie:`ofs=${token}`}});
  async function privateState(slug,token) {
    assert.equal((await request(`/api/public/agent/${slug}`,token)).status,404,'unconfigured assistant became public');
    const responses = await Promise.all([request('/api/me/bootstrap',token),request('/api/me/bootstrap',token)]);
    assert.deepEqual(responses.map(r=>r.status),[200,200],'concurrent bootstrap failed');
    assert.equal((await request(`/api/public/agent/${slug}`,token)).status,404,'repair activated a private assistant');
    const row = await db.prepare('SELECT state,activated_at FROM assistants WHERE public_slug=?').bind(slug).first();
    assert.deepEqual(row,{state:'draft',activated_at:null});
  }
  await privateState('one','s1');
  await sql(`INSERT INTO users(id,email,password_hash) VALUES('u2','two@example.invalid','unused'),('u3','three@example.invalid','unused');
    INSERT INTO sessions(token,user_id,expires_at) VALUES('s2','u2','2099-01-01'),('s3','u3','2099-01-01');
    INSERT INTO businesses(id,user_id,slug,name,description) VALUES('b2','u2','two','Two','Synthetic repair shop'),('b3','u3','three','Three','Synthetic repair shop');
    INSERT INTO assistants(id,business_id,public_slug,state,name,persona,language) VALUES('custom','b3','three','draft','Maya','Helpful','en');`);
  await privateState('two','s2'); // Neither legacy settings nor assistant existed.
  await privateState('three','s3'); // Existing private assistant, missing adapter.
  await sql("UPDATE agent_settings SET agent_name='Genuine legacy edit' WHERE business_id='b3'");
  assert.equal((await request('/api/public/agent/three','s3')).status,200,'genuine legacy edit no longer reconciles');
  console.log('PASS missing-legacy migration, concurrent empty/private repair, later genuine legacy edit');
} finally { await mf.dispose(); }
