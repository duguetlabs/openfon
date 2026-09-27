# OpenFon brand guidelines

Edition 1 · September 2026

Use this guide for design, copy, product surfaces and partner material. The approved logo is fixed; the surrounding identity is the first direction developed from it. [Strategy](strategy.md) explains the choices. [Voice](voice.md) provides extended English and German examples. [The visual book](index.html) shows the identity in use.

## Foundation

**Core idea:** A warm welcome. A clear next step.

**Mission:** Help small businesses prepare, test and improve a voice receptionist using their approved information, with clear messages for follow-up.

**Vision:** A useful first response that stays under the business owner’s control.

**Values:** Hospitality, clarity, practical care, owner control and candor.

**Personality:** Welcoming, capable, plainspoken, attentive and open.

**Positioning:** A configurable AI receptionist for small businesses. Teach it the business, try it in the browser and review what callers needed. Provider choice is useful supporting evidence; it is not the headline for a busy owner.

## Logo

The primary wordmark uses Lilita One with a handset-shaped f, selected variant 4. The handset is tilted 5° clockwise, with a horizontal crossbar and compact lower foot. The trailing “on” is shifted 6 source units left to create the approved f–o gap. All derivatives preserve those paths and positions.

| Asset | Use |
| --- | --- |
| `assets/openfon-logo-primary.svg` | Blue f and navy letters on white or paper |
| `assets/openfon-logo-inverse.svg` | Butter f and white letters on blue or ink |
| `assets/openfon-logo-mono.svg` | Single navy color for simple reproduction |
| `assets/openfon-logo-white.svg` | Single white color on sufficiently dark backgrounds |
| `assets/openfon-mark-blue.svg` | Standalone handset-f on a light background |
| `assets/openfon-mark-inverse.svg` | Butter handset-f on blue or ink |
| `assets/favicon.svg` | Small square mark with its own blue background |

PNG exports accompany the SVGs. Full-logo PNGs are transparent. The visual book shows them on a background; the files do not bake one in. Use SVG for screens whenever possible.

**Clear space:** at least half the height of the lowercase o on all four sides, beyond the visible artwork. The SVG’s built-in margins are not the complete required clear space. At a 154px-wide wordmark, allow about 11px of external space.

**Minimum size:** 120px wide for the full wordmark in digital contexts; 28mm wide is a print starting point that must be proofed. Use the handset-f favicon treatment at 16–32px and symbol artwork at 24px and above. Never recreate the wordmark by typing its name.

Do not stretch, outline, shadow, rotate, re-space or redraw the logo. Do not replace the f with another phone symbol. Do not use the earlier open-loop mark or handwritten explorations. Avoid busy-image placement; use a solid brand-color area with sufficient clear space. The three logo references considered earlier—early Notion, Open Peeps and conventional telephone imagery—inform familiarity and human character only; their artwork is not part of this identity.

## Palette

The core palette is a blue-led system with a warm butter accent and navy ink. “Paper” is a cool near-white working background. Color names describe use, not a promise about feelings.

| Color | HEX | RGB | Role |
| --- | --- | --- | --- |
| Blue | `#2457c5` | 36, 87, 197 | Primary action, brand fields, handset |
| Ink | `#152a49` | 21, 42, 73 | Main text and monochrome artwork |
| Butter | `#f6e99b` | 246, 233, 155 | Welcome accent, message-slip surface, inverse handset |
| Paper | `#f3f5f8` | 243, 245, 248 | Working background |
| White | `#ffffff` | 255, 255, 255 | Content and reversed text |
| Muted | `#5f708a` | 95, 112, 138 | Secondary text on white or paper |
| Blue deep | `#18449f` | 24, 68, 159 | Hover and depth on blue |
| Line | `#dce3ed` | 220, 227, 237 | Nonessential separators, not an input’s only boundary |

Success `#216246` and error `#a52f3f` are semantic utility colors, not campaign accents. Always label the state in text. Existing operational states keep their current behavior.

Recommended composition: marketing can give blue 30–60% of the visible area, use butter as a purposeful accent, and leave white/paper for reading. Operational UI should stay mostly light with blue focused on actions. Avoid adding a separate decorative palette to each page.

| Text / background | Contrast ratio | Normal text AA |
| --- | ---: | --- |
| Ink / white | 14.39:1 | Pass |
| Ink / paper | 13.18:1 | Pass |
| Ink / butter | 11.68:1 | Pass |
| White / blue | 6.47:1 | Pass |
| Butter / blue | 5.25:1 | Pass |
| Muted / white | 5.03:1 | Pass |
| Muted / paper | 4.61:1 | Pass |

Do not use white text on butter or muted text on blue. The contrast report measures these exact opaque pairs; images, transparency and new colors require their own check. Print values depend on the stock, printer and ICC profile: no Pantone match or universal CMYK conversion is asserted. Ask the print supplier for a physical proof.

## Typography

| Role | Face and weight | Digital size | Line height |
| --- | --- | --- | --- |
| Wordmark | Supplied vector artwork | Minimum 120px total width | Preserve artwork |
| Short campaign headline | Lilita One Regular 400 | 40–72px | 1.02–1.1 |
| Section headline | Lilita One Regular 400 | 28–48px | 1.08–1.2 |
| Reading title / subheading | Nunito Sans 700–750 | 20–32px | 1.2–1.35 |
| Body | Nunito Sans 400 | 16–18px | 1.6 |
| Label / action | Nunito Sans 650–750 | 15–16px | 1.4 |
| Metadata / caption | Nunito Sans 400–600 | 14px | 1.5 |

