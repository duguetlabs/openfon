import { describe, expect, it } from 'vitest';
import { ASSISTANT_RECIPE_MAX_BYTES, assistantRecipePatch, exportAssistantRecipe, parseAssistantRecipe } from '../web/src/assistant-config';

const assistant = {
  id: 'source-assistant', business_id: 'source-business', public_slug: 'private-line', state: 'active',
  collectionIds: ['foreign-knowledge'], apiKey: 'not-a-real-key', realtime_api_key: 'also-not-a-key',
  realtime_base_url: 'https://example.invalid/private',
  name: 'Front desk', greeting: 'Guten Tag!', persona: 'A helpful receptionist.', language: 'de-DE',
  voice: 'de-DE-SeraphinaMultilingualNeural', take_messages: 1, custom_instructions: 'Ask before recording a callback number.',
  engine: 'realtime', realtime_model: 'gpt-live-1', realtime_voice: 'marin', llm_model: 'gpt-5.4-mini',
};

describe('portable assistant recipes', () => {
  it('round-trips behavior and model/voice selections while excluding ownership, connections and credentials', () => {
    const text = exportAssistantRecipe(assistant);
    const recipe = parseAssistantRecipe(text);
    expect(assistantRecipePatch(recipe)).toEqual({
      name: assistant.name, greeting: assistant.greeting, persona: assistant.persona, language: assistant.language,
      voice: assistant.voice, take_messages: 1, custom_instructions: assistant.custom_instructions, engine: assistant.engine,
      realtime_model: assistant.realtime_model, realtime_voice: assistant.realtime_voice, llm_model: assistant.llm_model,
    });
    for (const excluded of ['source-assistant', 'source-business', 'private-line', 'foreign-knowledge', 'not-a-real-key', 'also-not-a-key', 'example.invalid']) {
      expect(text).not.toContain(excluded);
    }
  });

  it('can retain destination language, engine and model/voice choices during a cross-provider import', () => {
    const destination = { ...assistant, id: 'destination', language: 'en', engine: 'pipeline', realtime_model: '', realtime_voice: '', llm_model: 'local/model', collectionIds: ['local-knowledge'] };
    const patch = assistantRecipePatch(parseAssistantRecipe(exportAssistantRecipe(assistant)), false);
    const imported = { ...destination, ...patch };
    expect(imported.id).toBe('destination');
    expect(imported.collectionIds).toEqual(['local-knowledge']);
    expect(imported.language).toBe('en');
    expect(imported.engine).toBe('pipeline');
    expect(imported.llm_model).toBe('local/model');
    expect(imported.greeting).toBe(assistant.greeting);
    expect(patch).not.toHaveProperty('realtime_voice');
  });

  it('preserves blank defaults and custom provider model namespaces', () => {
    const recipe = parseAssistantRecipe(exportAssistantRecipe({ ...assistant, realtime_model: '', realtime_voice: '', llm_model: 'my-org/model:v2', take_messages: 0 }));
    expect(recipe.assistant.take_messages).toBe(false);
    expect(assistantRecipePatch(recipe)).toMatchObject({ take_messages: 0, realtime_model: '', realtime_voice: '', llm_model: 'my-org/model:v2' });
  });

  it.each(['apiKey', 'realtime_api_key', 'llm_base_url', 'collectionIds', 'id', '__proto__'])('rejects unexpected %s fields rather than forwarding them', field => {
    const recipe = JSON.parse(exportAssistantRecipe(assistant));
    Object.defineProperty(recipe.assistant, field, { value: 'injected', enumerable: true });
    expect(() => parseAssistantRecipe(JSON.stringify(recipe))).toThrow('fields do not match');
  });

  it.each([
    { version: 2 }, { version: '1' }, { format: 'account-export' }, { assistant: [] }, { extra: 'field' },
  ])('rejects incompatible envelopes: %j', patch => {
    expect(() => parseAssistantRecipe(JSON.stringify({ ...JSON.parse(exportAssistantRecipe(assistant)), ...patch }))).toThrow();
  });

  it.each([
    { take_messages: 1 }, { take_messages: 'false' }, { persona: '  ' }, { name: '' }, { language: '  ' },
    { name: 'x'.repeat(101) }, { engine: 'arbitrary' }, { greeting: {} }, { realtime_model: null },
  ])('rejects invalid fields: %j', patch => {
    const recipe = JSON.parse(exportAssistantRecipe(assistant));
    recipe.assistant = { ...recipe.assistant, ...patch };
    expect(() => parseAssistantRecipe(JSON.stringify(recipe))).toThrow();
  });

  it('rejects missing fields, malformed JSON, null and arrays', () => {
    const recipe = JSON.parse(exportAssistantRecipe(assistant));
    delete recipe.assistant.voice;
    for (const text of [JSON.stringify(recipe), 'null', '[]', '{bad']) expect(() => parseAssistantRecipe(text)).toThrow();
  });

  it('bounds encoded bytes including multibyte text and never echoes file values in an error', () => {
    expect(() => parseAssistantRecipe('x'.repeat(ASSISTANT_RECIPE_MAX_BYTES + 1))).toThrow('too large');
    expect(() => exportAssistantRecipe({ ...assistant, custom_instructions: '🙂'.repeat(16384) })).toThrow('too large');
    const recipe = JSON.parse(exportAssistantRecipe(assistant));
    recipe.assistant.take_messages = 'private-content';
    expect(() => parseAssistantRecipe(JSON.stringify(recipe))).toThrow('take_messages must be true or false');
  });
});
