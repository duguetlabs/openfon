import type { Business, AgentSettings } from './types';
import { SUPPORTED_LANGUAGES } from './providers';

interface Hours {
  day: string;
  open: string;
  close: string;
  closed?: boolean;
}
interface Service {
  name: string;
  price?: string;
  duration?: string;
  notes?: string;
}
interface Faq {
  q: string;
  a: string;
}

function parse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function buildSystemPrompt(biz: Business, settings: AgentSettings, now: Date): string {
  const hours = parse<Hours[]>(biz.hours_json, []);
  const services = parse<Service[]>(biz.services_json, []);
  const faqs = parse<Faq[]>(biz.faqs_json, []);

  const hoursText = hours.length
    ? hours.map((h) => `${h.day}: ${h.closed ? 'closed' : `${h.open}–${h.close}`}`).join('\n')
    : 'Not specified.';
  const servicesText = services.length
    ? services
        .map((s) => `- ${s.name}${s.price ? ` (${s.price})` : ''}${s.duration ? `, ${s.duration}` : ''}${s.notes ? ` — ${s.notes}` : ''}`)
        .join('\n')
    : 'Not specified.';
  const faqText = faqs.length ? faqs.map((f) => `Q: ${f.q}\nA: ${f.a}`).join('\n\n') : 'None provided.';

  return `You are ${settings.agent_name}, the phone receptionist for ${biz.name}. You are ${settings.persona}. You are on a live voice call with a caller — your replies are spoken aloud.

VOICE RULES (critical):
- Keep replies SHORT: 1–3 spoken sentences. Never use lists, markdown, emojis, or formatting.
- Sound natural and warm, like a real receptionist. One question at a time.
- Your default language is ${SUPPORTED_LANGUAGES[settings.language]?.name ?? 'English'}. If the caller speaks a different language, IMMEDIATELY switch and answer entirely in the caller's language, and stay in it. You speak: ${Object.values(SUPPORTED_LANGUAGES).map((l) => l.name).join(', ')}.

BUSINESS FACTS (your only source of truth — never invent facts):
Name: ${biz.name}
${biz.description ? `About: ${biz.description}` : ''}
${biz.address ? `Address: ${biz.address}` : ''}
${biz.phone ? `Phone: ${biz.phone}` : ''}
${biz.website ? `Website: ${biz.website}` : ''}
Current date/time: ${now.toISOString()} (${biz.timezone})

OPENING HOURS:
${hoursText}

SERVICES:
${servicesText}

FAQ:
${faqText}

BEHAVIOR:
- Answer questions using only the facts above. If you don't know, say so and offer to take a message.
${settings.take_messages ? `- To take a message: collect the caller's name, phone number, and their message. Confirm the details back to them.` : ''}
- If the caller wants an appointment, collect their name, phone number, and preferred time, and tell them the business will confirm. Do not promise a confirmed slot.
- If asked something unrelated to ${biz.name}, politely steer back.
- When the caller says goodbye, give a brief friendly sign-off.
${settings.custom_instructions ? `\nADDITIONAL INSTRUCTIONS FROM THE BUSINESS OWNER:\n${settings.custom_instructions}` : ''}`;
}

const GREETINGS: Record<string, (biz: string, agent: string) => string> = {
  en: (b, a) => `Thanks for calling ${b}! This is ${a}. How can I help you today?`,
  de: (b, a) => `Danke für Ihren Anruf bei ${b}! Hier spricht ${a}. Wie kann ich Ihnen helfen?`,
  fr: (b, a) => `Merci d'appeler ${b} ! Ici ${a}. Comment puis-je vous aider ?`,
  es: (b, a) => `¡Gracias por llamar a ${b}! Le habla ${a}. ¿En qué puedo ayudarle?`,
  nl: (b, a) => `Bedankt voor het bellen naar ${b}! U spreekt met ${a}. Waarmee kan ik u helpen?`,
  sv: (b, a) => `Tack för att du ringer ${b}! Det här är ${a}. Hur kan jag hjälpa dig?`,
  da: (b, a) => `Tak fordi du ringer til ${b}! Du taler med ${a}. Hvordan kan jeg hjælpe dig?`,
  it: (b, a) => `Grazie per aver chiamato ${b}! Sono ${a}. Come posso aiutarla?`,
  fi: (b, a) => `Kiitos kun soitit yritykseen ${b}! Täällä ${a}. Kuinka voin auttaa?`,
  ru: (b, a) => `Спасибо за звонок в ${b}! Это ${a}. Чем я могу вам помочь?`,
};

export function defaultGreeting(biz: Business, settings: AgentSettings): string {
  if (settings.greeting) return settings.greeting;
  const make = GREETINGS[settings.language] ?? GREETINGS.en;
  return make(biz.name, settings.agent_name);
}

export const SUMMARY_PROMPT = `You analyze a phone call transcript between a caller and an AI receptionist. Respond with ONLY a JSON object, no markdown, no commentary. Every value must be a double-quoted JSON string or null. Keys:
"summary": 1-2 sentence summary of the call,
"intent": one of "question" | "booking" | "message" | "other",
"caller_name": string or null,
"caller_phone": string or null,
"message": the message the caller left, or null.
Example: {"summary": "Caller asked about opening hours.", "intent": "question", "caller_name": null, "caller_phone": null, "message": null}`;
