import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeInputError, decodeRealtimeAudio, parseRealtimeMessage, MAX_REALTIME_JSON_BYTES, MAX_REALTIME_AUDIO_BASE64, MAX_REALTIME_AUDIO_BYTES } from '../src/realtime-input';

afterEach(() => vi.restoreAllMocks());
describe('realtime input allocation bounds', () => {
  it('rejects excessive ASCII before JSON.parse', () => {
    const parse = vi.spyOn(JSON, 'parse');
    expect(() => parseRealtimeMessage(' '.repeat(MAX_REALTIME_JSON_BYTES + 1))).toThrow();
    expect(parse.mock.calls.length).toBe(0);
  });
  it.each(['€', '😀', '\ud800'])('counts UTF-8 bytes of %s without an encoded copy', char => {
    const raw = JSON.stringify({ type: 'test', text: '' });
    const overhead = raw.length;
    // Raw unpaired surrogate measures three UTF-8 replacement bytes.
    const width = new TextEncoder().encode(char).length;
    const room = MAX_REALTIME_JSON_BYTES - overhead;
    const text = char.repeat(Math.floor(room / width)) + 'x'.repeat(room % width);
    const atLimit = raw.replace('"text":""', '"text":"' + text + '"');
    expect(parseRealtimeMessage(atLimit).type).toBe('test');
    const parse = vi.spyOn(JSON, 'parse');
    expect(() => parseRealtimeMessage(atLimit + ' ')).toThrow();
    expect(parse.mock.calls.length).toBe(0);
  });
  it('checks audio size after bounded JSON unescaping and before atob', () => {
    const decode = vi.spyOn(globalThis, 'atob');
    const delta = 'A'.repeat(MAX_REALTIME_AUDIO_BASE64 + 1);
    expect(() => parseRealtimeMessage(JSON.stringify({ type: 'response.output_audio.delta', delta }))).toThrow();
    expect(() => decodeRealtimeAudio(delta)).toThrow();
    expect(decode.mock.calls.length).toBe(0);
  });
  it('accepts the exact encoded/decoded PCM bound and a small unpadded delta', () => {
    expect(decodeRealtimeAudio('A'.repeat(MAX_REALTIME_AUDIO_BASE64)).byteLength).toBe(MAX_REALTIME_AUDIO_BYTES);
    expect(decodeRealtimeAudio('AAA').byteLength).toBe(2);
    expect(decodeRealtimeAudio('AAAAAA==').byteLength).toBe(4);
  });
  it.each([null, 1, [], '{', new ArrayBuffer(2)])('rejects non-object JSON or binary transport safely', input => {
    expect(() => parseRealtimeMessage(typeof input === 'string' || input instanceof ArrayBuffer ? input : JSON.stringify(input))).toThrow();
  });
  it('rejects a non-string or malformed base64 delta with a payload-free error', () => {
    expect(() => parseRealtimeMessage('{"type":"response.output_audio.delta","delta":123}')).toThrow();
    expect(() => decodeRealtimeAudio('private-provider-text!')).toThrow('Invalid or oversized realtime provider message');
  });
});


describe('realtime transcript field bounds', () => {
  it.each(['conversation.item.input_audio_transcription.completed', 'response.output_audio_transcript.done'])('bounds %s in UTF-8 after JSON unescaping', type => {
    const accepted = '€'.repeat(2730) + 'xx'; //8192 bytes
    expect(parseRealtimeMessage(JSON.stringify({ type, transcript: accepted })).transcript).toBe(accepted);
    expect(() => parseRealtimeMessage(JSON.stringify({ type, transcript: accepted + 'x' }))).toThrow();
    expect(() => parseRealtimeMessage(JSON.stringify({ type, transcript: 'x'.repeat(900000) }))).toThrow();
    expect(() => parseRealtimeMessage(JSON.stringify({ type, transcript: 123 }))).toThrow();
    expect(parseRealtimeMessage(JSON.stringify({ type, transcript: '' })).transcript).toBe('');
    const escaped = '{"type":"' + type + '","transcript":"' + '\\u20ac'.repeat(2731) + '"}';
    expect(() => parseRealtimeMessage(escaped)).toThrow();
  });
});


describe('realtime parser fixed error contract', () => {
  const canary = 'SYNTHETIC_PARSER_CANARY_5657485256';
  const fixedMessage = 'Invalid or oversized realtime provider message';
  const assertFixedError = (raw: string) => {
    let caught: unknown;
    try { parseRealtimeMessage(raw); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(RealtimeInputError);
    expect((caught as Error).message).toBe(fixedMessage);
    expect(String(caught)).not.toContain(canary);
    expect((caught as Error).stack).not.toContain(canary);
    expect(Object.prototype.hasOwnProperty.call(caught, 'cause')).toBe(false);
    expect(Object.keys(caught as object)).toEqual([]);
  };

  it.each([
    `not-json ${canary}`,
    `{"type":"response.output_audio_transcript.done","transcript":"${canary}`,
    `{"type":"test","text":"${canary}",}`,
    `{"type":"test"} ${canary}`,
  ])('normalizes malformed JSON without retaining the synthetic canary: %s', raw => {
    assertFixedError(raw);
  });

  it('discards a native parse error and its provider-controlled diagnostic properties', () => {
    const parseError = new SyntaxError(`Unexpected token in ${canary}`);
    Object.assign(parseError, { payload: canary, cause: new Error(canary) });
    vi.spyOn(JSON, 'parse').mockImplementationOnce(() => { throw parseError; });
    assertFixedError(`{"synthetic":"${canary}"}`);
  });

  it('preserves valid unknown events and escaped transcript content', () => {
    const event = { type: 'future.event', text: `quotes " and newline\n${canary}` };
    expect(parseRealtimeMessage(JSON.stringify(event))).toEqual(event);
    const transcript = { type: 'response.output_audio_transcript.done', transcript: `hello\n${canary}` };
    expect(parseRealtimeMessage(JSON.stringify(transcript))).toEqual(transcript);
  });
});
