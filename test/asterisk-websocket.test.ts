import { expect, it } from 'vitest';
import { selectAsteriskProtocol } from '../src/asterisk-websocket';

it.each([null, undefined])('distinguishes absent offer %s from present empty', offer => {
  expect(selectAsteriskProtocol(offer)).toBeNull();
});
it.each(['media', 'other, media', 'media,other', 'other,\tmedia\t', 'Media,media', 'other!#$%&\'*+-.^_`|~,media'])('selects only exact media from valid offer %s', offer => {
  expect(selectAsteriskProtocol(offer)).toBe('media');
});
it.each(['', ' ', '\t', 'other', 'MEDIA', 'premedia', 'media-suffix', 'media,', ',media', 'other,,media',
  'media,media', 'other,other,media', 'media,other,other', 'media;version=1', 'media,bad token', 'media,"other"',
  'media,other/thing', 'media,\u00a0other', 'media,other\r\n', 'media,other\n', 'media,other\r', 'media,☃'])('refuses the entire malformed/unsupported offer %s', offer => {
  expect(selectAsteriskProtocol(offer)).toBe(false);
});
