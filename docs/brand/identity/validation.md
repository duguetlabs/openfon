# Identity validation — 27 September 2026

- Rendered and visually inspected the identity overview, social/poster asset geometry and the visual brand book. A caption collision in the first overview export was corrected before delivery.
- Native in-app browser inspection at desktop width and 390×844: layout readable; mobile document width equals viewport width (390px); all image elements loaded. Reviewed the mobile welcome, palette, type and voice samples.
- Logo selector: inverse treatment loads its matching SVG and updates the download link. English/German selection and missing-answer/failed-save situations update real copy. Palette button reports the selected hex code copied.
- Keyboard focus: independent review identified an invisible `currentColor` outline on selected controls. Replaced it with an explicit ink outline for logo/language controls and white for actions on blue. Browser keyboard inspection confirmed the ink outline; CSS defines it independently of button text color.
- `build_assets.py`: all eight documented reading pairs meet WCAG AA normal-text contrast. Ratios range from 4.61:1 to 14.39:1. The initial build required installing Brotli into the isolated logo-tools Python environment; the completed run passed.
- Exact structural comparison: all four full-wordmark derivatives retain the approved master’s path data and group/path transforms. Only intended fill colors differ. The app’s primary SVG equals the kit’s primary SVG byte for byte.
- All exported SVGs parse, PNGs decode, JSON files parse, and `node --check identity.js` passes. Internal HTML asset/document links and the final ZIP are checked during packaging.
- Impeccable mechanical detector: ran once over the identity HTML/CSS/JS; returned `[]`.
- Independent read-only review: geometry, visual consistency, readability and product-claim boundaries clear; the focus-outline issue above was the only material finding and was corrected.
- `npm run build`: passed (44 modules, Vite 6.4.3). Public hostname was unset, so the normal build omitted canonical URL/sitemap generation. No deployment was attempted.
- Native browser inspection of the local app welcome confirmed the chosen wordmark in the header and handset-f in the explanatory story. Product interactions and app UI typography were not redesigned.
- No application test suite or live calls were run for these asset and image-dimension edits. No provider, carrier, migration, staging or production acceptance is implied.

The first brand direction, line and typography extension are delivered for the user’s review; only the logo has prior explicit user approval.
