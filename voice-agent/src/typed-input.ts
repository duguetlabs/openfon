import type {voice} from '@livekit/agents';

/** Let the SDK associate a queued reply with its own user item. The command ID
 * governs delivery; ConversationItemAdded supplies the single transcript ID. */
export function submitTypedInput(
  session: Pick<voice.AgentSession, 'generateReply'>,
  command: {id: string; text: string},
): voice.SpeechHandle {
  return session.generateReply({userInput: command.text});
}
