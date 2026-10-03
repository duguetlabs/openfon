export function smokeTarget(argv){
  const staging=argv.includes('--stage-ready'),production=argv.includes('--production-ready');
  if(staging===production||!argv.includes('--allow-paid'))throw Error('Requires exactly one --stage-ready or --production-ready plus --allow-paid; deployment approval is required.');
  return production?{environment:'production',origin:'https://openfon.ai',signaling:'wss://voice.openfon.ai'}:
    {environment:'staging',origin:'https://openfon-staging.duguetlabs.workers.dev',signaling:'wss://voice-staging.openfon.ai'};
}
export function safeControlEvent(message,elapsedMs){
  if(!message||!['ready','agent_ready','transcript','agent_text','error','ended'].includes(message.type))return;
  return {type:message.type,elapsedMs:Math.max(0,Math.min(3600000,Math.round(elapsedMs)))};
}

// A timed second command can race an already-closing call. This acceptance
// case sends one complete request and observes it without introducing input.
export async function completeTypedSmoke(input,send,waitForCompletion){
  send(input);
  await waitForCompletion(45000);
}

export function assertTypedTranscript(turns,expected){
  const caller=turns.filter(turn=>turn.role==='caller');
  if(caller.length!==expected.length||caller.some((turn,index)=>turn.text!==expected[index])){
    throw Error('Typed commands were not persisted exactly once in order');
  }
}
