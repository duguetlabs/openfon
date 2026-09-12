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

// Historical rows must render correctly without rewriting their source evidence.
describe('absent caller phone rendering', () => {
  it.each(['null', ' NULL ', '', null, 123])('hides absent/invalid phone %j', (caller_phone) => {
    expect(takenMessage(JSON.stringify({caller_name:'Null',caller_phone,message:'Please prepare the repair.'}))).toEqual({caller_name:'Null',caller_phone:null,message:'Please prepare the repair.'});
  });
  it('preserves a real phone number', () => {
    expect(callContact(JSON.stringify({caller_phone:' +43 1 234567 '}))?.caller_phone).toBe('+43 1 234567');
  });
});
