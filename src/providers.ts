import { fetchProviderBytes, fetchProviderJson, ProviderResponseError } from './provider-response';
// Pluggable AI providers. LLM and STT speak the OpenAI-compatible wire format,
// so OpenFon works with Kataleptic (default), OpenAI, Azure OpenAI, Groq, Ollama,
// vLLM, or anything else that implements /chat/completions and /audio/transcriptions.
import type { Env, AgentSettings, ChatMessage, LlmConfig, WorkspaceSpeechSettings } from './types';

// Raised when a business's AI-provider settings cannot be turned into a usable
// config. Callers surface the message to the user instead of failing opaquely.
export class LlmConfigError extends Error {}
// Only these locally composed messages may be shown by connection checks.
export class LlmRequestError extends Error {}

// Two base URLs mean the same endpoint if only a trailing slash or host casing
// differs — otherwise "https://api.host/v1/" would count as a custom endpoint
// and lose the instance key for no reason. Everything else fetch actually puts
// on the wire is part of the identity:
//   - credentials, so "https://user:pass@<default host>/v1" can't pose as the
//     clean instance URL and skip the checks below;
//   - the query string, since a gateway can route on it — with
//     DEFAULT_LLM_BASE_URL="https://gw/v1?target=trusted", a business saving
//     "?target=attacker" would otherwise inherit the instance key and have the
//     gateway forward it wherever they point it.
// Query strings are compared verbatim, not canonicalized: "?b=2&a=1" then reads
// as a different endpoint than "?a=1&b=2" and merely needs its own key, which
// is the safe direction to be wrong in. The fragment is left out — fetch never
// sends it, so it cannot change where the request lands.
export function sameLlmEndpoint(a: string, b: string): boolean {
  const norm = (u: string) => {
    try {
      const p = new URL(u.trim());
      const cred = p.username || p.password ? `${p.username}:${p.password}@` : '';
      const port = p.port ? `:${p.port}` : '';
      // The host goes in exactly as the parser reports it — brackets on IPv6
      // literals, DNS root dot and all. Identity asks "is this the same
      // destination", and fetch sends "api.example.com." in the Host header,
      // which a virtual host may route elsewhere than "api.example.com".
      // isInternalHost normalizes both away because it asks a different
      // question — "is this the same machine". Two questions, two
      // normalizations: collapsing them is what let "[2001:db8::1]:8443" and
      // "[2001:db8::1:8443]" read as one endpoint.
      return `${p.protocol}//${cred}${p.hostname.toLowerCase()}${port}${p.pathname.replace(/\/+$/, '')}${p.search}`;
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
      // The operator's own URL, never the business's spelling of it. The two
      // are equivalent by the check above, so this costs nothing — and it means
      // the guarantee doesn't rest on that check being injective: any future
      // collision costs a business its custom endpoint, and can never route
      // the instance key somewhere the operator didn't configure.
      baseUrl: env.DEFAULT_LLM_BASE_URL,
      apiKey: settings?.llm_api_key || env.DEFAULT_LLM_API_KEY || '',
      model,
    };
  }
  // Rows written before this rule existed (or edited straight in D1) are
  // re-checked here, so a stale endpoint can't outlive the policy.
  const rejected = validateLlmBaseUrl(custom, env.ALLOW_INSECURE_LLM_URL === 'true');
  if (rejected) throw new LlmConfigError(`LLM base URL ${rejected}`);
  if (!settings?.llm_api_key) {
    throw new LlmConfigError('A custom LLM base URL needs its own API key — this instance never sends its key to another endpoint.');
  }
  return { baseUrl: custom, apiKey: settings.llm_api_key, model };
}

// Normalization for *address inspection* — "which machine is this" — not for
// endpoint identity, which keeps both of these (see sameLlmEndpoint). The URL
// parser already folds case, punycodes IDNs, and canonicalizes IP literals,
// but it keeps the DNS root dot: "localhost." resolves exactly where
// "localhost" does, so it must not read as a different machine. Brackets come
// off so an IPv6 literal can be matched as an address.
function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
}

