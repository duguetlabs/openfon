/** Host-independent, credential-free assistant recipe. No account or provider connection is transferable. */
export const ASSISTANT_RECIPE_FORMAT = 'openfon-assistant';
export const ASSISTANT_RECIPE_MAX_BYTES = 64 * 1024;

export interface AssistantRecipeFields {
  name: string;
  greeting: string;
  persona: string;
  language: string;
  voice: string;
  take_messages: number;
  custom_instructions: string;
  engine: string;
  realtime_model: string;
  realtime_voice: string;
  llm_model: string;
}

export interface AssistantRecipe {
  format: typeof ASSISTANT_RECIPE_FORMAT;
  version: 1;
  assistant: Omit<AssistantRecipeFields, 'take_messages'> & { take_messages: boolean };
}

const LIMITS = {
  name: 100, greeting: 8192, persona: 8192, language: 64, voice: 256,
  custom_instructions: 32768, engine: 16, realtime_model: 256, realtime_voice: 256, llm_model: 256,
} as const;
const FIELDS = [...Object.keys(LIMITS), 'take_messages'];
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const exactFields = (value: Record<string, unknown>, fields: string[]) => {
  if (Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !fields.includes(key))) {
    throw new Error('Recipe fields do not match version 1. Use an OpenFon assistant recipe, without credentials or workspace data.');
  }
};

export function parseAssistantRecipe(text: string): AssistantRecipe {
  if (new TextEncoder().encode(text).byteLength > ASSISTANT_RECIPE_MAX_BYTES) {
    throw new Error('The recipe is too large. Choose a JSON file of 64 KiB or less.');
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('The file is not valid JSON. Choose an exported OpenFon assistant recipe.'); }
  if (!object(value) || value.format !== ASSISTANT_RECIPE_FORMAT || value.version !== 1) {
    throw new Error('Unsupported recipe format or version. Choose an OpenFon assistant recipe, version 1.');
  }
  exactFields(value, ['format', 'version', 'assistant']);
  if (!object(value.assistant)) throw new Error('The recipe must contain one assistant configuration.');
  const assistant = value.assistant;
  exactFields(assistant, FIELDS);
  for (const [field, maximum] of Object.entries(LIMITS)) {
    if (typeof assistant[field] !== 'string' || (assistant[field] as string).length > maximum) {
      throw new Error(`Recipe ${field} must be text of at most ${maximum} characters.`);
    }
  }
  for (const field of ['name', 'persona', 'language']) {
    if (!(assistant[field] as string).trim()) throw new Error(`Recipe ${field} cannot be blank.`);
  }
  if (assistant.engine !== 'realtime' && assistant.engine !== 'pipeline') throw new Error('Recipe engine must be realtime or pipeline.');
  if (typeof assistant.take_messages !== 'boolean') throw new Error('Recipe take_messages must be true or false.');
  return value as unknown as AssistantRecipe;
}

export function exportAssistantRecipe(assistant: AssistantRecipeFields): string {
  // Explicit allowlist: never serialize an assistant response or an arbitrary spread.
  const recipe: AssistantRecipe = {
    format: ASSISTANT_RECIPE_FORMAT,
    version: 1,
    assistant: {
      name: assistant.name, greeting: assistant.greeting, persona: assistant.persona,
      language: assistant.language, voice: assistant.voice, take_messages: Boolean(assistant.take_messages),
      custom_instructions: assistant.custom_instructions, engine: assistant.engine,
      realtime_model: assistant.realtime_model, realtime_voice: assistant.realtime_voice, llm_model: assistant.llm_model,
    },
  };
  const text = JSON.stringify(recipe, null, 2);
  parseAssistantRecipe(text);
  return text;
}

/** Keeping destination voice settings also keeps its language, engine and model selections. */
export function assistantRecipePatch(recipe: AssistantRecipe, includeVoice = true): Partial<AssistantRecipeFields> {
  const a = recipe.assistant;
  const behavior = {
    name: a.name, greeting: a.greeting, persona: a.persona,
    custom_instructions: a.custom_instructions, take_messages: a.take_messages ? 1 : 0,
  };
  return includeVoice ? { ...behavior, language: a.language, voice: a.voice, engine: a.engine,
    realtime_model: a.realtime_model, realtime_voice: a.realtime_voice, llm_model: a.llm_model } : behavior;
}
