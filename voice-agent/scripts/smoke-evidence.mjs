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
