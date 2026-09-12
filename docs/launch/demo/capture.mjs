import { chromium, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const output = dirname(fileURLToPath(import.meta.url));
const root = resolve(output, '../../..');
const port = Number(process.env.DEMO_PORT || 8791);
const inspector = Number(process.env.DEMO_INSPECTOR_PORT || 9233);
for (const p of [port, inspector]) await new Promise((yes, no) => { const s = createServer(); s.once('error', no); s.listen(p, '127.0.0.1', () => s.close(yes)); });
const temporary = mkdtempSync(join(tmpdir(), 'openfon-demo-capture-'));
// Reuse the repository's deterministic local provider and fresh D1 setup, only
// changing listener ports in a disposable copy. No production state is accessed.
const serverSource = readFileSync(join(root, 'scripts/e2e-server.mjs'), 'utf8')
  .replace("'8790'", `'${port}'`).replace("'9232'", `'${inspector}'`);
const serverPath = join(temporary, 'server.mjs'); writeFileSync(serverPath, serverSource);
const server = spawn(process.execPath, [serverPath], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', x => serverLog += x); server.stderr.on('data', x => serverLog += x);
const origin = `http://localhost:${port}`;
let browser;
try {
  let ready = false;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 500)); }
  if (!ready) throw new Error(`Local demo server unavailable: ${serverLog}`);
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const setup = await browser.newContext({ baseURL: origin, viewport: { width: 1280, height: 800 } });
  const page = await setup.newPage();
  await page.goto('/auth');
  await page.getByLabel('Email').fill('demo@northwheel.example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Demo-Only-1234');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Business name', { exact: true }).fill('Northwheel Bicycle Workshop');
  await page.getByLabel('What do you do?').fill('A fictional neighborhood bicycle workshop. Repairs, tune-ups, and friendly advice.');
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: /Create.*assistant|Save.*assistant|Open.*studio/i }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  const bootstrap = await (await page.request.get('/api/me/bootstrap')).json();
  const assistantId = bootstrap.assistants[0].id;
  const saved = await page.request.put(`/api/me/assistants/${assistantId}`, { data: { engine: 'pipeline', greeting: 'Hello, you have reached Northwheel Bicycle Workshop. How can I help?' } });
  if (!saved.ok()) throw new Error('Demo assistant setup failed');
  await page.goto('/knowledge');
  await page.getByLabel('New collection', { exact: true }).fill('Workshop services');
  await page.getByRole('button', { name: 'Create collection' }).click();
  await expect(page.getByRole('status')).toContainText('Collection created');
  await page.getByRole('button', { name: 'Add knowledge' }).click();
  await page.getByLabel('Question', { exact: true }).fill('Do you repair bicycles?');
  await page.getByLabel('Answer', { exact: true }).fill('Yes, we repair bicycles during opening hours.');
  await page.getByRole('button', { name: 'Save knowledge' }).click();
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Alex', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Assistant knowledge updated');
  const collection = await page.getByRole('combobox', { name: 'Collection', exact: true }).inputValue();
  // Generate a real private test transcript through Worker + WebSocket + the
  // deterministic local text provider. No microphone or voice synthesis is used.
  const callId = await page.evaluate(async assistantId => {
    const response = await fetch(`/api/me/assistants/${assistantId}/test-calls`, {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
    if (!response.ok) throw new Error('Test reservation failed');
    const {callId} = await response.json();
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(`${location.origin.replace('http','ws')}/ws/call/${callId}`);
      const timer = setTimeout(() => { socket.close(); reject(new Error('Synthetic test timeout')); },15000);
      socket.onopen = () => socket.send(JSON.stringify({type:'start'}));
      socket.onerror = () => reject(new Error('Synthetic socket failed'));
      socket.onmessage = e => { if(typeof e.data !== 'string') return; const message=JSON.parse(e.data);
        if(message.type==='ready') socket.send(JSON.stringify({type:'text',text:'Do you repair bicycles?'}));
        if(message.type==='agent_text') socket.send(JSON.stringify({type:'hangup'}));
        if(message.type==='error') {clearTimeout(timer);socket.close();reject(new Error('Synthetic provider failed'));}
        if(message.type==='ended'){clearTimeout(timer);socket.close();resolve();}
      };
    });
    return callId;
  }, assistantId);
  await expect.poll(async () => (await (await page.request.get(`/api/me/calls/${callId}`)).json()).status).toBe('completed');
  const state = await setup.storageState(); await setup.close();
  mkdirSync(join(output,'raw'),{recursive:true});
  const context = await browser.newContext({ baseURL:origin,storageState:state,viewport:{width:1280,height:800},deviceScaleFactor:1,recordVideo:{dir:join(output,'raw'),size:{width:1280,height:800}},reducedMotion:'reduce' });
  const scene = await context.newPage(); const errors=[]; scene.on('pageerror', e=>errors.push(e.message));
  const start = Date.now();
  await scene.goto('/overview'); await expect(scene.getByRole('heading',{level:1})).toBeVisible();
  const trim = (Date.now()-start)/1000;
  const hold = ms => scene.waitForTimeout(ms);
  await hold(5000);
  await scene.getByRole('navigation',{name:'Workspace'}).getByRole('link',{name:'Assistants',exact:true}).click(); await hold(3000);
  await scene.getByRole('link',{name:'Configure →'}).first().click(); await hold(6000);
  await scene.getByRole('navigation',{name:'Workspace'}).getByRole('link',{name:'Knowledge',exact:true}).click();
  await scene.getByRole('combobox',{name:'Collection',exact:true}).selectOption(collection); await hold(2500);
  await scene.getByRole('button',{name:'Approve',exact:true}).click(); await expect(scene.getByText('Approved',{exact:true})).toBeVisible(); await hold(4000);
  await scene.screenshot({path:join(output,'poster-ui.png')});
  await scene.getByRole('navigation',{name:'Workspace'}).getByRole('link',{name:'Calls',exact:true}).click(); await hold(3500);
  await scene.goto(`/calls/${callId}`); await expect(scene.getByText('Do you repair bicycles?',{exact:true})).toBeVisible(); await hold(7000);
  await scene.screenshot({path:join(output,'conversation-ui.png')});
  const duration=(Date.now()-start)/1000-trim;
  const video=scene.video(); await context.close(); const raw=await video.path();
  if(errors.length) throw new Error(errors.join('\n'));
  const metadata={createdAt:new Date().toISOString(),artifact:'openfon-walkthrough.mp4',trimSeconds:trim,durationSeconds:duration,viewport:{width:1280,height:800},synthetic:true,silent:true};
  writeFileSync(join(output,'capture.json'),JSON.stringify(metadata,null,2)+'\n');
  const filter="pad=1280:900:0:100:color=0xf9f7f0,drawtext=fontfile=/System/Library/Fonts/Helvetica.ttc:text='OpenFon / From setup to reviewed conversations':x=32:y=18:fontsize=28:fontcolor=0x173aaf,drawtext=fontfile=/System/Library/Fonts/Helvetica.ttc:text='SYNTHETIC DEMO  |  Fictional business  |  Silent UI walkthrough - no real voice demonstration':x=32:y=62:fontsize=17:fontcolor=0x4b5563";
  const ff=spawnSync('ffmpeg',['-y','-ss',String(trim),'-i',raw,'-t',String(duration),'-vf',filter,'-an','-c:v','libx264','-crf','20','-preset','medium','-pix_fmt','yuv420p','-movflags','+faststart',join(output,'openfon-walkthrough.mp4')],{encoding:'utf8'});
  if(ff.status!==0) throw new Error(ff.stderr);
  const poster=spawnSync('ffmpeg',['-y','-ss','2','-i',join(output,'openfon-walkthrough.mp4'),'-frames:v','1',join(output,'poster.png')],{encoding:'utf8'});
  if(poster.status!==0)throw new Error(poster.stderr);
  rmSync(join(output,'raw'),{recursive:true,force:true});
  rmSync(join(output,'poster-ui.png'),{force:true});
  rmSync(join(output,'conversation-ui.png'),{force:true});
  console.log(JSON.stringify(metadata));
} finally { await browser?.close(); if(server.exitCode===null){server.kill('SIGTERM'); await new Promise(r=>server.once('exit',r));} rmSync(temporary,{recursive:true,force:true}); }
