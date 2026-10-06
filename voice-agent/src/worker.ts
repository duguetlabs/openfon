import { configureSdkLogging } from './logging.js';
import {UsageOutbox} from './usage-outbox.js';
import {AzureUsageCapture} from './usage.js';
import {defineAgent, voice, llm, AutoSubscribe, type JobContext} from '@livekit/agents';
import {PendingTypedInput,submitTypedInput} from './typed-input.js';
import {realtime} from '@livekit/agents-plugin-openai';
import {RoomEvent, TrackSource, type RemoteTrackPublication} from '@livekit/rtc-node';
import {createCallerAudioSubscription} from './caller-audio.js';
import {TranscriptBridge} from './transcript-bridge.js';
import {within} from './deadline.js';
import {ControlClient, AdmissionError} from './control.js';
import {observeGeneration} from './stream-transcripts.js';
import {ClockedGPTLiveSession} from './clocked-session.js';
import {ToolClosure} from './tool-closure.js';
import {FarewellPair,finishCurrentFarewell} from './farewell.js';
import {acceptedEcho, modelOptions, operatorAzureConfig, operatorVoiceModel, assertVoicePairing} from './config.js';
import {VoiceDiagnostics} from './diagnostics.js';
import {ProviderReadiness} from './provider-readiness.js';
import {MiniModel,MiniSession} from './mini-model.js';
import {speechOutcome,successfulPlayout,responseUnavailable} from './playout.js';

