import { describe, expect, it } from 'vitest';
import { readServiceRows, serializeServiceRows } from '../web/src/service-rows';

describe('onboarding service recovery', () => {
  it('preserves supported optional fields when price is absent through finish serialization', () => {
    const legacyRows = [
      { name: 'Consultation', duration: '30 min' },
      { name: 'Emergency visit', notes: 'Call ahead' },
      { name: 'Checkup', price: '€80', duration: '45 min', notes: 'Includes an exam' },
      { name: 'Name only' },
    ];

    const recovered = readServiceRows(JSON.stringify(legacyRows));

    expect(recovered).toEqual(legacyRows);
    expect(JSON.parse(serializeServiceRows(recovered))).toEqual(legacyRows);
  });

  it('keeps valid legacy rows when a sibling is malformed', () => {
    const validRow = { name: 'Consultation', duration: '30 min', notes: 'Call ahead' };
    const recovered = readServiceRows(JSON.stringify([validRow, null, { name: 42, price: '€20' }]));

    expect(recovered).toEqual([validRow]);
    expect(JSON.parse(serializeServiceRows(recovered))).toEqual([validRow]);
  });

  it('removes only blank editor rows when finishing', () => {
    const recovered = readServiceRows(JSON.stringify([{ name: 'Consultation', duration: '30 min' }]));

    expect(JSON.parse(serializeServiceRows([...recovered, { name: '  ', price: '' }]))).toEqual([
      { name: 'Consultation', duration: '30 min' },
    ]);
  });
});
