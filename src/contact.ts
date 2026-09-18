// Models sometimes encode an absent phone as the JSON string "null". Keep
// legitimate phone formatting, but normalize absence at persistence and display.
export function normalizeCallerPhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const phone = value.trim();
  return phone && phone.toLowerCase() !== 'null' ? phone : null;
}
