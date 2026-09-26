# Repository guidance

- Use Node 22.13+ and npm. Run checks appropriate to the change: `npm run typecheck`, `npm test`, and `npm run build`.
- Preserve provider defaults and existing application behavior unless the requested change requires otherwise.
- Keep tests and documentation in normal project paths. Do not commit generated test results, source inventories, agent coordination records, or local credentials.
- Capture `wrangler d1 export` stdout in a restricted local file instead of displaying it: the command prints a temporary signed database download URL. Report only backup location and validation results.
- This personal project uses `dsecret` for authorized secret access. Never print secrets or commit credential files.
- Synthetic tests do not establish live-provider, physical-audio or PSTN acceptance. Keep remaining acceptance items in `docs/launch/readiness.md`.
- Require current-commit CI and genuine PR-Agent security/major-issue clearance before merge. Hosted Codex review is suspended for this release until reinstated; existing findings still need resolution.
- Production deployment, remote migrations and carrier spending require separate authorization. `npm run deploy` is not a preview command.
