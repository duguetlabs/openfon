import { initializeLogger } from '@livekit/agents';

/** The pinned SDK writes lk.pii.* attributes to stdout without redaction.
 * Keep its raw logs disabled in the supervisor and every job process. OpenFon
 * emits its own allowlisted lifecycle phases and numeric counts separately.
 */
export const SDK_LOG_LEVEL = 'silent';
export const SDK_LOGGER_OPTIONS = Object.freeze({
  pretty: false,
  level: SDK_LOG_LEVEL,
});

export function configureSdkLogging(): void {
  initializeLogger(SDK_LOGGER_OPTIONS);
}
