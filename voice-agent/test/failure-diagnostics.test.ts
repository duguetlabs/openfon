import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {classifyFailure,reportFailure} from '../src/failure-diagnostics.js';
import {ControlClient,AdmissionError} from '../src/control.js';

test('nested SDK/provider errors retain bounded known classification without payloads',()=>{
  const leaf=Object.assign(new TypeError('private URL https://secret.invalid/?key=do-not-log'),{code:'invalid_value',param:'audio_end_ms',status:400,authorization:'secret'});
  const wrapped={type:'realtime_model_error',error:{cause:leaf},payload:'private transcript'};
  const record=classifyFailure('sdk_session',wrapped);
  assert.equal(record.code,'invalid_value');assert.equal(record.parameter,'audio_end_ms');assert.equal(record.httpStatus,400);assert.equal(record.errorClass,'TypeError');
  assert.equal(record.type,'realtime_model_error');assert.match(String(record.messageHash),/^[a-f0-9]{16}$/);
  for(const hidden of ['private','secret','do-not-log','https','transcript','authorization'])assert.ok(!JSON.stringify(record).includes(hidden));
});

test('unknown strings are hashed; arbitrary messages cannot become known codes',()=>{
  const record=classifyFailure('mini_terminal',{code:'https://private.invalid',param:'api-key-private',name:'private class',message:'invalid_value'});
  assert.equal(record.code,undefined);assert.equal(record.parameter,undefined);
  for(const key of ['codeHash','parameterHash','errorClassHash','messageHash'])assert.match(String(record[key]),/^[a-f0-9]{16}$/);
  assert.ok(!JSON.stringify(record).includes('private'));
});

test('cycles and deep SDK wrappers are bounded; getters and toJSON are never evaluated',()=>{
  let reads=0;const circular:any={};circular.cause=circular;
  Object.defineProperty(circular,'error',{get(){reads++;throw Error('secret');}});
  circular.toJSON=()=>{reads++;throw Error('secret');};
  assert.deepEqual(classifyFailure('sdk_session',circular),{stage:'sdk_session'});assert.equal(reads,0);
  assert.equal(classifyFailure('sdk_session',{error:{cause:{error:{cause:{code:'invalid_value'}}}}}).code,undefined);
});

test('origin diagnostic deduplicates SDK wrapping and preserves exception identity',()=>{
  const failure=new Error('original');const records:any[]=[];
  reportFailure('mini_terminal',failure,r=>records.push(r),{code:'invalid_value',param:'audio_end_ms'});
  reportFailure('sdk_session',{type:'realtime_model_error',error:failure},r=>records.push(r));
  assert.equal(records.length,1);assert.equal(records[0].stage,'mini_terminal');
  assert.equal(failure.message,'original');assert.deepEqual(Object.keys(failure),[]);
  assert.doesNotThrow(()=>reportFailure('control_monitor',new Error('original'),()=>{throw Error('logging broken');}));
});

test('control retry exhaustion records final HTTP status while keeping its public error unchanged',async()=>{
  const records:any[]=[];let requests=0;
  mock.method(globalThis,'fetch',async()=>{requests++;return new Response('{}',{status:503});});
  try{
    const client=new ControlClient('https://unit.invalid','synthetic','call','room','job',r=>records.push(r));
    await assert.rejects(client.context(),{message:'Call control unavailable'});
    assert.equal(requests,3);assert.equal(records.length,1);assert.equal(records[0].httpStatus,503);assert.equal(records[0].operation,'context');
  }finally{mock.restoreAll();}
});

test('control preserves a thrown admission exception and logs network cause before flattening',async()=>{
  const records:any[]=[];const admission=new AdmissionError(410);
  const client=new ControlClient('https://unit.invalid','synthetic','call','room','job',r=>records.push(r));
  mock.method(globalThis,'fetch',async()=>{throw admission;});
  try{await assert.rejects(client.context(),error=>error===admission);assert.equal(records[0].httpStatus,410);}finally{mock.restoreAll();}
  const network=new TypeError('fetch failed',{cause:Object.assign(new Error('private endpoint'),{code:'ECONNRESET'})});
  mock.method(globalThis,'fetch',async()=>{throw network;});
  try{
    await assert.rejects(client.context(),{message:'Call control unavailable'});
    assert.equal(records[1].code,'ECONNRESET');assert.ok(!JSON.stringify(records).includes('private endpoint'));
  }finally{mock.restoreAll();}
});
