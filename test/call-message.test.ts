import { describe, expect, it } from 'vitest';
import { bookingRequestContact, callContact, takenMessage } from '../web/src/api';

describe('takenMessage', () => {
  it.each([null, '   '])('does not treat booking contact details as a taken message (%j)', (message) => {
    const messageJson = JSON.stringify({
      caller_name: 'Maria',
      caller_phone: '0664 1234567',
      message,
    });
    expect(takenMessage(messageJson)).toBeNull();
    expect(
      bookingRequestContact({ outcome: 'booking_requested', intent: 'booking', message_json: messageJson })
    ).toEqual({
      caller_name: 'Maria',
      caller_phone: '0664 1234567',
      message: null,
    });
  });

  it('returns normalized contact details with a real callback message', () => {
    expect(
      takenMessage(
        JSON.stringify({
          caller_name: ' Maria ',
          caller_phone: ' 0664 1234567 ',
          message: ' Please call me back about a crown. ',
        })
      )
    ).toEqual({
      caller_name: 'Maria',
      caller_phone: '0664 1234567',
      message: 'Please call me back about a crown.',
    });
  });

  it('ignores malformed historical message data safely', () => {
    expect(callContact('{not json')).toBeNull();
    expect(takenMessage('{not json')).toBeNull();
    expect(takenMessage(JSON.stringify({ message: 123 }))).toBeNull();
  });

  it('does not label non-booking contact data as a booking request', () => {
    const messageJson = JSON.stringify({ caller_name: 'Maria', caller_phone: '0664 1234567', message: null });
    expect(bookingRequestContact({ outcome: 'answered', intent: 'question', message_json: messageJson })).toBeNull();
    expect(bookingRequestContact({ outcome: 'failed', intent: 'booking', message_json: messageJson })).toBeNull();
    expect(bookingRequestContact({ outcome: null, intent: 'booking', message_json: messageJson })).toMatchObject({
      caller_name: 'Maria',
      caller_phone: '0664 1234567',
    });
  });
});
