# Settings and assistants

OpenFon keeps shared workspace configuration separate from each assistant’s
conversation. Changing a business detail does not overwrite an assistant’s voice
or instructions.

| Where | What belongs here | Applies to |
| --- | --- | --- |
| Settings → Business | Name, contact details, opening hours, services, closures and common FAQs | All assistants in this workspace |
| Settings → AI connections | Provider endpoints, component API keys and shared model defaults | Assistants using that component |
| Settings → Call summaries | The provider and model used after conversations finish | Workspace call summaries |
| Assistants → Configure | Personality, greeting, instructions, language, engine, model and voice | The selected assistant |
| Knowledge | Reusable approved answers grouped into collections | Assistants attached to each collection |

Expand an AI connection to configure text generation, speech recognition,
realtime voice or speech synthesis. Each component supports its own provider
configuration; credentials stay in workspace settings rather than voice profiles.
An assistant’s engine determines which components it uses. Realtime conversation
models provide their own listening and speaking; Pipeline uses separate components.

Business, AI connections and call summaries have separate save buttons. Jumping
between these sections or closing a connection does not discard entered values.
Save before navigating to another page. A provider connection check only verifies
the named component; use a test call to check the conversation and audio.

Existing engine profiles remain under **Settings → Saved voice setups**. They
apply only to the primary assistant. Applying one replaces that assistant’s engine,
model, language and voice, while other assistants and unsaved business details stay
unchanged. To create a setup, first configure the primary assistant in Assistants,
save it, then return to Settings and save the current setup under a name.

In summary compatibility mode, assistant text-model overrides may still determine
call summaries. Select the workspace text provider or a separate summary provider
to make summaries independent. This redesign does not change saved configurations
or automatically migrate compatibility settings.
