import { describe, expect, it } from 'vitest';
import { detectLang, normalizeLang } from '../src/providers';

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
