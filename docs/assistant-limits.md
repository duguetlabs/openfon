# Assistant storage and session loading

Migration0015 limits each workspace to32 assistants,1MiB of combined UTF-8 identity and configuration text, and200 accepted assistant creates/updates per UTC day. SQLite triggers apply to all writers. Quota failures return409 for storage or429 for the daily allowance before changing counters; multi-statement saves remain atomic. Existing rows are preserved, and oversized historical configurations can shrink while daily allowance remains. Deletes do not replenish the daily allowance.

The primary workspace assistant cannot be deleted. An unused secondary draft/paused assistant can be deleted from its editor after calls finish and carrier routes are removed. Saved call history remains, with its assistant reference cleared. Active assistants must first be paused; pausing is an assistant update and uses the daily allowance.

Bootstrap returns at most32 assistant metadata records, placing the primary first. It excludes greetings, instructions, provider models and voices. Readiness/counts are calculated separately from the metadata page. Assistant lists return32 name/personality previews at a time; historical workspaces above the new cap can navigate pages. Full configuration is read only when opening an individual editor. Preview text is never used to populate editor configuration. Onboarding reads the existing compatibility configuration, rather than truncated previews.

These are workspace persistence and response-size bounds, not a claim that all authenticated API traffic is rate-limited. Limits do not reduce existing historical rows during migration. Operator-created inconsistent state, such as a missing primary at the count limit, must be repaired without overwriting existing assistants.

The editor's **Check text provider** action verifies the saved text provider/model only. It does not test realtime audio, transcription, speech output or telephone routing; use the appropriate private conversation and provider/carrier acceptance checks for those paths.
