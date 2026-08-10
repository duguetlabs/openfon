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
  if (raw) {
    try {
      const value: unknown = JSON.parse(raw);
      if (Array.isArray(value)) {
        const rows = value.filter(isServiceRow);
        if (rows.length || value.length === 0) return rows;
      }
    } catch {
      // Fall through to the editable blank row.
    }
  }
  return [{ name: '', price: '' }];
}

export function serializeServiceRows(rows: ServiceRow[]): string {
  return JSON.stringify(rows.filter((row) => row.name.trim()));
}
