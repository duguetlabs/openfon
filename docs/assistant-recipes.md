# Move or reuse an assistant

OpenFon assistant recipes are small, versioned JSON files. Use them to reuse an assistant's behavior and voice selections in another OpenFon workspace without copying its credentials or account ownership.

Open **Connections → Take your receptionist with you**. **Export recipe** downloads the receptionist’s saved values; unsaved brief or connection edits are not included. An invalid or oversized configuration produces an error instead of a partial export.

To import, choose a recipe file and read the complete review. No configuration changes until you select **Save this recipe**. That action saves the reviewed behavior directly and leaves publication state unchanged. A failed save retains the review for an explicit retry.

When moving between different providers, leave **Also replace language, engine and voice settings** unchecked (the default) to keep the destination's existing selections. Otherwise the recipe's selections are copied, including blank values that inherit destination defaults. The recipe save checks supported model/voice compatibility for the destination provider. A saved custom model ID is not proof that the provider offers it: verify a private call after configuring access.

## What moves

| Included | Stays in the destination workspace |
| --- | --- |
| Assistant name, role, greeting, additional instructions and message-taking preference | Assistant ID, public link, publication state and call history |
| Language, conversation engine, model and voice selections, unless deselected during import | API keys, endpoints, workspace provider choices and summary configuration |
| Business information you wrote directly into the assistant's instructions | Shared business facts, hours, services, FAQs and attached knowledge collections |

Check shared business facts and approved knowledge in the destination before testing. Recipes intentionally omit collection IDs because IDs from a different workspace cannot identify the right knowledge. Existing attachments are preserved; importing does not attach or detach collections.

Provider credentials and connection fields are not exported. This is an explicit field allowlist, not a content scrubber: text you wrote in a greeting or instruction is included verbatim and may contain private business information. Review the file before sharing it.

Recipes are configuration transfer, not a backup or a complete account restore. **Account → Export** remains a separate archival snapshot. OpenFon's current runtime still depends on Cloudflare Workers, Durable Objects and D1.

## Version 1 contract

The root has exactly `format`, `version` and `assistant`. The assistant has exactly the fields shown below. Unknown fields, missing fields, unsupported versions, incorrect types and oversized files are rejected. Imports do not make network requests to any URL in the file.

```json
{
  "format": "openfon-assistant",
  "version": 1,
  "assistant": {
    "name": "Front desk",
    "greeting": "Hello. How can I help?",
    "persona": "A helpful receptionist for our business.",
    "language": "en",
    "voice": "en-US-AvaMultilingualNeural",
    "take_messages": true,
    "custom_instructions": "Take a callback request when you cannot answer.",
    "engine": "realtime",
    "realtime_model": "",
    "realtime_voice": "",
    "llm_model": ""
  }
}
```

Files are limited to 64 KiB of UTF-8 JSON. `take_messages` is a boolean; every other assistant field is text. `engine` is `realtime` or `pipeline`. Name, role (`persona`) and language cannot be blank. Character limits are 100 for name, 8,192 for greeting and role, 32,768 for instructions, 64 for language, 16 for engine and 256 for each model/voice ID. The total encoded byte limit also applies; multibyte text can reach it before a field's character limit.

The schema deliberately permits custom model namespaces. Only the destination provider can determine whether a custom model is actually available. No recipe carries evidence that a provider connection is working, that two model aliases are different underlying models, or that a real audio test succeeded.

Implementation: `web/src/assistant-config.ts` is a host-independent serializer/parser/patch library. `web/src/cleanroom/Connections.tsx` supplies local file review; persistence continues through `PUT /api/me/assistants/:assistantId`, with the existing tenant authorization and provider compatibility checks. Version 1 adds no database migration.