// Literal-IP inspection only: Workers have no DNS resolver, so a hostname that
// *resolves* into private space still gets through. This stops the direct
// http://169.254.169.254/ style probe and keeps honest misconfiguration out;
// it is not a complete SSRF defence.
function isInternalHost(host: string): boolean {
  const h = normalizeHost(host);
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
export function validateLlmBaseUrl(raw: string, allowInsecure = false): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return 'must be an absolute URL, e.g. https://api.example.com/v1';
  }
  if (url.username || url.password) return 'must not embed credentials — put the key in the API key field';
  // fetch only speaks http(s), and a typo like "htt://" parses fine.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'must be an http(s) URL';
  // ALLOW_INSECURE_LLM_URL is the operator declaring "this instance runs a
  // model next to the Worker". That setup is plain http to loopback, so the
  // flag lifts the transport and address rules together — one switch, no
  // grammar to get wrong. Not for a deployment with tenants on it.
  if (allowInsecure) return null;
  if (url.protocol !== 'https:') return 'must use https://';
  if (isInternalHost(normalizeHost(url.hostname))) return 'must not point at a loopback, private, or link-local address';
  return null;
}

// Append the endpoint path structurally, not by concatenation: a base URL may
// carry a query string — a gateway routing on "?target=…" is a configuration
// sameLlmEndpoint deliberately supports — and "…/v1?target=x" + "/chat/completions"
// buries the path inside the query value, leaving the request pointed at /v1.
// The trailing slash goes for the same reason it always did: "…/v1/" would
// otherwise build "…/v1//chat/completions", which providers used to paper over
// with a 301 that fetch followed, and redirects are off below.
function providerUrl(baseUrl: string, endpoint: '/chat/completions' | '/audio/transcriptions'): string {
  try {
    const u = new URL(baseUrl.trim());
    u.pathname = `${u.pathname.replace(/\/+$/, '')}${endpoint}`;
    return u.toString();
  } catch {
    return `${baseUrl.trim().replace(/\/+$/, '')}${endpoint}`;
  }
}

