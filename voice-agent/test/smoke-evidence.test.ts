import {test} from 'node:test';
import assert from 'node:assert/strict';
import {completeTypedSmoke,assertTypedTranscript} from '../scripts/smoke-evidence.mjs';

const primary='Please call me back. Thank you. Goodbye.';
const followup='That is all. Goodbye.';

function terminalRace(){
  let terminal=false;
  const sent:string[]=[];
  const turns:Array<{role:string;text:string}>=[];
  return {
    sent,turns,
    send(text:string){sent.push(text);if(!terminal)turns.push({role:'caller',text});},
    async wait(milliseconds:number){
      // Synthetic boundary: the final poll saw active, then the call closed
      // at the old 16-second deadline before a fallback could be admitted.
      terminal=true;
      if(milliseconds===16000)throw Error('Timed out: initial farewell');
      assert.ok(milliseconds===30000||milliseconds===45000);
    },
  };
}

test('historical timed fallback can expect two rows after sending into terminal state',async()=>{
  const fixture=terminalRace();fixture.send(primary);
  let usedFollowup=false;
  // Previous harness algorithm, retained only as a deterministic regression
  // characterization; this is not evidence of the production send timing.
  try{await fixture.wait(16000);}catch{
    usedFollowup=true;fixture.send(followup);await fixture.wait(30000);
  }
  assert.deepEqual(fixture.sent,[primary,followup]);
  assert.deepEqual(fixture.turns,[{role:'caller',text:primary}]);
  assert.throws(()=>assertTypedTranscript(fixture.turns,[primary,...(usedFollowup?[followup]:[])]),/exactly once/);
});

test('typed acceptance sends only its primary request and observes a 45-second terminal bound',async()=>{
  const fixture=terminalRace();const deadlines:number[]=[];
  await completeTypedSmoke(primary,fixture.send,async(milliseconds:number)=>{
    deadlines.push(milliseconds);await fixture.wait(milliseconds);
  });
  assert.deepEqual(deadlines,[45000]);assert.deepEqual(fixture.sent,[primary]);
  assert.doesNotThrow(()=>assertTypedTranscript(fixture.turns,[primary]));
});

test('typed acceptance propagates terminal wait failure without retry or fallback',async()=>{
  const sent:string[]=[];const failure=Error('Timed out: typed farewell');
  await assert.rejects(completeTypedSmoke(primary,(text:string)=>sent.push(text),async(milliseconds:number)=>{
    assert.equal(milliseconds,45000);throw failure;
  }),error=>error===failure);
  assert.deepEqual(sent,[primary]);
});

test('typed acceptance still rejects missing, duplicate, changed and reordered caller rows',()=>{
  const caller=(text:string)=>({role:'caller',text});
  for(const rows of [[],[caller(primary),caller(primary)],[caller('Changed')],[caller(followup),caller(primary)]]){
    assert.throws(()=>assertTypedTranscript(rows,[primary]),/exactly once/);
  }
  assert.throws(()=>assertTypedTranscript([caller(followup),caller(primary)],[primary,followup]),/exactly once/);
  assert.doesNotThrow(()=>assertTypedTranscript([{role:'agent',text:'Hello'},caller(primary),{role:'agent',text:'Goodbye'}],[primary]));
});
