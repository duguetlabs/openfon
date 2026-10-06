import {it,expect} from 'vitest';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {customerRecording} from '../src/customer-recording';
it('extracts sanitized caller/output tracks at their actual rates without permitting live replay',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'openfon-recording-extraction-'));
 try {
  const bundle=[{kind:'manifest',version:1,callId:'synthetic',chunks:1,records:4,partial:false},
   {kind:'configuration',seq:0,ms:0,model:'must-not-export'},
   {kind:'audio',seq:1,ms:1000,sourceMs:0,track:'caller',format:'pcm_s16le_24000',frame:1,offset:0,total:4,data:'AQACAA=='},
   {kind:'audio',seq:2,ms:1001,sourceMs:0,track:'agent',format:'pcm_s16le_48000',frame:2,offset:0,total:4,data:'AwAEAA=='},
   {kind:'capture',seq:3,ms:1002,sourceMs:2,name:'interrupted',raw:'must-not-export'},
   {kind:'end',chunks:1}];
  const projected=await customerRecording(new Response(bundle.map(r=>JSON.stringify(r)).join('\n'))).text();
  expect(projected).not.toContain('must-not-export');
  const path=join(dir,'recording.ndjson');writeFileSync(path,projected);
  const args=[resolve('scripts/call-debug-replay.mjs'),path,'--out',join(dir,'audio')];
  const result=spawnSync(process.execPath,args,{encoding:'utf8'});expect(result.status,result.stderr).toBe(0);
  const caller=readFileSync(join(dir,'audio/caller.wav')),agent=readFileSync(join(dir,'audio/agent-48000.wav'));
  expect(caller.readUInt32LE(24)).toBe(24000);expect(agent.readUInt32LE(24)).toBe(48000);
  expect(caller.subarray(44)).toEqual(Buffer.from([1,0,2,0]));expect(agent.subarray(44)).toEqual(Buffer.from([3,0,4,0]));
  const damaged=projected.trim().split('\n').filter(line=>JSON.parse(line).track!=='caller').join('\n');
  writeFileSync(path,damaged);
  const missing=spawnSync(process.execPath,args,{encoding:'utf8'});expect(missing.status).not.toBe(0);expect(missing.stderr).toContain('Partial recording');
  writeFileSync(path,projected);
  const live=spawnSync(process.execPath,[...args,'--live'],{encoding:'utf8'});expect(live.status).not.toBe(0);expect(live.stderr).toContain('offline extraction only');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
