import { readRowArray } from './row-arrays';

export interface ServiceRow {
  name: string;
  price?: string;
  duration?: string;
  notes?: string;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isServiceRow(value: unknown): value is ServiceRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<ServiceRow>;
  return (
    typeof row.name === 'string' &&
    optionalString(row.price) &&
    optionalString(row.duration) &&
    optionalString(row.notes)
  );
}

export function readServiceRows(raw: string | undefined): ServiceRow[] {
  return readRowArray(raw, isServiceRow, [{ name: '', price: '' }]);
}

export function serializeServiceRows(rows: ServiceRow[]): string {
  return JSON.stringify(rows.filter((row) => row.name.trim()));
}
