import type {voice} from '@livekit/agents';
export class ResponseUnavailable extends Error {constructor(){super('The response was unavailable.');this.name='ResponseUnavailable';}}
export function responseUnavailable(error:unknown):boolean {for(let i=0;i<4&&error&&typeof error==='object';i++){if(error instanceof ResponseUnavailable)return true;error=(error as {cause?:unknown}).cause;}return false;}
export type SpeechOutcome='completed'|'interrupted'|'failed';
export type PlaybackHandle=Pick<voice.SpeechHandle,'waitForPlayout'|'interrupted'|'exception'>;
/** SDK completion resolves even when its task stored an exception. */
export async function speechOutcome(handle:PlaybackHandle):Promise<SpeechOutcome>{
  try{
    await handle.waitForPlayout();
    if(handle.interrupted||responseUnavailable(handle.exception()))return 'interrupted';
    return handle.exception()===undefined?'completed':'failed';
  }catch(error){return handle.interrupted||responseUnavailable(error)?'interrupted':'failed';}
}
export async function successfulPlayout(handle:PlaybackHandle):Promise<boolean>{
  const outcome=await speechOutcome(handle);
  if(outcome==='failed')throw new Error('Speech playback failed');
  return outcome==='completed';
}
