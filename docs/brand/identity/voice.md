# OpenFon voice and language

## Voice essence

OpenFon sounds like a capable front-desk colleague: welcoming, clear and attentive. It explains what happened and what to do next. It names the AI receptionist honestly and leaves room for the business’s own personality. It never pretends that a reassuring tone proves a successful call.

## Tone dimensions

| Dimension | Position | Example |
| --- | --- | --- |
| Formality | Conversational, with complete sentences | “Add the details your callers ask about.” |
| Energy | Upbeat at the start; calm while working | “Let’s try a conversation.” |
| Humor | A light touch in campaigns; none in failures | “Keep your hands on your business.” |
| Expertise | Plain first, technical when useful | “Choose a voice. You can change the model in Connections.” |
| Warmth | Helpful without forced intimacy | “Your changes haven’t been saved. Try again.” |

## Voice qualities in practice

| Quality | Write this | Avoid this |
| --- | --- | --- |
| Concrete | “Add your opening hours.” | “Empower your agent with contextual intelligence.” |
| Helpful | “Allow microphone access, or continue by typing.” | “Microphone error.” |
| Honest | “The call connected. Try speaking to check the audio.” | “Your receptionist works perfectly.” |
| Attentive | “The caller asked about a repair and left a message.” | “Lead captured successfully.” |
| Respectful | “Choose when to share your receptionist.” | “You’re missing customers every second.” |
| Direct | “Save changes.” | “Embark on your configuration journey.” |

## Vocabulary

Prefer: receptionist, business, caller, conversation, message, callback request, business information, opening hours, choose a voice, try, teach, save, review, share, connections.

Avoid in everyday copy: agentic, orchestration, inference, omnichannel, frictionless, seamless, revolutionary, game-changing, superhuman, human replacement, guaranteed, never miss a call, unlimited, fully autonomous, instant ROI. Exact technical terms belong in technical documentation when they help explain a real configuration.

Write **OpenFon** in prose and **openfon** only in the artwork. Use “AI receptionist” on first introduction; “receptionist” can follow. “Assistant” remains valid where it is an existing product label or API concept. Do not casually rename navigation labels or statuses without changing their functional documentation. An OpenFon workspace belongs to a business; callers are not automatically leads.

## Writing rules

- Aim for one idea per sentence, usually 8–20 words. Longer technical explanations can be split into short paragraphs.
- Use sentence case. Keep labels and button text in sentence case too.
- Start buttons with an action: Save changes, Try again, Review message, Add business information.
- Use English contractions naturally. Avoid strings of exclamation marks and ellipses that imply hidden work.
- Write numbers as digits in controls and data. Include units and timezone where they matter.
- Name the action’s real result. “Message taken” is not “Callback completed.” “Booking requested” is not “Appointment booked.”
- Mention preserved edits only if the relevant UI actually preserves them. A failed refresh is not a failed acknowledged save.
- Never obscure a destructive action with humor. Never invent a support contact, time guarantee, customer quote or success metric.

## Tone by channel

| Channel | Treatment | Example |
| --- | --- | --- |
| Homepage | Short, inviting, immediately concrete | “A warm welcome. A clear next step. An AI receptionist for small businesses.” |
| Social | One familiar situation and one practical idea | “Busy with a customer? Give callers a place to start.” |
| Welcome email | Reassuring, action-focused | “Start with your opening hours and the questions you hear most. Then try a conversation.” |
| Support | Name what failed and a next step | “The connection check failed. Review the provider details and try again.” |
| Error | Precise, quiet, recoverable | “We couldn’t save your changes. Try again.” |
| Empty state | Explain the state without invented activity | “No messages yet. Conversations with a captured message will appear here.” |
| Technical documentation | Exact, explicit about scope | “The connection check validates text generation. Test audio separately.” |

## English and German

Use **Sie** as the default for German owner-facing and caller-facing copy. It is a respectful starting point across business sectors. A business can deliberately choose a different receptionist persona; do not mix du and Sie in the same experience. This is a recommended editorial convention, not a claim that the product has complete German UI localization.

| Context | English | German |
| --- | --- | --- |
| Brand line | A warm welcome. A clear next step. | Freundlich empfangen. Klar weiterhelfen. |
| Descriptor | An AI receptionist for small businesses. | Eine KI-Rezeption für kleine Unternehmen. |
| Teaching | Add the details your callers ask about. | Ergänzen Sie die Informationen, nach denen Ihre Anrufenden fragen. |
| Try action | Try your receptionist | Rezeption testen |
| Review action | Review message | Nachricht ansehen |
| Save action | Save changes | Änderungen speichern |
| Save confirmation | Changes saved. | Änderungen gespeichert. |
| Failed save | We couldn’t save your changes. Try again. | Ihre Änderungen konnten nicht gespeichert werden. Versuchen Sie es erneut. |
| Callback request | Callback requested | Rückruf gewünscht |
| Booking request | Booking requested | Termin angefragt |
| Missing answer | I don’t have that information. May I take a message? | Diese Information liegt mir nicht vor. Darf ich eine Nachricht aufnehmen? |

Transcreate headlines rather than copying English idioms literally. Use clear local date/time conventions, keep telephone country codes intact and avoid assumptions about a caller’s gender. Have a native reviewer assess sector-specific launch campaigns before publication.

## The receptionist’s voice is the business’s voice

Example script, not a mandatory change to saved assistants:

> “Hello, you’re speaking with the AI receptionist for [business name]. How can I help?”

> “Guten Tag, hier ist die KI-Rezeption von [Unternehmensname]. Wie kann ich Ihnen helfen?”

When information is missing, ask permission to take a message. When requesting a callback number, explain why it is needed. Do not promise when someone will call back without business instructions that support it. Do not say that a person is on the line, a calendar appointment is confirmed, or a request has been completed when it has only been recorded.

## Before and after

| Before | After | Reason |
| --- | --- | --- |
| “Deploy an autonomous agent in seconds.” | “Set up your receptionist, then try a conversation.” | Names the journey without an unverified time claim. |
| “Never miss another customer.” | “Give callers a useful first response.” | Expresses purpose without an availability guarantee. |
| “Your appointment is confirmed.” | “Your appointment request has been recorded.” | Matches a captured request when no booking integration exists. |
| “Oopsie! Something went sideways.” | “The call couldn’t start. Check your connection and try again.” | Makes the failure understandable and recoverable. |
| “100% accurate answers from your entire knowledge base.” | “Answers use approved business information available to the conversation.” | Respects context limits and model uncertainty. |

## Never say

Do not use fake urgency, invented testimonials, shame about missed inquiries, “a real person” for an AI assistant, guaranteed revenue, “GDPR compliant” without a scoped assessment, “works with every provider,” “runs anywhere,” or “fully tested” based on a connection status alone.
