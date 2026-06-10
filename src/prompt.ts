import type { Business, AgentSettings } from './types';

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
- Speak in ${settings.language === 'de' ? 'German' : settings.language === 'es' ? 'Spanish' : settings.language === 'fr' ? 'French' : 'English'} unless the caller clearly prefers another language.

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

export function defaultGreeting(biz: Business, settings: AgentSettings): string {
  if (settings.greeting) return settings.greeting;
  return `Thanks for calling ${biz.name}! This is ${settings.agent_name}. How can I help you today?`;
}

export const SUMMARY_PROMPT = `You analyze a phone call transcript between a caller and an AI receptionist. Respond with ONLY a JSON object, no markdown, no commentary. Every value must be a double-quoted JSON string or null. Keys:
"summary": 1-2 sentence summary of the call,
"intent": one of "question" | "booking" | "message" | "other",
"caller_name": string or null,
"caller_phone": string or null,
"message": the message the caller left, or null.
Example: {"summary": "Caller asked about opening hours.", "intent": "question", "caller_name": null, "caller_phone": null, "message": null}`;
