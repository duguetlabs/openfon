# Your reception desk and connections

OpenFon opens at your reception desk. Prepare the business brief, choose how your receptionist answers, rehearse with the saved configuration, and review callers’ messages. Shared business facts and provider connections remain separate from each receptionist’s behavior.

| Where | What belongs here | Applies to |
| --- | --- | --- |
| Business brief | Business name, description, contact details and hours | Workspace |
| Who answers | First words, tone, language and voice | Selected receptionist |
| What they know | Services, FAQs and approved knowledge collections | Attached receptionists |
| How they help | Message-taking and extra handling instructions; optional bilingual examples | Selected receptionist |
| Connections | Engines, provider endpoints, keys, model defaults and summaries | Workspace connections; selected receptionist’s engine and overrides |
| Messages | Call details, transcripts and callback outcomes | Workspace calls |
| Account | Account export and confirmed deletion | Signed-in account |

Save your brief before rehearsing. Unsaved edits survive switching between brief sections. Provider, voice and summary controls have explicit save actions; closing a disclosure does not discard its values. A connection check tests the provider request only; a browser conversation is needed to assess the complete conversation and audio.

**Connections → Reusable voice setups** saves the selected receptionist’s current engine, model, language and voice under a name. Names save when their field loses focus. Use or delete a setup only after a pending rename finishes; actions are not queued behind the rename. Save pending voice and connection changes before using or creating a setup. Applying a setup changes only the selected receptionist and uses the destination workspace’s provider connections. A failed display refresh offers a read-only retry instead of repeating an acknowledged mutation.

**Connections → Take your receptionist with you** exports the saved configuration or reviews a local recipe. **Save this recipe** explicitly saves the reviewed behavior. Voice settings are optional and initially excluded. Provider connections, shared business facts and attached knowledge remain in the destination. See [assistant recipes](assistant-recipes.md).

Summary compatibility mode follows the assistant’s text-model override. Select the workspace connection or a separate summary provider to make summaries independent. Existing saved configurations are not automatically migrated.
