// Pluggable AI providers. LLM and STT speak the OpenAI-compatible wire format,
// so OpenFon works with Kataleptic (default), OpenAI, Azure OpenAI, Groq, Ollama,
// vLLM, or anything else that implements /chat/completions and /audio/transcriptions.
import type { Env, AgentSettings, ChatMessage, LlmConfig } from './types';

// Raised when a business's AI-provider settings cannot be turned into a usable
// config. Callers surface the message to the user instead of failing opaquely.
export class LlmConfigError extends Error {}

// Two base URLs mean the same endpoint if only a trailing slash or host casing
// differs — otherwise "https://api.host/v1/" would count as a custom endpoint
// and lose the instance key for no reason.
export function sameLlmEndpoint(a: string, b: string): boolean {
  const norm = (u: string) => {
    try {
      const p = new URL(u.trim());
      return `${p.protocol}//${p.host}${p.pathname.replace(/\/+$/, '')}`;
    } catch {
      return u.trim().replace(/\/+$/, '');
    }
  };
  return norm(a) === norm(b);
}

// The credential travels with the endpoint. A business may point its agent at
// its own OpenAI-compatible server, but then only the key stored next to that
// URL is ever sent: falling back to DEFAULT_LLM_API_KEY here would hand the
// instance's key to whatever host the business typed into Settings.
export function resolveLlm(env: Env, settings: AgentSettings | null): LlmConfig {
  const custom = (settings?.llm_base_url ?? '').trim();
  const model = settings?.llm_model || env.DEFAULT_LLM_MODEL;
  if (!custom || sameLlmEndpoint(custom, env.DEFAULT_LLM_BASE_URL)) {
    return {
      baseUrl: custom || env.DEFAULT_LLM_BASE_URL,
      apiKey: settings?.llm_api_key || env.DEFAULT_LLM_API_KEY || '',
      model,
    };
  }
  // Rows written before this rule existed (or edited straight in D1) are
  // re-checked here, so a stale endpoint can't outlive the policy.
  const rejected = validateLlmBaseUrl(custom, env.ALLOWED_LLM_HOSTS);
  if (rejected) throw new LlmConfigError(`LLM base URL ${rejected}`);
  if (!settings?.llm_api_key) {
    throw new LlmConfigError('A custom LLM base URL needs its own API key — this instance never sends its key to another endpoint.');
  }
  return { baseUrl: custom, apiKey: settings.llm_api_key, model };
}

// Literal-IP inspection only: Workers have no DNS resolver, so a hostname that
// *resolves* into private space still gets through. This stops the direct
// http://169.254.169.254/ style probe and keeps honest misconfiguration out;
// it is not a complete SSRF defence.
function isInternalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || // "this network", and 0.0.0.0
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) || // link-local, incl. cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      a >= 224 // multicast, reserved, broadcast
    );
  }
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;
    // IPv4-mapped addresses: the URL parser rewrites ::ffff:127.0.0.1 to
    // ::ffff:7f00:1, so unpack the two hextets and judge the v4 address.
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (mapped) {
      const [hi, lo] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
      return isInternalHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return /^(f[cd]|fe[89ab])/.test(h); // unique-local fc00::/7, link-local fe80::/10
  }
  return false;
}

