import {TransformStream} from 'node:stream/web';
import {llm, voice} from '@livekit/agents';
/** Observe the SDK's real generation IDs, preserving the text/audio streams unchanged.
 * Raw GPT-Live output deltas have no stable ID; they must never invent final rows. */
export function observeGeneration(event: llm.GenerationCreatedEvent, partial: (id:string,text:string)=>void): void {
  event.messageStream=event.messageStream.pipeThrough(new TransformStream({transform(message:llm.MessageGeneration,controller){
    let text='';
    message.textStream=message.textStream.pipeThrough(new TransformStream({transform(chunk,output){
      text+=voice.isTimedString(chunk)?chunk.text:chunk;
      partial(message.messageId,text);
      output.enqueue(chunk);
    }}));
    controller.enqueue(message);
  }}));
}
