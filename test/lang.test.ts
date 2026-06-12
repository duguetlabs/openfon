import { describe, expect, it } from 'vitest';
import { detectLang, isFarewell, isVocabEcho, normalizeLang } from '../src/providers';

describe('isFarewell', () => {
  it('matches farewells across languages', () => {
    expect(isFarewell("That was everything, thank you, goodbye!")).toBe(true);
    expect(isFarewell('Okay, danke, auf Wiederhören!')).toBe(true);
    expect(isFarewell('Merci beaucoup, au revoir.')).toBe(true);
    expect(isFarewell('Tack så mycket, hej då!')).toBe(true);
    expect(isFarewell('Спасибо, до свидания.')).toBe(true);
  });

  it('does not match ordinary turns', () => {
    expect(isFarewell('Do you have time on Friday?')).toBe(false);
    expect(isFarewell('Guten Tag, ich hätte gerne einen Termin.')).toBe(false);
    expect(isFarewell('Can you check the schedule by the way?')).toBe(false);
  });
});
import { buildCalendar } from '../src/prompt';

describe('buildCalendar', () => {
  const hours = [
    { day: 'Monday', open: '09:00', close: '17:00' },
    { day: 'Tuesday', open: '09:00', close: '17:00' },
    { day: 'Wednesday', open: '09:00', close: '17:00' },
    { day: 'Thursday', open: '09:00', close: '17:00' },
    { day: 'Friday', open: '09:00', close: '14:00' },
    { day: 'Saturday', open: '', close: '', closed: true },
    { day: 'Sunday', open: '', close: '', closed: true },
  ];
  const now = new Date('2026-06-12T10:00:00Z'); // a Friday

  it('maps every date to its weekday and open/closed status', () => {
    const cal = buildCalendar(hours, [], now, 'Europe/Vienna');
    expect(cal).toContain('Fri 2026-06-12 (today): open 09:00–14:00');
    expect(cal).toContain('Sat 2026-06-13 (tomorrow): CLOSED');
    expect(cal).toContain('Fri 2026-06-26: open 09:00–14:00');
  });

  it('overrides open weekdays with special closures (holidays)', () => {
    const cal = buildCalendar(hours, [{ date: '2026-06-26', reason: 'Public holiday' }], now, 'Europe/Vienna');
    expect(cal).toContain('Fri 2026-06-26: CLOSED (Public holiday)');
  });
});

const VOCAB = 'Riverside Dental, Alex, Checkup, Cleaning, 12 River St, Vienna';

describe('isVocabEcho', () => {
  it('drops STT hallucinations of the vocabulary prompt', () => {
    expect(isVocabEcho('Checkup, Cleaning, 12 River St, Vienna', VOCAB)).toBe(true);
    expect(isVocabEcho('Riverside Dental Alex', VOCAB)).toBe(true);
  });

  it('keeps real speech that merely mentions business terms', () => {
    expect(isVocabEcho('I would like to book a checkup for tomorrow morning please', VOCAB)).toBe(false);
    expect(isVocabEcho('How much is a cleaning?', VOCAB)).toBe(false);
    expect(isVocabEcho('Do you have time on Friday?', VOCAB)).toBe(false);
  });
});

describe('detectLang', () => {
  it('detects the ten supported languages', () => {
    expect(detectLang('Haben Sie am Freitag noch einen Termin frei? Ich möchte gerne kommen.')).toBe('de');
    expect(detectLang('Bonjour, est-ce que vous avez un rendez-vous pour moi ?')).toBe('fr');
    expect(detectLang('Hola, ¿cuánto cuesta una limpieza? Gracias.')).toBe('es');
    expect(detectLang('Buongiorno, vorrei un appuntamento per venerdì, grazie.')).toBe('it');
    expect(detectLang('Hallo, ik wil graag een afspraak maken, kan dat?')).toBe('nl');
    expect(detectLang('Hej, jag vill gärna boka en tid, vad finns det?')).toBe('sv');
    expect(detectLang('Hej, jeg vil gerne bestille en tid, hvad har I?')).toBe('da');
    expect(detectLang('Hei, onko teillä aikaa perjantaina? Kiitos.')).toBe('fi');
    expect(detectLang('Здравствуйте, можно записаться на приём?')).toBe('ru');
    expect(detectLang('Hello, what are your opening hours, please?')).toBe('en');
  });

  it('detects the language-switch utterances from the field-test call', () => {
    expect(detectLang('Ich kann das hier auf Deutsch sprechen, bitte.')).toBe('de');
    expect(detectLang("No, let's go back to English. What do you have available?")).toBe('en');
  });

  it('returns null when unsure instead of guessing', () => {
    expect(detectLang('Okay.')).toBeNull();
    expect(detectLang('Riverside Dental')).toBeNull();
    expect(detectLang('')).toBeNull();
  });
});

describe('normalizeLang', () => {
  it('maps codes, names, and locales', () => {
    expect(normalizeLang('de')).toBe('de');
    expect(normalizeLang('german')).toBe('de');
    expect(normalizeLang('de-AT')).toBe('de');
    expect(normalizeLang('klingon')).toBeNull();
  });
});
