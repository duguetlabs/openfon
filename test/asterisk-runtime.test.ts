import { observeAsteriskRateWrites } from '../scripts/asterisk-smoke-db.mjs';
import { expect,it } from 'vitest';
import { asteriskRuntimeNetwork, prepareAsteriskRuntimeDocker, waitForPbxRejection } from '../scripts/asterisk-runtime.mjs';
const wait=async(predicate:()=>boolean)=>{if(!predicate())throw Error('no correlated rejection');};
it('does not pass before an attempt or on a stale/different/accepted handshake',async()=>{
  for(const attempts of [[],[{sequence:1,call:'runtime-revoked',status:401,rateWriteAttempts:0}],[{sequence:2,call:'runtime-one',status:401,rateWriteAttempts:0}],[{sequence:2,call:'runtime-revoked',status:101,rateWriteAttempts:0}]]){
    await expect(waitForPbxRejection({wait,attempts,after:1,call:'runtime-revoked'})).rejects.toThrow('no correlated rejection');
  }
});
it('waits for the new matching handshake rejection before reporting success',async()=>{
  const attempt={sequence:2,call:'runtime-revoked',status:null as number|null,rateWriteAttempts:null as number|null};
  const wait=async(predicate:()=>boolean)=>{expect(predicate()).toBe(false);attempt.status=401;attempt.rateWriteAttempts=0;expect(predicate()).toBe(true);};
  expect(await waitForPbxRejection({wait,attempts:[attempt],after:1,call:'runtime-revoked'})).toBe(attempt);
});
it('rejects observed rate-write attempts and missing instrumentation even if counters would be unchanged',async()=>{
  for(const rateWriteAttempts of [1,null,NaN])await expect(waitForPbxRejection({wait,attempts:[{sequence:2,call:'runtime-revoked',status:401,rateWriteAttempts}],after:1,call:'runtime-revoked'})).rejects.toThrow('revoked handshake attempts no D1 rate-counter write');
});

it('observes attempted rate writes even when no database mutation succeeds',()=>{
  const db={prepare:(sql:string)=>{if(sql.startsWith('INSERT'))throw Error('denied');return sql;},exec:(sql:string)=>sql};
  const observer=observeAsteriskRateWrites(db);
  observer.DB.prepare('SELECT * FROM rate_counters');observer.DB.exec('UPDATE asterisk_routes SET enabled=0');
  expect(observer.attempts).toBe(0);
  expect(()=>observer.DB.prepare('INSERT INTO rate_counters VALUES(1)')).toThrow('denied');expect(observer.attempts).toBe(1);
  observer.DB.exec('DELETE FROM rate_counters');expect(observer.attempts).toBe(2);
});


it('chooses a complete native Linux loopback path without opening the proxy to the LAN',()=>{
  expect(asteriskRuntimeNetwork({platform:'linux',daemonHost:'unix:///var/run/docker.sock',operatingSystem:'Ubuntu 24.04',securityOptions:[]}))
    .toEqual({host:'127.0.0.1',dockerArgs:['--network=host'],mode:'linux-host'});
});
it.each(['darwin','linux'])('preserves Docker Desktop host forwarding on %s',platform=>{
  expect(asteriskRuntimeNetwork({platform,daemonHost:'unix:///local/docker.sock',operatingSystem:'Docker Desktop'}))
    .toEqual({host:'host.docker.internal',dockerArgs:[],mode:'docker-desktop'});
});
it('refuses unsupported daemon paths rather than exposing a wildcard proxy',()=>{
  for(const daemonHost of ['ssh://remote','tcp://127.0.0.1:2375','tcp://remote:2376',undefined]){
    expect(()=>asteriskRuntimeNetwork({platform:'linux',daemonHost,operatingSystem:'Ubuntu'})).toThrow('local Unix-socket');
  }
  expect(()=>asteriskRuntimeNetwork({platform:'linux',daemonHost:'unix:///rootless.sock',operatingSystem:'Ubuntu',securityOptions:['name=rootless']})).toThrow('rootful Linux');
  expect(()=>asteriskRuntimeNetwork({platform:'darwin',daemonHost:'unix:///vm.sock',operatingSystem:'Alpine Linux'})).toThrow('Docker Desktop');
});
it('pins the resolved daemon for info, image, execution and cleanup despite context changes',async()=>{
  const calls:{args:string[];env:Record<string,string>}[]=[];
  let saved='first';
  const run=async(args:string[],env:Record<string,string>)=>{
    calls.push({args:[...args],env:{...env}});
    if(args[0]==='context' && args[1]==='show')return saved;
    if(args[0]==='context' && args[1]==='inspect')return JSON.stringify([{Endpoints:{docker:{Host:`unix:///${args[2]}.sock`}}}]);
    if(args[0]==='--host'){
      if(args[2]==='info' && args[4]==='{{json .OperatingSystem}}')return JSON.stringify('Docker Desktop');
      if(args[2]==='info' && args[4]==='{{json .SecurityOptions}}')return '[]';
      return '';
    }
    throw Error('unexpected Docker command');
  };
  const env={DOCKER_CONTEXT:'desktop-local',DOCKER_HOST:'ssh://ignored',DOCKER_TLS_VERIFY:'1'};
  const prepared=await prepareAsteriskRuntimeDocker(run,env,'darwin');
  expect(prepared.network.mode).toBe('docker-desktop');
  expect(calls[0].args).toEqual(['context','inspect','desktop-local']);
  saved='other';env.DOCKER_CONTEXT='other';env.DOCKER_HOST='ssh://other';
  for(const args of [['image','inspect','fixture'],['run','fixture'],['exec','fixture','asterisk'],['logs','fixture'],['rm','-f','fixture']])await prepared.docker(...args);
  const pinned=calls.slice(1);expect(pinned).toHaveLength(7);
  for(const call of pinned){
    expect(call.args.slice(0,2)).toEqual(['--host','unix:///desktop-local.sock']);
    expect(call.env).toMatchObject({DOCKER_CONTEXT:'',DOCKER_HOST:'unix:///desktop-local.sock',DOCKER_TLS_VERIFY:'',DOCKER_CERT_PATH:''});
  }
  calls.length=0;
  await expect(prepareAsteriskRuntimeDocker(run,{DOCKER_HOST:'ssh://remote'},'linux')).rejects.toThrow('local Unix-socket');
  expect(calls).toEqual([]); // refuse before contacting the unsupported daemon
  const fromHost=await prepareAsteriskRuntimeDocker(run,{DOCKER_HOST:'unix:///explicit.sock'},'linux');
  expect(fromHost.network.mode).toBe('docker-desktop');
  expect(calls.every(call=>call.args[0]==='--host' && call.args[1]==='unix:///explicit.sock')).toBe(true);
  calls.length=0;
  await prepareAsteriskRuntimeDocker(run,{},'darwin');
  expect(calls[0].args).toEqual(['context','show']);expect(calls[1].args).toEqual(['context','inspect','other']);
  expect(calls.slice(2).every(call=>call.args[1]==='unix:///other.sock')).toBe(true);
});
