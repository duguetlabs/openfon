import {defineAgent, voice, llm, AutoSubscribe, type JobContext} from '@livekit/agents';
import {realtime} from '@livekit/agents-plugin-openai';
import {RoomEvent, TrackSource, type RemoteTrackPublication} from '@livekit/rtc-node';
import {createCallerAudioSubscription} from './caller-audio.js';
import {TranscriptBridge} from './transcript-bridge.js';
import {within} from './deadline.js';
import {ControlClient, AdmissionError} from './control.js';
import {observeGeneration} from './stream-transcripts.js';
import {acceptedEcho, modelOptions} from './config.js';

export default defineAgent({entry: async (ctx: JobContext) => {
  const metadata = JSON.parse(ctx.job.metadata || '{}') as {callId?: string};
  const control = new ControlClient(process.env.OPENFON_API_URL!, process.env.OPENFON_AGENT_SERVICE_TOKEN!, metadata.callId || '', ctx.job.room?.name || ctx.room.name || '', ctx.job.id);
  const context = await control.context();
  let session: voice.AgentSession | undefined;
  let providerSession:realtime.GPTLiveSession|undefined;
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
  const stop = (failure = false, drain = false): Promise<void> => {
    failed ||= failure;
    if (stopping) return stopping;
    stopped = true;
    stopping = (async () => {
      clearTimeout(monitoring); clearTimeout(deadline);
      callerAudio.stop();
      ctx.room.off(RoomEvent.TrackPublished, callerAudio.subscribe);
      session?.input.setAudioEnabled(false);
      try {
        // Drain allows an already-spoken goodbye to finish. Transport/error shutdown interrupts.
        session?.shutdown({drain});
        await within(session?.close()??Promise.resolve(),6000);
      } catch {
        failed = true;
        session?.output.setAudioEnabled(false);
        void providerSession?.close().catch(()=>{});
      }
      try { await within(transcripts.flush(),7000); } catch { failed = true; }
      try { await control.post('events', {callback: context.callback, type: 'finished', failed}); }
      finally {
        try{await within(ctx.room.disconnect(),2000);}finally{ctx.shutdown('call completed');}
      }
    })();
    return stopping;
  };
  const stopSafely = (failure = false, drain = false) => { void stop(failure, drain).catch(() => { console.error('Call shutdown did not confirm persistence'); }); };
  ctx.addShutdownCallback(async () => { await stop(); });
  class CheckedModel extends realtime.GPTLiveModel {
    override session(): realtime.GPTLiveSession {
      const duplex = super.session();
      providerSession=duplex;
      duplex.on('input_audio_transcription_completed', event => {
        if (event.itemId) void transcripts.record({id: event.itemId, role: 'caller', text: event.transcript, final: event.isFinal, createdAt: event.turnStartedAt}).catch(() => stopSafely(true));
      });
      duplex.on('error', () => stopSafely(true));
      duplex.on('openai_server_event_received', event => {
        if (event.type === 'session.started' && !acceptedEcho(event.session, context.voice)) stopSafely(true);
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
      adapted.on('generation_created',event=>observeGeneration(event,(id,text)=>{
        void transcripts.record({id,role:'assistant',text,final:false}).catch(()=>stopSafely(true));
      }));
      return adapted;
    }
  }
  session = new voice.AgentSession({llm: new TranscriptAdapter(model)});
  session.on(voice.AgentSessionEventTypes.Error, () => stopSafely(true));
  session.on(voice.AgentSessionEventTypes.Close, () => { if (!stopped) stopSafely(true); });
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, event => {
    const item = event.item;
    if (item.type !== 'message' || !['user', 'assistant'].includes(item.role) || !item.textContent) return;
    void transcripts.record({id: item.id, role: item.role === 'user' ? 'caller' : 'assistant', text: item.textContent, final: true, createdAt: item.createdAt}).catch(() => stopSafely(true));
  });
  let closingRequested=false;
  const endCall = llm.tool({name: 'end_call', description: 'End a completed conversation only after saying a polite goodbye.',
    parameters: {type: 'object', properties: {}, additionalProperties: false},
    execute: async () => {
      // Return from the function before draining the activity that owns this function.
      if(!closingRequested){
        closingRequested=true;
        setTimeout(()=>{void (async()=>{
          if(stopped)return;
          try{
            // A control acknowledgement is not a spoken goodbye. Request and drain actual speech.
            await within(session!.generateReply({instructions:'The conversation is complete. Say one brief polite goodbye in the caller’s language, without questions, new business facts or tools.'}).waitForPlayout(),15000);
            if(!stopped)await stop(false,true);
          }catch{stopSafely(true);}
        })();},0);
      }
      return 'Say a brief polite goodbye; closure will follow audio completion.';
    },
  });
  const agent = new voice.Agent({instructions: `${context.instructions}\n\nSpeak ${context.language}. Start by greeting the caller: ${context.greeting}\nWhen the conversation is finished, say a polite goodbye before delegating end_call. Never announce internal technology.`, tools: new llm.ToolContext([endCall])});
  const sentCommands=new Set<string>();
  const monitor = async () => {
    if (stopped) return;
    try {
      const current=await control.context();
      for(const command of current.commands??[]){
        if(stopped||closingRequested)break;
        // Admit once before generation. Ambiguous delivery ends the call, never replays inference.
        await control.post('events',{callback:context.callback,type:'command_ack',commandId:command.id});
        if(stopped||sentCommands.has(command.id))continue;
        sentCommands.add(command.id);
        await transcripts.record({id:command.id,role:'caller',text:command.text,final:true});
        if(!stopped)session!.generateReply({userInput:new llm.ChatMessage({id:command.id,role:'user',content:[command.text]})});
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
    monitoring = setTimeout(() => void monitor(), 2000);
    session.generateReply({instructions: `Greet the caller now with: ${context.greeting}`});
  } catch { await stop(true); }
}});