// Checks a base URL a business supplied for its own LLM endpoint. Returns a
// sentence to append to "LLM base URL …" for the dashboard, or null if it's
// acceptable. Kept here so the write path and the call path agree.
export function validateLlmBaseUrl(raw: string, allowedHosts?: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return 'must be an absolute URL, e.g. https://api.example.com/v1';
  }
  if (url.username || url.password) return 'must not embed credentials — put the key in the API key field';
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const allow = (allowedHosts ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  // An allowlist entry is the operator's own decision, so it also unlocks the
  // one case self-hosters need: plain http to a model running next to
  // `wrangler dev`. Without ALLOWED_LLM_HOSTS the strict rules apply to all.
  if (allow.length) {
    return allow.includes(host) ? null : `host is not permitted on this instance (allowed: ${allow.join(', ')})`;
  }
  if (url.protocol !== 'https:') return 'must use https:// (set ALLOWED_LLM_HOSTS to permit a plain-http host)';
  if (isInternalHost(host)) return 'must not point at a loopback, private, or link-local address';
  return null;
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
// One multilingual voice for all languages by default: the agent keeps a single,
// natural-sounding persona even when the caller switches language mid-call.
const MULTILINGUAL_VOICE = 'en-US-AvaMultilingualNeural';
export const SUPPORTED_LANGUAGES: Record<string, { name: string; voice: string }> = {
  en: { name: 'English', voice: MULTILINGUAL_VOICE },
  de: { name: 'German', voice: MULTILINGUAL_VOICE },
  fr: { name: 'French', voice: MULTILINGUAL_VOICE },
  es: { name: 'Spanish', voice: MULTILINGUAL_VOICE },
  nl: { name: 'Dutch', voice: MULTILINGUAL_VOICE },
  sv: { name: 'Swedish', voice: MULTILINGUAL_VOICE },
  da: { name: 'Danish', voice: MULTILINGUAL_VOICE },
  it: { name: 'Italian', voice: MULTILINGUAL_VOICE },
  fi: { name: 'Finnish', voice: MULTILINGUAL_VOICE },
  ru: { name: 'Russian', voice: MULTILINGUAL_VOICE },
};

// Initial voice per language for Piper-based cascade tiers. The cascade
// follows the *detected* caller language, but before anyone has spoken it
// falls back to English — pinning a language-prefixed voice id sets the
// correct initial pronunciation (greeting, first reply); detection-based
// following continues afterwards. Unknown ids degrade gracefully upstream,
// with the lang_REGION prefix still selecting the language.
// transcription.language seeding is layered on top since Kataleptic's
// 2026-06-13 fix (seed = greeting + STT hint; per-utterance detection wins);
// the voice pin stays as belt-and-braces and for non-Kataleptic providers.
export const PIPER_BY_LANG: Record<string, string> = {
  en: 'en_US-lessac-medium',
  de: 'de_DE-thorsten-medium',
  fr: 'fr_FR-siwis-medium',
  es: 'es_ES-sharvard-medium',
  nl: 'nl_NL-mls-medium',
  sv: 'sv_SE-nst-medium',
  da: 'da_DK-talesyntese-medium',
  it: 'it_IT-paola-medium',
  fi: 'fi_FI-harri-medium',
  ru: 'ru_RU-irina-medium',
};

// Live per-language voice map from the engine's public catalog endpoint
// (<realtime base>/voices), cached per isolate; PIPER_BY_LANG is the fallback
// when the endpoint is missing (self-hosters pointing at other providers).
let piperCatalog: { map: Record<string, string>; fetchedAt: number } | null = null;

export async function piperVoiceFor(env: Env, lang: string): Promise<string> {
  const fallback = PIPER_BY_LANG[lang] ?? '';
  try {
    if (!piperCatalog || Date.now() - piperCatalog.fetchedAt > 3_600_000) {
      const url = env.REALTIME_BASE_URL.replace(/^ws/, 'http') + '/voices';
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const data = (await res.json()) as { 'kataleptic-realtime'?: { voices_by_language?: Record<string, string> } };
        const map = data['kataleptic-realtime']?.voices_by_language;
        if (map && typeof map === 'object') piperCatalog = { map, fetchedAt: Date.now() };
      }
    }
    return piperCatalog?.map[lang] ?? fallback;
  } catch {
    return fallback;
  }
}

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

// Tiny stop-word language detector for realtime mode, where the engine's
// transcription events carry no language field. Returns null when unsure —
// callers should then keep the current language.
const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'is', 'and', 'you', 'what', 'how', 'can', 'do', 'have', 'hello', 'hi', 'thanks', 'please', 'would', 'like', 'want', 'much', 'when', 'are', 'this'],
  de: ['ich', 'nicht', 'und', 'sie', 'das', 'ist', 'ein', 'eine', 'bitte', 'haben', 'wir', 'mit', 'für', 'auf', 'danke', 'gerne', 'termin', 'uhr', 'wie', 'kann', 'möchte', 'noch', 'auch', 'guten'],
  fr: ['je', 'vous', 'est', 'le', 'la', 'les', 'une', 'et', 'bonjour', 'merci', 'avez', 'pour', 'avec', 'que', 'des', 'nous', 'votre', 'oui', 'quel', 'rendez-vous'],
  es: ['el', 'los', 'las', 'es', 'una', 'hola', 'gracias', 'tiene', 'para', 'con', 'que', 'cómo', 'cuánto', 'quiero', 'usted', 'por', 'sí', 'cita', 'buenos', 'días'],
  it: ['il', 'è', 'una', 'ciao', 'grazie', 'avete', 'per', 'con', 'che', 'come', 'quanto', 'vorrei', 'voi', 'sono', 'buongiorno', 'appuntamento', 'quali', 'della'],
  nl: ['ik', 'het', 'een', 'en', 'niet', 'hallo', 'dank', 'hebben', 'voor', 'met', 'wat', 'hoe', 'kan', 'kunt', 'graag', 'jullie', 'bent', 'bedankt', 'afspraak', 'goedemorgen'],
  sv: ['jag', 'det', 'ett', 'och', 'är', 'inte', 'hej', 'tack', 'har', 'för', 'med', 'vad', 'hur', 'kan', 'vill', 'ni', 'gärna', 'finns', 'tid', 'boka'],
  da: ['jeg', 'det', 'et', 'og', 'er', 'ikke', 'hej', 'tak', 'har', 'for', 'med', 'hvad', 'hvordan', 'kan', 'vil', 'gerne', 'findes', 'tid', 'bestille', 'jeres'],
  fi: ['minä', 'on', 'ja', 'ei', 'hei', 'kiitos', 'onko', 'voinko', 'haluan', 'teillä', 'kuinka', 'paljonko', 'mitä', 'milloin', 'aika', 'varata', 'hyvää', 'päivää', 'se', 'että'],
};

