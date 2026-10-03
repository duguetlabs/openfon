import {defineAgent, voice, llm, AutoSubscribe, type JobContext} from '@livekit/agents';
import {appendTypedInput} from './typed-input.js';
import {realtime} from '@livekit/agents-plugin-openai';
import {RoomEvent, TrackSource, type RemoteTrackPublication} from '@livekit/rtc-node';
import {createCallerAudioSubscription} from './caller-audio.js';
import {TranscriptBridge} from './transcript-bridge.js';
import {within} from './deadline.js';
import {ControlClient, AdmissionError} from './control.js';
import {observeGeneration} from './stream-transcripts.js';
import {ClockedGPTLiveSession} from './clocked-session.js';
import {ToolClosure} from './tool-closure.js';
import {FarewellPair} from './farewell.js';
import {acceptedEcho, modelOptions} from './config.js';

export default defineAgent({entry: async (ctx: JobContext) => {
  const metadata = JSON.parse(ctx.job.metadata || '{}') as {callId?: string};
  const control = new ControlClient(process.env.OPENFON_API_URL!, process.env.OPENFON_AGENT_SERVICE_TOKEN!, metadata.callId || '', ctx.job.room?.name || ctx.room.name || '', ctx.job.id);
  const context = await control.context();
  let session: voice.AgentSession | undefined;
  let latestSpeech:voice.SpeechHandle|undefined;
  let providerSession:ClockedGPTLiveSession|undefined;
  let realtimeSession:llm.RealtimeSession|undefined;
  const toolClosure=new ToolClosure();
  let stopping: Promise<void> | undefined;
  let failed = false;
  let stopped = false;
  let monitoring: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const callerAudio = createCallerAudioSubscription<RemoteTrackPublication>(context.caller, TrackSource.SOURCE_MICROPHONE, () => {});
  const transcripts = new TranscriptBridge(async item => {
    await control.post('events', {callback: context.callback, type: 'transcript', eventId: item.sourceItemId,
      revision: item.revision, final: item.final, role: item.role === 'caller' ? 'caller' : 'agent', text: item.text});
  }, async () => {}, 200);
  const diagnostic=(phase:string)=>console.info(JSON.stringify({event:'openfon_voice_lifecycle',phase}));
  const stop = (failure = false, drain = false): Promise<void> => {
    failed ||= failure;
    if (stopping) return stopping;
    stopped = true;
    diagnostic(failure?'failure_stop':'normal_stop');
    stopping = (async () => {
      clearTimeout(monitoring); clearTimeout(deadline);
      providerSession?.stopInputClock();
      const subscriptionsStopped=callerAudio.stop();
      if(!subscriptionsStopped)diagnostic('unsubscribe_already_closed');
      ctx.room.off(RoomEvent.TrackPublished, callerAudio.subscribe);
      try{session?.input.setAudioEnabled(false);}catch{if(ctx.room.isConnected)failed=true;diagnostic('input_already_closed');}
      try {
        // Drain allows an already-spoken goodbye to finish. Transport/error shutdown interrupts.
        session?.shutdown({drain});
        await within(session?.close()??Promise.resolve(),6000);
        diagnostic('session_closed');
      } catch {
        failed = true;
        diagnostic('session_close_deadline');
        try{session?.output.setAudioEnabled(false);}catch{/* native output may already be closed */}
        void providerSession?.close().catch(()=>{});
      }
      try { await within(transcripts.flush(),7000); diagnostic('transcripts_flushed'); } catch { failed = true; diagnostic('transcripts_failed'); }
      try { await control.post('events', {callback: context.callback, type: 'finished', failed}); diagnostic('finished_acknowledged'); }
      catch(error){diagnostic(error instanceof AdmissionError?'finished_rejected':'finished_unavailable');throw error;}
      finally {
        try{await within(ctx.room.disconnect(),2000);}finally{ctx.shutdown('call completed');}
      }
    })();
    return stopping;
  };
  const stopSafely = (failure = false, drain = false) => { void stop(failure, drain).catch(() => { console.error('Call shutdown did not confirm persistence'); }); };
  ctx.addShutdownCallback(async () => { await stop(); });
  const farewell=new FarewellPair(stillCurrent=>{
    diagnostic('paired_farewell');
    void(async()=>{
      try{
        const speech=latestSpeech;
        if(!speech)throw Error('Farewell playout unavailable');
        if(speech)await within(speech.waitForPlayout(),15000);
        if(!stopped&&stillCurrent())await stop(false,true);
      }catch{stopSafely(true);}
    })();
  });
  class CheckedModel extends realtime.GPTLiveModel {
    override session(): realtime.GPTLiveSession {
      const duplex = new ClockedGPTLiveSession(this,()=>stopSafely(true));
      providerSession=duplex;
      duplex.on('input_audio_transcription_completed', event => {
        if(event.itemId){toolClosure.observe(event.itemId,event.transcript,event.isFinal);farewell.record('caller',event.itemId,event.transcript,event.isFinal);}
        if (event.itemId) void transcripts.record({id: event.itemId, role: 'caller', text: event.transcript, final: event.isFinal, createdAt: event.turnStartedAt}).catch(() => stopSafely(true));
      });
      duplex.on('error', () => stopSafely(true));
      duplex.on('openai_server_event_received', event => {
        if(event.type==='session.started'){
          if(!acceptedEcho(event.session,context.voice))stopSafely(true);
          else if(!stopped)duplex.startInputClock();
        }
        if (event.type === 'error') stopSafely(true);
        if (event.type === 'session.closed' && !stopped) stopSafely(true);
      });
      return duplex;
    }
  }
  const model = new CheckedModel({...modelOptions(context, process.env.KATALEPTIC_API_KEY!), delegation: 'responses', connOptions: {timeoutMs: 10000, maxRetry: 0, retryIntervalMs: 1000}});
  if (!(model instanceof llm.DuplexModel)) throw new Error('Incompatible conversation SDK');
  class TranscriptAdapter extends llm.DuplexRealtimeAdapter {
    override session() {
      const adapted=super.session();
      realtimeSession=adapted;
      adapted.on('generation_created',event=>observeGeneration(event,(id,text)=>{
        void transcripts.record({id,role:'assistant',text,final:false}).catch(()=>stopSafely(true));
      }));
      return adapted;
    }
  }
  session = new voice.AgentSession({llm: new TranscriptAdapter(model)});
  session.on(voice.AgentSessionEventTypes.SpeechCreated,event=>{latestSpeech=event.speechHandle;});
  session.on(voice.AgentSessionEventTypes.Error, () => stopSafely(true));
  session.on(voice.AgentSessionEventTypes.Close, () => { if (!stopped) stopSafely(true); });
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, event => {
    const item = event.item;
    if (item.type !== 'message' || !['user', 'assistant'].includes(item.role) || !item.textContent) return;
    if(item.role==='user')toolClosure.observe(item.id,item.textContent,true);
    farewell.record(item.role==='user'?'caller':'assistant',item.id,item.textContent,true);
    void transcripts.record({id: item.id, role: item.role === 'user' ? 'caller' : 'assistant', text: item.textContent, final: true, createdAt: item.createdAt}).catch(() => stopSafely(true));
  });
  const endCall = llm.tool({name: 'end_call', description: 'End a completed conversation by scheduling a brief spoken goodbye, then disconnecting after it plays.',
    parameters: {type: 'object', properties: {}, additionalProperties: false},
    execute: async () => {
      // Return from the function before draining the activity that owns this function.
      const ticket=toolClosure.begin();
      if(ticket){
        diagnostic('end_call_requested');
        setTimeout(()=>{void (async()=>{
          if(stopped||!toolClosure.current(ticket))return;
          try{
            // A control acknowledgement is not a spoken goodbye. Request and drain actual speech.
            await within(session!.generateReply({instructions:'The conversation is complete. Say one brief polite goodbye in the caller’s language, without questions, new business facts or tools.'}).waitForPlayout(),15000);
            if(!stopped&&toolClosure.current(ticket))await stop(false,true);
          }catch{if(toolClosure.current(ticket))stopSafely(true);}
          finally{toolClosure.release(ticket);}
        })();},0);
      }
      return 'Closure is scheduled after a brief spoken goodbye. Do not request another tool or start a new conversation.';
    },
  });
  const agent = new voice.Agent({instructions: `${context.instructions}\n\nSpeak ${context.language}. Start by greeting the caller: ${context.greeting}\nWhen the caller clearly ends the conversation, delegate end_call. It schedules a brief polite goodbye before disconnecting. Do not simply say goodbye and leave the call open. Never announce internal technology.`, tools: new llm.ToolContext([endCall])});
  const sentCommands=new Set<string>();
  const monitor = async () => {
    if (stopped) return;
    try {
      const current=await control.context();
      for(const command of current.commands??[]){
        if(stopped)break;
        // New admitted text cancels a pending goodbye before its fallible acknowledgement.
        toolClosure.observe(command.id,command.text,true);
        farewell.record('caller',command.id,command.text,true);
        // Admit once before generation. Ambiguous delivery ends the call, never replays inference.
        await control.post('events',{callback:context.callback,type:'command_ack',commandId:command.id});
        if(stopped||sentCommands.has(command.id))continue;
        sentCommands.add(command.id);
        await transcripts.record({id:command.id,role:'caller',text:command.text,final:true});
        if(!stopped){
          if(!realtimeSession)throw new Error('Typed conversation unavailable');
          await appendTypedInput(agent,realtimeSession.chatCtx,command);
          if(!stopped)session!.generateReply();
        }
      }
    } catch (error) { stopSafely(!(error instanceof AdmissionError && [404,410].includes(error.status))); return; }
    if (!stopped) monitoring = setTimeout(() => void monitor(), 2000);
  };
  try {
    await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_NONE);
    if (stopped) { await ctx.room.disconnect(); return; }
    await control.context();
    if (stopped) return;
    ctx.room.on(RoomEvent.TrackPublished, callerAudio.subscribe);
    ctx.room.on(RoomEvent.ParticipantDisconnected, participant => { if (participant.identity === context.caller) stopSafely(); });
    ctx.room.on(RoomEvent.Disconnected, () => stopSafely());
    const caller = ctx.room.remoteParticipants.get(context.caller);
    if (caller) for (const publication of caller.trackPublications.values()) callerAudio.subscribe(publication, caller);
    deadline = setTimeout(() => stopSafely(), 30*60*1000);
    await within(ctx.waitForParticipant(context.caller),15000);
    if(stopped)return;
    await within(session.start({agent, room: ctx.room, record: false, inputOptions: {closeOnDisconnect: false, deleteRoomOnClose: false, textEnabled: false, participantIdentity: context.caller}}),15000);
    if (stopped) { await session.close(); return; }
    await control.post('events',{callback:context.callback,type:'ready'});
    if(stopped)return;
    monitoring = setTimeout(() => void monitor(), 2000);
    session.generateReply({instructions: `Greet the caller now with: ${context.greeting}`});
  } catch { await stop(true); }
}});
