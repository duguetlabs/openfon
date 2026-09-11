import { describe, expect, it } from 'vitest';
import {
  readClosureRows,
  readFaqRows,
  readHourRows,
  serializeClosureRows,
  serializeFaqRows,
  serializeHourRows,
  type FaqRow,
  type HourRow,
} from '../web/src/row-arrays';

const defaultHours: HourRow[] = [
  { day: 'Monday', open: '09:00', close: '17:00', closed: false },
  { day: 'Sunday', open: '09:00', close: '17:00', closed: true },
];
const blankFaq: FaqRow[] = [{ q: '', a: '' }];

describe('onboarding workspace-row recovery', () => {
  it('keeps valid hours and compatible fields beside malformed siblings through finish serialization', () => {
    const valid = { day: 'Monday', open: '08:30', close: '16:30', label: 'Summer hours' };
    const recovered = readHourRows(
      JSON.stringify([valid, null, { day: 'Tuesday', open: 9, close: '17:00', closed: false }]),
      defaultHours
    );

    expect(recovered).toEqual([valid]);
    expect(JSON.parse(serializeHourRows(recovered))).toEqual([valid]);
  });

  it('keeps valid FAQs and compatible fields beside malformed siblings through finish serialization', () => {
    const valid = { q: 'Do you take walk-ins?', a: 'Yes, before noon.', source: 'owner' };
    const recovered = readFaqRows(JSON.stringify([valid, null, { q: 'Incomplete' }, { q: 42, a: 'No' }]), blankFaq);

    expect(recovered).toEqual([valid]);
    expect(JSON.parse(serializeFaqRows(recovered))).toEqual([valid]);
  });

  it('keeps valid Settings closures beside malformed siblings', () => {
    const valid = { date: '2026-12-25', reason: 'Public holiday', source: 'workspace' };
    const recovered = readClosureRows(
      JSON.stringify([valid, null, { date: 25, reason: 'Invalid' }, { date: '2026-12-26', reason: false }])
    );

    expect(recovered).toEqual([valid]);
    expect(JSON.parse(serializeClosureRows(recovered))).toEqual([valid]);
  });

  it('distinguishes intentional empty arrays from unusable input', () => {
    expect(readHourRows('[]', defaultHours)).toEqual([]);
    expect(readFaqRows('[]', blankFaq)).toEqual([]);

    expect(readHourRows('[null, {"day": 42}]', defaultHours)).toEqual(defaultHours);
    expect(readFaqRows('[null, {"q": "Missing answer"}]', blankFaq)).toEqual(blankFaq);
    expect(readHourRows('{"day":"Monday"}', defaultHours)).toEqual(defaultHours);
    expect(readFaqRows('{not json', blankFaq)).toEqual(blankFaq);
  });
});
