// PUT merges seven fields from its read; Apply consumes only six behavior
// fields. A source rename does not change what Apply copies to the assistant.
const BEHAVIOR_FIELDS = ['engine', 'realtime_model', 'realtime_voice', 'language', 'voice', 'llm_model'] as const;
const WRITE_FIELDS = ['name', ...BEHAVIOR_FIELDS] as const;
type PresetTable = 'engine_presets' | 'engine_profiles';

export function checkedPresetWriteSql(table: PresetTable): string {
  return WRITE_FIELDS.map(field => `${table}.${field} IS ?`).join(' AND ');
}

export function checkedPresetWrite(preset: Readonly<Record<string, string>>) {
  return WRITE_FIELDS.map(field => preset[field]);
}

// The selected source must still exist with the behavior that was validated.
// These checks do not turn explicit target-field replacement into assistant CAS.
export function checkedPresetSourceSql(table: PresetTable): string {
  return `EXISTS(SELECT 1 FROM ${table} AS apply_source
    WHERE apply_source.id=? AND apply_source.business_id=?
      AND apply_source.business_id=assistants.business_id
      AND ${BEHAVIOR_FIELDS.map(field => `apply_source.${field} IS ?`).join(' AND ')})`;
}

export function checkedPresetSource(preset: Readonly<Record<string, string>>) {
  return [preset.id, preset.business_id, ...BEHAVIOR_FIELDS.map(field => preset[field])];
}
