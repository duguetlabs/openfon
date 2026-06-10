// Pluggable AI providers. LLM and STT speak the OpenAI-compatible wire format,
// so OpenFon works with Kataleptic (default), OpenAI, Azure OpenAI, Groq, Ollama,
// vLLM, or anything else that implements /chat/completions and /audio/transcriptions.
import type { Env, AgentSettings, ChatMessage, LlmConfig } from './types';

export function resolveLlm(env: Env, settings: AgentSettings | null): LlmConfig {
  return {
    baseUrl: settings?.llm_base_url || env.DEFAULT_LLM_BASE_URL,
    apiKey: settings?.llm_api_key || env.DEFAULT_LLM_API_KEY || '',
    model: settings?.llm_model || env.DEFAULT_LLM_MODEL,
  };
}

export async function chatComplete(
  cfg: LlmConfig,
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number; json?: boolean } = {}
): Promise<string> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      max_tokens: opts.maxTokens ?? 300,
      temperature: opts.temperature ?? 0.6,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return data.choices[0]?.message?.content ?? '';
}

// Languages OpenFon speaks. Keys are ISO 639-1; values are Azure neural voices.
export const SUPPORTED_LANGUAGES: Record<string, { name: string; voice: string }> = {
  en: { name: 'English', voice: 'en-US-JennyNeural' },
  de: { name: 'German', voice: 'de-DE-KatjaNeural' },
  fr: { name: 'French', voice: 'fr-FR-DeniseNeural' },
  es: { name: 'Spanish', voice: 'es-ES-ElviraNeural' },
  nl: { name: 'Dutch', voice: 'nl-NL-FennaNeural' },
  sv: { name: 'Swedish', voice: 'sv-SE-SofieNeural' },
  da: { name: 'Danish', voice: 'da-DK-ChristelNeural' },
  it: { name: 'Italian', voice: 'it-IT-ElsaNeural' },
  fi: { name: 'Finnish', voice: 'fi-FI-NooraNeural' },
  ru: { name: 'Russian', voice: 'ru-RU-SvetlanaNeural' },
};

// STT backends report language as ISO codes ("de") or names ("german").
const LANG_ALIASES: Record<string, string> = {
  english: 'en', german: 'de', french: 'fr', spanish: 'es', dutch: 'nl',
  swedish: 'sv', danish: 'da', italian: 'it', finnish: 'fi', russian: 'ru',
};

export function normalizeLang(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const l = raw.toLowerCase().trim();
  if (l in SUPPORTED_LANGUAGES) return l;
  if (l in LANG_ALIASES) return LANG_ALIASES[l];
  const short = l.slice(0, 2);
  return short in SUPPORTED_LANGUAGES ? short : null;
}

export interface Transcription {
  text: string;
  language: string | null;
}

// Language is auto-detected per utterance so callers can speak any supported
// language regardless of the business's configured default.
export async function transcribe(env: Env, audio: ArrayBuffer, contentType: string): Promise<Transcription> {
  const form = new FormData();
  const ext = contentType.includes('mp4') ? 'mp4' : contentType.includes('wav') ? 'wav' : 'webm';
  form.append('file', new Blob([audio], { type: contentType }), `utterance.${ext}`);
  form.append('model', env.DEFAULT_STT_MODEL);
  const res = await fetch(`${env.DEFAULT_STT_BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.DEFAULT_STT_API_KEY || ''}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`STT error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { text: string; language?: string };
  return { text: (data.text ?? '').trim(), language: normalizeLang(data.language) };
}

// Pick the voice for a reply: the business's custom voice only applies to its
// own default language; replies in other languages get the matching neural voice.
export function voiceForReply(env: Env, lang: string, defaultLang: string, customVoice: string): string {
  if (customVoice && lang === defaultLang) return customVoice;
  return SUPPORTED_LANGUAGES[lang]?.voice ?? env.DEFAULT_TTS_VOICE;
}

// Azure Speech TTS via REST. Returns MP3 bytes, or null when TTS is configured
// for browser mode (client falls back to speechSynthesis).
export async function synthesize(env: Env, text: string, voice: string): Promise<ArrayBuffer | null> {
  if (env.DEFAULT_TTS_PROVIDER !== 'azure' || !env.AZURE_SPEECH_KEY) return null;
  const v = voice || env.DEFAULT_TTS_VOICE;
  const lang = v.split('-').slice(0, 2).join('-') || 'en-US';
  const ssml = `<speak version='1.0' xml:lang='${lang}'><voice name='${v}'>${escapeXml(text)}</voice></speak>`;
  const res = await fetch(`https://${env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'openfon',
    },
    body: ssml,
  });
  if (!res.ok) {
    console.error(`TTS error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  return res.arrayBuffer();
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}
