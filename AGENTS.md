# Repository guidance

- Use Node 22.13+ and npm. Run checks appropriate to the change: `npm run typecheck`, `npm test`, and `npm run build`.
- Preserve provider defaults and existing application behavior unless the requested change requires otherwise.
- Keep tests and documentation in normal project paths. Do not commit generated test results, source inventories, agent coordination records, or local credentials.
- Capture `wrangler d1 export` stdout in a restricted local file instead of displaying it: the command prints a temporary signed database download URL. Report only backup location and validation results.
- For every D1 export/execute, use the configured binding `DB` and an explicit environment config; verify the unique binding, `database_name`, database UUID and account first. `--config` alone does not constrain an unmatched positional database name: Wrangler can fall back to a different remote database. Staging commands use `DB --config wrangler.staging.json`, never positional `openfon`. Preserve staging's absent historical migration 0024; do not run an unqualified migration sweep there.

- This personal project uses `dsecret` for authorized secret access. Never print secrets or commit credential files.
- Synthetic tests do not establish live-provider, physical-audio or PSTN acceptance. Keep remaining acceptance items in `docs/launch/readiness.md`.
- Require current-commit CI and genuine PR-Agent security/major-issue clearance before merge. Hosted Codex review is suspended for this release until reinstated; existing findings still need resolution.
- Production deployment, remote migrations and carrier spending require separate authorization. `npm run deploy` is not a preview command.

- Keep current staging/production source, Worker version, migrations, flags and validation limits in `docs/launch/production-preflight.md`; label older observations as historical. Keep deployment status separate from provider and physical-call acceptance.
- Before production rollout, record staging validation for the exact candidate. Any proposed staging bypass must be explicit in the rollout approval request; local workerd tests are not a staging deployment.

- Branding: the chosen OpenFon logo is documented in `docs/brand/README.md`; use `docs/brand/lilita-f-variants/4-straighter-stem-tight-spacing.svg` (Lilita One, handset f variant 4, corrected f–o spacing) as the source of truth for branding work. Preserve its approved geometry and spacing. Older logo explorations and existing app assets are superseded design references.

- Brand identity and language: use `docs/brand/identity/README.md`, `guidelines.md`, and `voice.md` for visual standards, messaging, English/German examples and asset provenance. The approved logo is fixed; the broader identity is version 1. Preserve accurate product claims; the current application adopts the selected identity book’s Lilita One headings and Nunito Sans reading text.
