export const LEGACY_FAILED_BOOKING_CONTENT =
  'Appointment requested. Review the source call for details.';

/** Same-snapshot projection for summary-derived legacy rows only. Structured
 * actions can use source_key=booking, so the legacy row identity is also required.
 * Stored diagnostics remain intact; callers retain the source call link.
 */
export function customerActionContentSql(alias: 'a' | 'action_items'): string {
  return `CASE WHEN ${alias}.id='action_booking_'||${alias}.call_id
    AND ${alias}.source_key='booking' AND ${alias}.kind='booking_request'
    AND EXISTS(SELECT 1 FROM calls WHERE calls.id=${alias}.call_id
      AND calls.business_id=${alias}.business_id AND calls.status='failed')
    THEN '${LEGACY_FAILED_BOOKING_CONTENT}' ELSE ${alias}.content END`;
}
