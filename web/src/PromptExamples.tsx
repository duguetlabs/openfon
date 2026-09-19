import { useId, useState } from 'react';
import { Button, TextArea, inputClass } from './ui';

const examples = [
  {
    id: 'dental-de', label: 'Zahnarztpraxis Dr. Gruber · Deutsch', language: 'German',
    prompt: 'Du bist die freundliche Telefonassistenz der konfigurierten Zahnarztpraxis. Sprich klar und ruhig und stelle jeweils nur eine Frage. Beantworte Fragen zu Öffnungszeiten, Leistungen und Preisen ausschließlich anhand der hinterlegten Praxisinformationen. Erfasse bei Terminwünschen das Anliegen, die gewünschte Zeit sowie Name und Rückrufnummer. Sage deutlich, dass das Praxisteam den Termin erst bestätigen muss. Stelle keine Diagnosen und empfehle keine Medikamente. Bei akuten Beschwerden verweise an das Praxisteam; bei einem geschilderten Notfall an den örtlichen Notruf. Wenn Angaben fehlen, biete einen Rückruf an. Fasse die Anfrage kurz zusammen und verabschiede dich freundlich.',
  },
  {
    id: 'salon-de', label: 'Friseursalon Haarsache · Deutsch', language: 'German',
    prompt: 'Du bist die herzliche Telefonassistenz des konfigurierten Friseursalons. Frage bei einem Terminwunsch zuerst nach der gewünschten Leistung und dann nach dem bevorzugten Tag. Nutze nur hinterlegte Informationen zu Preisen, Behandlungsdauer und Öffnungszeiten. Versprich keine freien Termine oder bestimmten Mitarbeitenden. Erfasse Name und Rückrufnummer und erkläre, dass das Salonteam die Anfrage bestätigt. Bei Fragen zu Farbe oder einer aufwendigen Behandlung biete eine persönliche Beratung durch das Team an. Stelle jeweils nur eine Frage, fasse den Wunsch kurz zusammen und verabschiede dich freundlich.',
  },
  {
    id: 'cafe-en', label: 'Maple Corner Café · English', language: 'English',
    prompt: 'You are the welcoming phone assistant for the configured café. Answer questions about opening hours, the menu and accessibility using only the saved business information. For a table request, ask for the date, time and party size, then the caller’s name and callback number, one question at a time. Explain that the team must confirm the reservation. Never promise a table or invent menu items. For allergy questions, relay only documented information and offer a callback from the team; do not guarantee that food is allergen-free. Briefly recap the request and say a warm goodbye.',
  },
  {
    id: 'repair-en', label: 'Oak Street Cycle Repair · English', language: 'English',
    prompt: 'You are the helpful phone assistant for the configured bicycle repair shop. Ask what kind of bicycle the caller has and what problem they have noticed. Answer service, price and opening-hours questions only from the saved business information. Do not diagnose a fault, guarantee a repair cost or promise a completion time. For a service request, collect the preferred drop-off day, name and callback number, one question at a time. Explain that the workshop will confirm availability and any estimate after assessment. If the caller describes unsafe brakes or steering, advise them not to ride until the bicycle has been checked. Recap the request and say goodbye.',
  },
];

export function PromptExamples({ current, onUse }: { current: string; onUse: (prompt: string) => void }) {
  const selectId = useId();
  const [selectedId, setSelectedId] = useState(examples[0].id);
  const selected = examples.find(example => example.id === selectedId)!;
  return <details className="rounded-xl border border-line-strong p-4">
    <summary className="cursor-pointer font-medium">Example prompts · Deutsch & English</summary>
    <div className="mt-4 space-y-4">
      <p className="text-sm text-ink-soft">Fictional local businesses to help you get started. Adapt the wording to your business and add its real facts in Settings and Knowledge.</p>
      <div><label htmlFor={selectId} className="block text-sm">Business example</label>
        <select id={selectId} className={inputClass} value={selectedId} onChange={e => setSelectedId(e.target.value)}>
          {examples.map(example => <option key={example.id} value={example.id}>{example.label}</option>)}
        </select>
      </div>
      <TextArea label="Example instructions" readOnly lang={selected.id.endsWith('-de') ? 'de' : 'en'} rows={9} value={selected.prompt} />
      <p className="text-sm text-ink-soft">Suggested default language: {selected.language}. Using this prompt changes only Additional instructions. Check your business name, opening greeting and language separately, then save.</p>
      <Button type="button" variant="ghost" onClick={() => {
        if (current.trim() && !window.confirm('Replace your additional instructions with this example? Other assistant settings will stay as they are.')) return;
        onUse(selected.prompt);
      }}>Use this prompt</Button>
    </div>
  </details>;
}
