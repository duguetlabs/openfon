# OpenFon identity kit

Open [index.html](index.html) for the visual brand book. The identity expands the user-approved Lilita One handset-f logo into a complete first brand direction: **A warm welcome. A clear next step.**

## Start here

- [Visual brand book](index.html): responsive, local fonts, logo treatment selector, copyable palette, English/German voice examples and downloads.
- [Strategy](strategy.md): audience, positioning, values, message hierarchy and evidence boundaries.
- [Guidelines](guidelines.md): visual and verbal standards, exact color pairs, logo use and application rules.
- [Voice guide](voice.md): vocabulary, tone, copy rewrites, receptionist scripts and English/German examples.
- [Design contract](DESIGN.md) and [product context](PRODUCT.md): instructions for future design work.
- [Identity overview](assets/openfon-brand-board.png) and [downloadable kit](openfon-brand-kit.zip).

## Skill selection and method

Used the MIT-licensed [Brand Building Skills](https://github.com/arnabbagxd/Brand-building-skills) collection: `brand-strategy`, `brand-identity`, `brand-voice`, `brand-guidelines`. Source pinned to commit `4a0a8b5b7a0f64bf0fc551978a18a591670a5223`. Installed under the local Codex skills directory; they are available for later turns. The existing Impeccable skill guided visual execution and inspection.

The supplied logo and product records were used as the brief. No redundant intake questionnaire was required. Unsupported demographic, founder-history and competitor-ranking template fields were replaced by explicit unknowns or task-based hypotheses. The core audience and behavior come from the current product/functional contracts; the brand line, typography extension and message-slip system are design recommendations developed in this task.

## Sources and rights

- Logo: user-approved [canonical master](../lilita-f-variants/4-straighter-stem-tight-spacing.svg). Derivatives preserve every path and transform.
- Lilita One and Nunito Sans: Google Fonts, SIL Open Font License. License notices and source TTFs are in `assets/fonts/`; optimized WOFF2s power the book. The social card, poster and overview use outlined lettering.
- Workshop image: copied from the existing project illustration. No new image generation was purchased. [Original provenance](../../openfon-media-provenance.md).
- Product: [current product context](../../../web/src/cleanroom/PRODUCT.md), [functional contract](../../cleanroom-functional-contract.md), [release readiness](../../launch/readiness.md).

## Implementation scope

The reusable identity is implemented in this directory. The chosen logo derivatives, favicon and social preview also replace the older local public brand assets. The user subsequently selected this Brand Identity page as the application’s visual authority. The app now uses its blue welcome, Lilita One headings and Nunito Sans reading text while preserving provider defaults and product safety contracts. No production deployment is part of this integration.

## Rebuilding and viewing

Use a Python environment with `fonttools`, `brotli` and `cairosvg`, then run `python docs/brand/identity/build_assets.py` from the repository root. This writes only `assets/`; it never edits the approved master or silently copies into the application. Keep the workshop asset and font sources in place.

Open `index.html` directly or serve the repository with `python3 -m http.server 8766 --bind 127.0.0.1`, then visit `/docs/brand/identity/index.html`. Clipboard copying requires a browser that supports the Clipboard API on the current origin; a visible hex-code fallback is provided. All other book interactions work without a backend or external network request.

Application integration copies generated SVG/PNG assets into the existing `web/public/brand/` paths, plus `web/public/favicon.svg` and `web/public/social-card.{svg,png}`. The clean-room header image dimensions match the new wordmark’s aspect ratio. The app implements the selected palette and typography in its scoped stylesheet. The original downloadable kit and its `appCurrent` token record the pre-integration typography; the current application contract is `web/src/cleanroom/DESIGN.md`.

## Validation

Final observations and checks are recorded in [validation.md](validation.md). Asset-only checks verify SVG geometry, decoding, internal references and contrast. Application build verification checks that existing asset references still package successfully. These do not establish live-call or carrier acceptance.