export async function chatComplete(
  cfg: LlmConfig,
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number; json?: boolean } = {}
): Promise<string> {
  const { response: res, data } = await fetchProviderJson(providerUrl(cfg.baseUrl, '/chat/completions'), {
    method: 'POST',
    // Every endpoint rule above is checked against the URL that was saved, so a
    // followed redirect would walk straight around them: a host that passes
    // validation can answer 302 http://10.0.0.1/ and have the Worker make that
    // request instead. No OpenAI-compatible /chat/completions has a reason to
    // redirect, so treat one as an error.
    redirect: 'manual',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      max_tokens: opts.maxTokens ?? 300,
      temperature: opts.temperature ?? 0.6,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (res.status >= 300 && res.status < 400) {
    // A redirect Location may contain userinfo or signed query credentials.
    // The status is enough to diagnose an unsupported provider response; never
    // copy the target into logs or an API error.
    console.error(`LLM endpoint returned redirect status ${res.status}; target redacted`);
    throw new Error(`LLM error ${res.status}: endpoint redirected; redirects are not followed`);
  }
  if (!res.ok) {
    // Provider bodies are untrusted and may reflect the Authorization header,
    // signed query data, or internal diagnostics. Call failures are logged and
    // stored for the owner, so carry only the status across that boundary.
    const hint = res.status === 401 || res.status === 403 ? 'check the API key and model permissions'
      : res.status === 402 ? 'check your provider billing or credits'
      : res.status === 404 ? 'check the base URL and model identifier'
      : res.status === 429 ? 'provider rate limit or quota reached; retry later or check your quota'
      : res.status === 400 ? 'check model support for chat completions and JSON responses' : 'provider request failed; retry later';
    throw new LlmRequestError(`LLM error ${res.status}: ${hint}`);
  }
  const choices = (data as { choices?: { message?: { content?: unknown } }[] } | null)?.choices;
  if (!Array.isArray(choices)) throw new ProviderResponseError();
  const content = choices[0]?.message?.content;
  if (content != null && typeof content !== 'string') throw new ProviderResponseError();
  return content ?? '';
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
export async function transcribe(env: Env, audio: ArrayBuffer, contentType: string, prompt?: string, settings?: WorkspaceSpeechSettings | null, signal?: AbortSignal): Promise<Transcription> {
  const custom = settings?.stt_provider && settings.stt_provider !== 'instance';
  const baseUrl = custom ? settings.stt_base_url || '' : env.DEFAULT_STT_BASE_URL;
  const apiKey = custom ? settings.stt_api_key || '' : env.DEFAULT_STT_API_KEY || '';
  const model = custom ? settings.stt_model || '' : env.DEFAULT_STT_MODEL;
  if (custom) {
    const bad = validateLlmBaseUrl(baseUrl);
    if (bad) throw new LlmConfigError(`STT URL ${bad}`);
    if (!apiKey || !model) throw new LlmConfigError('STT provider needs its own API key and model.');
    if (settings.stt_provider === 'openai' && baseUrl !== 'https://api.openai.com/v1') throw new LlmConfigError('OpenAI STT endpoint must be https://api.openai.com/v1');
  }
  const form = new FormData();
  const ext = contentType.includes('mp4') ? 'mp4' : contentType.includes('wav') ? 'wav' : 'webm';
  form.append('file', new Blob([audio], { type: contentType }), `utterance.${ext}`);
  form.append('model', model);
  if (prompt) form.append('prompt', prompt);
  // Diarization and slower transcribers need a different budget from chat.
  // One absolute deadline covers both attempts; no model-name assumptions and
  // no retry on authentication, rate limits, network errors or timeouts.
  const configured = Number(env.STT_TIMEOUT_MS);
  const timeout = Number.isFinite(configured) && configured >= 1000
    ? Math.min(configured, 120_000) : 60_000;
  const expiresAt = Date.now() + timeout;
  const request = () => fetchProviderJson(providerUrl(baseUrl, '/audio/transcriptions'), {
    method: 'POST', redirect: 'manual', signal,
    headers: { Authorization: `Bearer ${apiKey}` }, body: form,
  }, expiresAt - Date.now());
  let { response: res, data } = await request();
  if (prompt && (res.status === 400 || res.status === 422)) {
    // Optional vocabulary is an optimization, not a prerequisite for speech.
    // Error bodies remain unread: they may reflect credentials or private URLs.
    form.delete('prompt');
    ({ response: res, data } = await request());
  }
  if (!res.ok) {
    throw new Error(`STT error ${res.status}: provider request failed`);
  }
  const result = data as { text?: unknown; language?: unknown; languages?: unknown } | null;
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
    (result.text != null && typeof result.text !== 'string') ||
    (result.language != null && typeof result.language !== 'string')) throw new ProviderResponseError();
  // Whisper reports `language`; gpt-transcribe reports `languages: [{ code }]`.
  // A malformed list only costs the hint, never the transcript.
  const first = Array.isArray(result.languages) ? result.languages[0] as { code?: unknown } | undefined : undefined;
  const language = result.language ?? (typeof first?.code === 'string' ? first.code : undefined);
  return { text: (result.text ?? '').trim(), language: normalizeLang(language) };
}

// Pick the voice for a reply: the business's custom voice only applies to its
// own default language; replies in other languages get the matching neural voice.
export function voiceForReply(env: Env, lang: string, defaultLang: string, customVoice: string): string {
  if (customVoice && lang === defaultLang) return customVoice;
  return SUPPORTED_LANGUAGES[lang]?.voice ?? env.DEFAULT_TTS_VOICE;
}

export function speechConfig(env: Env, settings?: WorkspaceSpeechSettings | null) {
  const selection = settings?.tts_provider || 'instance';
  if (selection === 'instance') return env.DEFAULT_TTS_PROVIDER === 'azure' && env.AZURE_SPEECH_KEY
    ? { provider: 'azure' as const, baseUrl: `https://${env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com`, key: env.AZURE_SPEECH_KEY, model: '' }
    : { provider: 'browser' as const, baseUrl: '', key: '', model: '' };
  if (selection === 'browser') return { provider: 'browser' as const, baseUrl: '', key: '', model: '' };
  if (!['azure', 'openai', 'custom'].includes(selection)) throw new LlmConfigError('Unsupported speech provider.');
  const baseUrl = settings?.tts_base_url || '';
  const error = speechEndpointError(selection, baseUrl);
  if (error || !settings?.tts_api_key || (selection !== 'azure' && !settings.tts_model)) {
    throw new LlmConfigError(error || 'Speech synthesis needs its own API key and model.');
  }
  return { provider: selection, baseUrl, key: settings.tts_api_key, model: settings.tts_model || '' };
}

export function speechEndpointError(provider: string, baseUrl: string): string | null {
  const bad = validateLlmBaseUrl(baseUrl);
  if (bad) return `Speech URL ${bad}`;
  const url = new URL(baseUrl);
  if (url.search || url.hash) return 'Speech URL must not include query parameters or fragments.';
  if (provider === 'openai' && baseUrl !== 'https://api.openai.com/v1') return 'OpenAI speech requires https://api.openai.com/v1';
  if (provider === 'azure' && (!/^[a-z0-9-]+\.tts\.speech\.microsoft\.com$/.test(url.hostname) || url.port || !['', '/'].includes(url.pathname))) {
    return 'Azure speech requires a regional https://REGION.tts.speech.microsoft.com endpoint.';
  }
  return null;
}

export function speechVoice(env: Env, language: string, settings: AgentSettings | null): string {
  const config = speechConfig(env, settings);
  if (config.provider === 'openai' || config.provider === 'custom') return settings?.voice || 'alloy';
  return voiceForReply(env, language, settings?.language || 'en', settings?.voice || '');
}

// Explicit workspace providers never borrow operator credentials or silently
// fall back to browser speech. Body, redirects, read work and latency are bounded.
export async function synthesize(env: Env, text: string, voice: string, format: 'mp3' | 'pcm24' = 'mp3', settings?: WorkspaceSpeechSettings | null, signal?: AbortSignal): Promise<ArrayBuffer | null> {
  if (!settings) return synthesizeInstance(env, text, voice, format);
  const config = speechConfig(env, settings);
  if (config.provider === 'browser') return null;
  const azure = config.provider === 'azure';
  const v = voice || (azure ? env.DEFAULT_TTS_VOICE : 'alloy');
  const lang = v.split('-').slice(0, 2).join('-') || 'en-US';
  const body = azure
    ? `<speak version='1.0' xml:lang='${escapeXml(lang)}'><voice name='${escapeXml(v)}'>${escapeXml(text)}</voice></speak>`
    : JSON.stringify({ model: config.model, input: text, voice: v, response_format: format === 'pcm24' ? 'pcm' : 'mp3' });
  const { response, bytes } = await fetchProviderBytes(config.baseUrl.replace(/\/$/, '') + (azure ? '/cognitiveservices/v1' : '/audio/speech'), {
    method: 'POST', redirect: 'manual', signal,
    headers: azure ? { 'Ocp-Apim-Subscription-Key': config.key, 'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': format === 'pcm24' ? 'raw-24khz-16bit-mono-pcm' : 'audio-24khz-48kbitrate-mono-mp3', 'User-Agent': 'openfon' }
      : { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' }, body,
  }, 30_000, 2880000);
  if (!response.ok || !bytes?.byteLength || (format === 'pcm24' && bytes.byteLength % 2)) throw new LlmConfigError('Speech synthesis failed or returned invalid audio.');
  return bytes.slice().buffer as ArrayBuffer;
}

// Keep the existing realtime greeting path independent of workspace pipeline speech.
async function synthesizeInstance(env: Env, text: string, voice: string, format: 'mp3' | 'pcm24' = 'mp3'): Promise<ArrayBuffer | null> {
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
    console.error(`TTS error ${res.status}: provider response redacted`);
    return null;
  }
  return res.arrayBuffer();
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}