export default defineAgent({entry: async (ctx: JobContext) => {
  configureSdkLogging();
  const metadata = JSON.parse(ctx.job.metadata || '{}') as {callId?: string};
  const control = new ControlClient(process.env.OPENFON_API_URL!, process.env.OPENFON_AGENT_SERVICE_TOKEN!, metadata.callId || '', ctx.job.room?.name || ctx.room.name || '', ctx.job.id);
  const context = await control.context();
  assertVoicePairing(context);
  const telemetry=new VoiceDiagnostics(context.callId,record=>console.info(JSON.stringify(record)));
  telemetry.phase('startup');
  let diagnosticTimer:ReturnType<typeof setInterval>|undefined;
  let session: voice.AgentSession | undefined;
  let latestSpeech:voice.SpeechHandle|undefined;
  let providerSession:ClockedGPTLiveSession|undefined;
  let miniSession:MiniSession|undefined;
  const mini=operatorVoiceModel()==='gpt-realtime-2.1-mini';
  const toolClosure=new ToolClosure();
  const pendingTyped=new PendingTypedInput();
  const providerReady=new ProviderReadiness();
  const firstSpeech=new ProviderReadiness();
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
  const diagnostic=(phase:string)=>console.info(JSON.stringify({event:'openfon_voice_lifecycle',callId:context.callId,phase}));
  const stop = (failure = false, drain = false): Promise<void> => {
    failed ||= failure;
    if (stopping) return stopping;
    stopped = true;
    miniSession?.invalidateReasoning();
    pendingTyped.close();
    providerReady.close();
    firstSpeech.close();
    clearInterval(diagnosticTimer);
    diagnostic(failure?'failure_stop':'normal_stop');
    stopping = (async () => {
      clearTimeout(monitoring); clearTimeout(deadline);
      providerSession?.stopInputClock();
      const subscriptionsStopped=callerAudio.stop();
      if(!subscriptionsStopped)diagnostic('unsubscribe_already_closed');
      ctx.room.off(RoomEvent.TrackPublished, callerAudio.subscribe);
      try{session?.input.setAudioEnabled(false);}catch{if(ctx.room.isConnected)failed=true;diagnostic('input_already_closed');}
      let mediaStopped = false;
      try {
        // Drain allows an already-spoken goodbye to finish. Transport/error shutdown interrupts.
        session?.shutdown({drain});
        await within(session?.close()??Promise.resolve(),6000);
        mediaStopped = true;
        diagnostic('session_closed');
      } catch {
        failed = true;
        diagnostic('session_close_deadline');
        try{session?.output.setAudioEnabled(false);}catch{/* native output may already be closed */}
        void providerSession?.close().catch(()=>{});
        // Muting alone is not proof of transport shutdown. Disconnect before ending service.
        try {
          await within(ctx.room.disconnect(),2000);
          mediaStopped = true;
          diagnostic('room_disconnected');
        } catch { diagnostic('media_stop_unconfirmed'); }
      }
      if (mediaStopped) {
        try {
          await control.post('events', {callback: context.callback, type: 'service_stopped'});
        } catch { diagnostic('service_stop_unconfirmed'); }
      }
      usage.finish();
      try { await within(outbox.flushPersistence(),7000); diagnostic('usage_journal_flushed'); }
      catch { failed=true; diagnostic('usage_journal_unconfirmed'); }
      try { await within(usage.flush(),7000); diagnostic('usage_flushed'); } catch { failed=true; diagnostic('usage_unconfirmed'); }
      try { await within(transcripts.flush(),7000); diagnostic('transcripts_flushed'); } catch { failed = true; diagnostic('transcripts_failed'); }
      try {
        // Preserve server stale-call reconciliation when shutdown could not be confirmed.
        // Neither a service cutoff nor finalized accounting may assert a fictitious end.
        if (mediaStopped) {
          await control.post('events', {callback: context.callback, type: 'finished', failed});
          diagnostic('finished_acknowledged');
        } else diagnostic('finished_deferred_media_uncertain');
      }
      catch(error){diagnostic(error instanceof AdmissionError?'finished_rejected':'finished_unavailable');throw error;}
      finally {
        telemetry.snapshot(true);
        try{await within(ctx.room.disconnect(),2000);}finally{ctx.shutdown('call completed');}
      }
    })();
    return stopping;
  };
  const stopSafely = (failure = false, drain = false) => { void stop(failure, drain).catch(() => { console.error('Call shutdown did not confirm persistence'); }); };
  ctx.addShutdownCallback(async () => { await stop(); });
  const outbox = new UsageOutbox(
    process.env.OPENFON_USAGE_DIR!,
    process.env.OPENFON_API_URL!,
    process.env.OPENFON_AGENT_SERVICE_TOKEN!
  );
  const usage = new AzureUsageCapture(
    context.callId,
    ctx.job.id,
    (observation) =>
      outbox.send({
        callId: context.callId,
        room: context.room,
        jobId: ctx.job.id,
        callback: context.callback,
        observation,
      }),
    () => stopSafely(true), mini
  );
  const farewell=new FarewellPair(stillCurrent=>{
    diagnostic('paired_farewell');
    void (async()=>{
      if(!await pendingTyped.waitUntilIdle()||stopped||!stillCurrent()||miniSession?.reasoningPending)return;
      const responseRevision=miniSession?.failureRevision;
      await finishCurrentFarewell(async()=>{
        const speech=latestSpeech;
        if(!speech)throw Error('Farewell playout unavailable');
        return await within(successfulPlayout(speech),15000)&&responseRevision===miniSession?.failureRevision;
      },()=>!stopped&&pendingTyped.idle&&!miniSession?.reasoningPending&&stillCurrent(),()=>stopSafely(false,true),()=>stopSafely(true));
    })();
  });
  class CheckedModel extends realtime.GPTLiveModel {
    override session(): realtime.GPTLiveSession {
      const duplex = new ClockedGPTLiveSession(this,()=>stopSafely(true),{
        idleFrame:()=>telemetry.count('idle_frame_forwarded'),replyAuthorized:()=>telemetry.phase('reply_authorized'),
      });
      providerSession=duplex;
      duplex.on('input_audio_transcription_completed', event => {
        if(event.itemId){toolClosure.observe(event.itemId,event.transcript,event.isFinal);farewell.record('caller',event.itemId,event.transcript,event.isFinal);}
        if (event.itemId) void transcripts.record({id: event.itemId, role: 'caller', text: event.transcript, final: event.isFinal, createdAt: event.turnStartedAt}).catch(() => stopSafely(true));
      });
      duplex.on('error', () => stopSafely(true));
      duplex.on('openai_client_event_queued',event=>telemetry.count(event.type));
      duplex.on('openai_server_event_received', event => {
        telemetry.count(event.type);
        usage.observe(event);
        if(event.type==='session.started'){
          if(!acceptedEcho(event.session,context.voice))stopSafely(true);
          else if(!stopped){telemetry.phase('session_started');providerReady.accept();duplex.startInputClock();}
        }
        if (event.type === 'error') stopSafely(true);
        if (event.type === 'session.closed' && !stopped) stopSafely(true);
      });
      return duplex;
    }
  }
  const legacyModel = () => new CheckedModel({...modelOptions(context, operatorAzureConfig()), delegation: 'responses', connOptions: {timeoutMs: 10000, maxRetry: 0, retryIntervalMs: 1000}});
  class TranscriptAdapter extends llm.DuplexRealtimeAdapter {
    override session() {
      const adapted=super.session();
      adapted.on('generation_created',()=>telemetry.phase('generation_created'));
      adapted.on('generation_created',event=>observeGeneration(event,(id,text)=>{
        void transcripts.record({id,role:'assistant',text,final:false}).catch(()=>stopSafely(true));
      },()=>{if(!stopped&&firstSpeech.accept())telemetry.phase('first_speech');}));
      return adapted;
    }
  }
  class CheckedMini extends MiniModel {
    override session(){
      const current=super.session();miniSession=current;
      current.on('ready',()=>{telemetry.phase('session_started');providerReady.accept();});
      current.on('provider_event',event=>usage.observe(event));
      current.on('usage_unreported',()=>usage.finish());
      current.on('reasoning_usage',({sessionId,response})=>usage.observe({type:'response.event',providerSessionId:sessionId,event:{type:'response.'+response.status,response}}));
      current.on('input_audio_transcription_completed',event=>{
        toolClosure.observe(event.itemId,event.transcript,event.isFinal);farewell.record('caller',event.itemId,event.transcript,event.isFinal);
        void transcripts.record({id:event.itemId,role:'caller',text:event.transcript,final:event.isFinal}).catch(()=>stopSafely(true));
      });
      current.on('generation_created',event=>observeGeneration(event,(id,text)=>{void transcripts.record({id,role:'assistant',text,final:false}).catch(()=>stopSafely(true));},()=>{if(!stopped&&firstSpeech.accept())telemetry.phase('first_speech');}));
      current.on('input_speech_started',()=>{toolClosure.cancel();farewell.invalidate();});
      current.on('interrupted',()=>{toolClosure.cancel();farewell.invalidate();if(!stopped)void session?.interrupt().await.catch(()=>stopSafely(true));});
      current.on('warning',code=>{if(!stopped)void control.post('events',{callback:context.callback,type:'warning',code}).catch(()=>diagnostic('warning_unconfirmed'));});
      current.on('diagnostic',code=>console.info(JSON.stringify({event:'openfon_voice_lifecycle',callId:context.callId,phase:code})));
      current.on('error',()=>stopSafely(true));
      return current;
    }
  }
  const configuredModel=mini?new CheckedMini({...operatorAzureConfig(),context}):new TranscriptAdapter(legacyModel());
  session = new voice.AgentSession({llm: configuredModel,...(mini?{vad:null,turnDetection:'realtime_llm' as const}: {})});
  session.on(voice.AgentSessionEventTypes.SpeechCreated,event=>{telemetry.phase('speech_created');latestSpeech=event.speechHandle;});
  session.on(voice.AgentSessionEventTypes.Error, event => {if(!mini||!responseUnavailable(event.error))stopSafely(true);});
  session.on(voice.AgentSessionEventTypes.Close, () => { if (!stopped) stopSafely(true); });
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, event => {
    const item = event.item;
    if (item.type !== 'message' || !['user', 'assistant'].includes(item.role) || !item.textContent) return;
    if(item.role==='user')toolClosure.observe(item.id,item.textContent,true);
    else if(!item.interrupted)miniSession?.confirmPlayback(item.id,item.textContent);
    farewell.record(item.role==='user'?'caller':'assistant',item.id,item.textContent,true);
    void transcripts.record({id: item.id, role: item.role === 'user' ? 'caller' : 'assistant', text: item.textContent, final: true, createdAt: item.createdAt}).catch(() => stopSafely(true));
  });
  const endCall = llm.tool({name: 'end_call', description: 'End a completed conversation by scheduling a brief spoken goodbye, then disconnecting after it plays.',
    parameters: {type: 'object', properties: {}, additionalProperties: false},
    execute: async () => {
      // Return from the function before draining the activity that owns this function.
      if(miniSession&&!miniSession.prepareClosure())return 'Finish the pending caller request before ending the call.';
      const ticket=toolClosure.begin();
      if(ticket){
        diagnostic('end_call_requested');
        setTimeout(()=>{void (async()=>{
          try{
            if(!await pendingTyped.waitUntilIdle()||stopped||!toolClosure.current(ticket))return;
            // A control acknowledgement is not a spoken goodbye. Request and drain actual speech.
            const responseRevision=miniSession?.failureRevision;
            const played=await within(successfulPlayout(session!.generateReply({...(mini?{toolChoice:'none' as const}:{}),instructions:'The conversation is complete. Say one brief polite goodbye in the caller’s language, without questions, new business facts or tools.'})),15000);
            if(played&&responseRevision===miniSession?.failureRevision&&!stopped&&pendingTyped.idle&&toolClosure.current(ticket))await stop(false,true);
          }catch{if(!stopped&&pendingTyped.idle&&toolClosure.current(ticket))stopSafely(true);}
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
      // Reserve the entire received batch before an acknowledgement can yield
      // to an older SDK goodbye. SDK callbacks may arrive during each await.
      for(const command of current.commands??[]){if(!sentCommands.has(command.id))pendingTyped.admit(command.id);}
      for(const command of current.commands??[]){
        if(stopped)break;
        // New admitted text cancels a pending goodbye before its fallible acknowledgement.
        miniSession?.invalidateReasoning();
        toolClosure.observe(command.id,command.text,true);
        farewell.record('caller',command.id,command.text,false);
        // Admit once before generation. Ambiguous delivery ends the call, never replays inference.
        await control.post('events',{callback:context.callback,type:'command_ack',commandId:command.id});
        if(stopped||sentCommands.has(command.id))continue;
        sentCommands.add(command.id);
        // SDK ConversationItemAdded is the sole persisted identity for typed input.
        // It appends the command when its own queued generation is authorized.
        if(!stopped)pendingTyped.track(command.id,submitTypedInput(session!,command),()=>stopSafely(true));
      }
    } catch (error) { stopSafely(!(error instanceof AdmissionError && [404,410].includes(error.status))); return; }
    if (!stopped) monitoring = setTimeout(() => void monitor(), 2000);
  };
  try {
    await outbox.assertAvailable();
    diagnosticTimer=setInterval(()=>telemetry.snapshot(),10000);
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
    telemetry.phase('session_starting');
    await within(session.start({agent, room: ctx.room, record: false, ...(mini?{outputOptions:{audioSampleRate:24000,queueSizeMs:100}}:{}), inputOptions: {closeOnDisconnect: false, deleteRoomOnClose: false, textEnabled: false, participantIdentity: context.caller}}),15000);
    telemetry.phase('agent_session_started');
    if (stopped) { await session.close(); return; }
    if(!await providerReady.wait(15000)||stopped)return;
    monitoring = setTimeout(() => void monitor(), 2000);
    const greeting=session.generateReply({instructions: `Greet the caller now with: ${context.greeting}`});
    telemetry.phase('greeting_queued');
    void speechOutcome(greeting).then(outcome=>telemetry.phase(`greeting_request_${outcome}`));
    // Keep the Durable Object's existing 90s startup deadline armed. The
    // monitor observes its expiry/account loss; stop releases this latch.
    if(!await firstSpeech.wait()||stopped)return;
    await control.post('events',{callback:context.callback,type:'ready'});
    telemetry.phase('readiness_ack');
  } catch { await stop(!stopped); }
}});
