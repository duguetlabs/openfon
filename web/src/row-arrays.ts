export type RowValidator<T> = (value: unknown) => value is T;

// Preserve an explicitly empty array. For a mixed array, retain every valid
// original object (including compatible fields this UI does not edit) and drop
// only malformed siblings. Missing/malformed/non-array input, or a non-empty
// array with no usable rows, gets the screen-specific editable fallback.
export function readRowArray<T>(
  raw: string | undefined,
  valid: RowValidator<T>,
  fallback: readonly T[]
): T[] {
  if (raw) {
    try {
      const value: unknown = JSON.parse(raw);
      if (Array.isArray(value)) {
        const rows = value.filter(valid);
        if (rows.length || value.length === 0) return rows;
      }
    } catch {
      // Fall through to the screen-specific fallback.
    }
  }
  return [...fallback];
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

export interface HourRow {
  day: string;
  open: string;
  close: string;
  closed?: boolean;
  [key: string]: unknown;
}

function isHourRow(value: unknown): value is HourRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<HourRow>;
  return (
    typeof row.day === 'string' &&
    typeof row.open === 'string' &&
    typeof row.close === 'string' &&
    optionalBoolean(row.closed)
  );
}

export interface FaqRow {
  q: string;
  a: string;
  [key: string]: unknown;
}

function isFaqRow(value: unknown): value is FaqRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<FaqRow>;
  return typeof row.q === 'string' && typeof row.a === 'string';
}

export interface ClosureRow {
  date: string;
  reason?: string;
  [key: string]: unknown;
}

function isClosureRow(value: unknown): value is ClosureRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<ClosureRow>;
  return typeof row.date === 'string' && optionalString(row.reason);
}

export function readHourRows(raw: string | undefined, fallback: readonly HourRow[]): HourRow[] {
  return readRowArray(raw, isHourRow, fallback);
}

export function readFaqRows(raw: string | undefined, fallback: readonly FaqRow[]): FaqRow[] {
  return readRowArray(raw, isFaqRow, fallback);
}

export function readClosureRows(raw: string | undefined, fallback: readonly ClosureRow[] = []): ClosureRow[] {
  return readRowArray(raw, isClosureRow, fallback);
}

export function serializeHourRows(rows: readonly HourRow[]): string {
  return JSON.stringify(rows);
}

export function serializeFaqRows(rows: readonly FaqRow[]): string {
  return JSON.stringify(rows.filter((row) => row.q.trim() && row.a.trim()));
}

export function serializeClosureRows(rows: readonly ClosureRow[]): string {
  return JSON.stringify(rows.filter((row) => row.date.trim()));
}
