import type {AgentSettings,Env} from './types';
import {gptLiveVoice} from './gpt-live';
/** Browser routing is operator-owned; saved carrier/provider settings are preserved. */
export function managedBrowserSettings(env:Env,settings:AgentSettings):AgentSettings {
  if(!env.REALTIME_API_KEY)throw new Error('Calling service is not configured');
  const selected=settings.engine==='realtime'?settings.realtime_voice:settings.voice;
  return {...settings,engine:'realtime',realtime_model:'gpt-live-1',realtime_voice:gptLiveVoice(selected||'marin'),
    realtime_provider:'kataleptic',realtime_base_url:'wss://api.kataleptic.com/v1/realtime',realtime_api_key:env.REALTIME_API_KEY};
}