// Whisper-style STT, when fed a vocabulary bias prompt and a (near-)silent
// audio segment, often hallucinates the prompt itself back as "speech".
// Detect transcripts that are mostly vocabulary tokens and drop them.
export function isVocabEcho(transcript: string, vocab: string): boolean {
  const tokens = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);
  const t = tokens(transcript);
  if (t.length === 0) return false;
  const v = new Set(tokens(vocab));
  const overlap = t.filter((w) => v.has(w)).length;
  return t.length >= 2 && overlap / t.length >= 0.7;
}

// Did the caller just say goodbye? Used on tiers without function calling to
// end the call after the agent's sign-off reply.
// \b is ASCII-only in JS and fails around Cyrillic/accented letters — use
// Unicode-aware letter boundaries instead.
const FAREWELL_RE =
  /(?<!\p{L})(good\s?bye|bye\s?bye|bye now|bye|see you|that('|’)s all|auf wiederh(ö|oe?)ren|auf wiedersehen|tsch(ü|ue?)ss|au revoir|bonne journ(é|e)e|adi(ó|o)s|hasta luego|arrivederci|buona giornata|tot ziens|doei|hej d(å|a)|vi ses|farvel|n(ä|a)kemiin|heippa|до свидания|всего доброго)(?!\p{L})/iu;

export function isFarewell(text: string): boolean {
  return FAREWELL_RE.test(text);
}

export function detectLang(text: string): string | null {
  const cyrillic = (text.match(/[а-яё]/gi) ?? []).length;
  if (cyrillic > text.length * 0.3) return 'ru';
  const words = text
    .toLowerCase()
    .replace(/[.,!?;:"']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return null;
  let best: string | null = null;
  let bestScore = 0;
  let secondScore = 0;
  for (const [lang, stops] of Object.entries(STOPWORDS)) {
    const set = new Set(stops);
    const score = words.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0);
    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      best = lang;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }
  return bestScore >= 2 && bestScore > secondScore ? best : null;
}

// Language is auto-detected per utterance so callers can speak any supported
// language regardless of the business's configured default. `prompt` biases
// recognition toward business-specific vocabulary.
export async function transcribe(env: Env, audio: ArrayBuffer, contentType: string, prompt?: string): Promise<Transcription> {
  const form = new FormData();
  const ext = contentType.includes('mp4') ? 'mp4' : contentType.includes('wav') ? 'wav' : 'webm';
  form.append('file', new Blob([audio], { type: contentType }), `utterance.${ext}`);
  form.append('model', env.DEFAULT_STT_MODEL);
  if (prompt) form.append('prompt', prompt);
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

// Azure Speech TTS via REST. Returns audio bytes (MP3 for the pipeline player,
// raw PCM16@24kHz for the realtime stream), or null when TTS is configured for
// browser mode (client falls back to speechSynthesis).
export async function synthesize(env: Env, text: string, voice: string, format: 'mp3' | 'pcm24' = 'mp3'): Promise<ArrayBuffer | null> {
  if (env.DEFAULT_TTS_PROVIDER !== 'azure' || !env.AZURE_SPEECH_KEY) return null;
  const v = voice || env.DEFAULT_TTS_VOICE;
  const lang = v.split('-').slice(0, 2).join('-') || 'en-US';
  const ssml = `<speak version='1.0' xml:lang='${lang}'><voice name='${v}'>${escapeXml(text)}</voice></speak>`;
  const res = await fetch(`https://${env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': format === 'pcm24' ? 'raw-24khz-16bit-mono-pcm' : 'audio-24khz-48kbitrate-mono-mp3',
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
