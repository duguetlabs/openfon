import type {voice} from '@livekit/agents';
export type SpeechOutcome='completed'|'interrupted'|'failed';
export type PlaybackHandle=Pick<voice.SpeechHandle,'waitForPlayout'|'interrupted'|'exception'>;
/** SDK completion resolves even when its task stored an exception. */
export async function speechOutcome(handle:PlaybackHandle):Promise<SpeechOutcome>{
  try{
    await handle.waitForPlayout();
    if(handle.interrupted)return 'interrupted';
    return handle.exception()===undefined?'completed':'failed';
  }catch{return handle.interrupted?'interrupted':'failed';}
}
export async function successfulPlayout(handle:PlaybackHandle):Promise<boolean>{
  const outcome=await speechOutcome(handle);
  if(outcome==='failed')throw new Error('Speech playback failed');
  return outcome==='completed';
}
