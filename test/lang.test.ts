import { describe, expect, it } from 'vitest';
import { detectLang, isVocabEcho, normalizeLang } from '../src/providers';

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
