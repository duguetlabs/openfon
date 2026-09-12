import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeRealtimeAudio, parseRealtimeMessage, MAX_REALTIME_JSON_BYTES, MAX_REALTIME_AUDIO_BASE64, MAX_REALTIME_AUDIO_BYTES } from '../src/realtime-input';

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
