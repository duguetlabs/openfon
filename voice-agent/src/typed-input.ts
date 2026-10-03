import {llm, type voice} from '@livekit/agents';

/** Preserve the admitted command ID through the SDK's append-only chat context.
 * generateReply({userInput}) currently converts ChatMessage to a string and
 * manufactures a second ID on its realtime path. */
export async function appendTypedInput(
  agent: Pick<voice.Agent, 'updateChatCtx'>,
  liveContext: llm.ChatContext,
  command: {id: string; text: string},
): Promise<void> {
  // The live adapter includes in-flight speech and tool items that may not yet
  // have reached Agent.chatCtx's completed conversation view.
  const context = liveContext.copy();
  const existing = context.getById(command.id);
  if (existing) {
    if (existing.type !== 'message' || existing.role !== 'user' || existing.textContent !== command.text) {
      throw new Error('Typed command identity changed');
    }
    return;
  }
  context.insert(new llm.ChatMessage({id: command.id, role: 'user', content: [command.text]}));
  await agent.updateChatCtx(context);
}
