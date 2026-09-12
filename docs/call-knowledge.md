# Knowledge selected for calls

Only active items in the assistant's attached collections and workspace are eligible. Selection uses creation time, then item ID, oldest first. Editing an item does not change that order.

SQLite excludes any item whose combined kind, title, question, answer and content exceed 8 KiB in UTF-8. It returns at most the first 32 eligible items, with at most 256 KiB of field payload (plus bounded response serialization overhead). These limits apply before D1 materializes the result.

From those candidates, calls use a whole-item prefix within a 32 KiB budget: combined field bytes plus 32 bytes per item and 256 bytes for section formatting. Selection stops at the first item that would exceed this budget; it does not skip forward to smaller newer items. FAQs are never cut in half. The budget is conservative because some fields are not rendered. It bounds the knowledge sections, not the entire system prompt or model token count. Omitted items remain saved and active; they are not available to the assistant on that call. Shorten older items or detach collections to make room. Draft and unattached items are never included.

The Knowledge page discloses these limits:

> Calls use active items from attached collections, oldest first (creation time, then ID). Items over 8 KiB of combined UTF-8 fields are omitted. Of the first 32 eligible items, only the whole-item prefix fitting a 32 KiB budget, including formatting allowance, is used. Selection stops at the first item that does not fit. Omitted items stay saved but are unavailable during calls; shorten items or detach collections to make room.

Validation: `npx vitest run test/call-knowledge.test.ts test/call-session.test.ts` exercises the real migrated SQLite schema, byte/row boundaries, multibyte and embedded-NUL values, oversized FAQs, tenant/attachment/draft exclusion, stable ordering, whole-item omission and actual rendered knowledge size. The CallSession suite retains direct acknowledgement and carrier native greeting regressions. No live provider requests are required.