Lilita One is the expressive voice. Use it for short, useful thoughts, not form labels or paragraphs. Keep tracking close to normal; no synthetic bold. Nunito Sans has open, rounded shapes that complement the logo without competing with it. Both are bundled with SIL Open Font License notices. Keep license notices with redistributed fonts; font licensing does not transfer trademark ownership.

Fallback: `"Nunito Sans", "Avenir Next", "Segoe UI", system-ui, sans-serif`. The identity book and current application use locally bundled Nunito Sans. Lilita One remains reserved for short display headings; controls and longer data titles use Nunito Sans.

## Imagery, icons and graphic language

Show a person doing meaningful work in an ordinary business environment: a workshop, a service counter or a studio. Favor natural light, useful hands and tools, and real detail. Preserve skin tones and material colors; do not apply a heavy blue filter. Leave space for copy without obscuring the work. Obtain appropriate rights for real campaign photography.

The included workshop scene is an existing AI-generated illustration, not a customer photograph. Its use remains labeled in the book. The call dialogue is illustrative too. See [media provenance](../../openfon-media-provenance.md).

Use a simple open curve to connect a question to its response in explanatory material. It echoes the handset’s curve without duplicating or deforming the logo. Functional icons use a consistent 2px stroke on a 24px grid, rounded joins, and accessible labels. Reserve the filled handset-f for brand identification. No decorative waveform, sparkle, AI brain, stock headset operator or cartoon mascot is needed.

## Layout and motion

Use a strong left alignment, clear type hierarchy and a spacing scale of 4, 8, 12, 16, 24, 32, 48, 64 and 80px. Keep related controls close; give separate tasks more space. Controls have 8px corners; message sheets can use 16px corners. Minimum control target is 44px. Place visible labels above inputs.

A message slip may have one slight rotation in marketing illustration. Operational data and forms stay square and stable. A blue field, butter note and ordinary text can carry the identity without decoration. Buttons use a short 180ms transition; reduced-motion preferences remove nonessential motion. Never animate a fake live call to suggest a real successful test.

## Verbal identity and messages

OpenFon sounds like a capable front-desk colleague. It is warm in invitations, exact in statuses and calm in failures. Say what the owner or caller can do next. Use sentence case, active verbs and short paragraphs. “AI receptionist” introduces the product honestly; a business can configure its receptionist’s tone without changing OpenFon’s corporate voice.

Use: message, caller, conversation, business information, opening hours, choose a voice, try, review, save, share, connections. Keep provider jargon in the appropriate technical context.

Avoid: “never miss a call,” “guaranteed,” “human replacement,” “fully autonomous,” “seamless,” “revolutionary,” false urgency, invented testimonials and unsupported compliance claims.

**Brand line:** A warm welcome. A clear next step.

**Descriptor:** An AI receptionist for small businesses.

**Value proposition:** Teach your receptionist about your business. Try a conversation in your browser. Review what callers needed.

**Supporting messages:** Your business, in your own words. / Try it before you share it. / See what callers needed. / Set it up around the business.

German default: Sie. Brand line: “Freundlich empfangen. Klar weiterhelfen.” Descriptor: “Eine KI-Rezeption für kleine Unternehmen.” Follow the [voice guide](voice.md) for tone by situation and further examples. These are copy resources, not a claim of complete product localization.

## Brand in use

- **Website:** Keep the descriptor close to the brand line. Use one meaningful invitation tied to a real setup or test flow. Label illustrative product demonstrations.
- **Product:** Use the full primary logo on light surfaces and inverse on blue. Keep data, errors and next actions readable. Preserve the existing interaction model.
- **Social:** Use the handset-f for the avatar and the supplied 1200×630 card for link sharing. Use one familiar work situation per post; do not add unverified metrics.
- **Email:** Use the primary wordmark on white, a plain heading and one next step. When images are unavailable, write “OpenFon” as text. Use actual sender and support details supplied by the operator.
- **Stationery:** Primary logo in the upper left, generous clear space, readable contact details below. Do not put sample phone numbers, addresses or QR codes into a production template.
- **Presentations:** One message per slide; title 40–64px, body 24px or larger. Blue opening/closing slides and white reading slides. Use actual evidence for claims; the included identity board is a visual reference, not customer proof.
- **Print:** Use the outlined poster SVG as a starting point. Add trim/bleed for the chosen final format and proof color with the supplier. Current artwork is RGB and is not a press-certified file.

## Ownership and assets

Cristian owns brand decisions. The user-approved SVG remains `docs/brand/lilita-f-variants/4-straighter-stem-tight-spacing.svg`. All generated derivatives in `assets/` can be rebuilt by `build_assets.py`; `assets/manifest.json` records their hashes. The current kit is downloadable as `openfon-brand-kit.zip`.

The visual book, token files, artwork and copy are implemented. Production publishing, carrier acceptance and business-wide app typography rollout are not implied. Review new claims against current product and release documents before publication.
