import { observeAsteriskRateWrites } from '../scripts/asterisk-smoke-db.mjs';
import { expect,it } from 'vitest';
import { waitForPbxRejection } from '../scripts/asterisk-runtime.mjs';
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
