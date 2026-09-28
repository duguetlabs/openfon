# OpenFon visual explanation

## Current direction

The user selected the actual [Brand Identity page](brand/identity/index.html) as the app’s visual reference. The welcome now uses its continuous blue masthead and hero, exact inverse wordmark, Lilita One 400 headline, Nunito Sans reading text, butter message slip and single open curved connector. The headline is “A warm welcome. A clear next step.” The direct action creates an account and receptionist; it does not start a call.

The blue first view pairs the product descriptor with an illustrative repair question and callback request. The slip explicitly distinguishes a request from a completed callback. The butter strip summarizes the real sequence: business information, browser rehearsal, review.

## The explanatory story

The workshop photograph sits in a later paper-backed explanation, following the reference page’s use of photography in its application section. The three user-controlled stages preserve the original causal example:

1. Harbour Bicycle Workshop supplies Saturday opening hours and bicycle-service facts.
2. The receptionist’s illustrative answer uses those hours, then offers to take a message.
3. Alex’s brake-service request becomes a callback message, with a masked illustrative contact.

This scene is a labeled AI-generated illustration and the dialogue is synthetic, not customer evidence. The source note, answer and message are HTML text. No media generation was performed for the brand-page redesign.

## Entry points

- Guest `/` is the full welcome. `/login` and `/signup` open the real account flow directly.
- Signed-in “How it works” opens the explanation and returns directly to the receptionist. It adds no mandatory step before rehearsal.
- The signed-in desk has a compact, dismissible blue introduction and a butter next-step note. Actual draft/active/paused state is retained; actual live messages take priority. The dismissal preference stays scoped to the workspace.
- Authentication uses the same blue brand line and a practical butter note. Business setup pairs a generous introduction with a normal labeled form.

## Accessibility and behavior

The story advances only on explicit button actions, with no timer or autoplay audio/video. It sends no provider request. Step controls expose `aria-pressed`; next-stage actions focus the persistent newly selected step control. Reduced-motion preferences remove nonessential transitions. Guest and signed-in layouts each retain one main landmark.

The public and operating flows continue to distinguish a configured connection, a browser conversation, captured message, and completed action. Nothing in the illustrative story establishes live-provider, physical-audio, PSTN or production acceptance.

## Assets and evidence

The approved logo geometry is unchanged; local Lilita One and Nunito Sans WOFF2 files ship with their SIL OFL notices. The existing responsive workshop WebPs remain under `web/public/media/openfon/`. Their original generation cost was $0.16; provenance is in [openfon-media-provenance.md](openfon-media-provenance.md).

Current design rules are in [cleanroom-design.md](cleanroom-design.md), and actual validation results belong in [cleanroom-validation.md](cleanroom-validation.md). Historical screenshots of the earlier photograph-led welcome are not evidence of this final redesign.
