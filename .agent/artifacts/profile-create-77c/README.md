# Profile creation — exact77c correction

Exact two-file assembly26e4387 over closed capturea4e1640 matches final owner6f2d1eb: Settings376bd195, browser8c8b4739 and patch34c46231. Independent QA5ae745e closes source/evidence/assembly. Manifest and assembly-identity.json retain70owner hashes (48initial+22targeted),47copied text evidence and23owner-local trace/image/context references.

The synchronous admitted-operation token serializes create, profile actions and Settings save/retry; pending rename excludes create. Revision-aware name drafts, accepted-row ID upsert and create-specific read suppression preserve current drafts and acknowledgement. No post-create refresh, backend idempotency, cross-tab or response-loss guarantee.

Initial frozen92057192: original7PASS8FAIL (seven intended assertions and one pre-POST fixture timeout); fixed19PASS1same timeout; both typesPASS. Original blur/create PASS remains nondiscriminating. Only duplicate initial gesture changed to locator.dblclick in8c8b4739. Targeted original1FAIL records two browser POST201 responses/two persisted IDs before first count assertion; fixed1PASS covers one POST/ID, no list read, accepted status, name clear and unchanged blur. No new full20PASS run or original later-assertion claim. Geometry was plausible, not proven cause of the initial timeout.

Initial221sampled-PID cleanup and targeted63sampled-PID cleanup remain separate; sampling is not exhaustive. Each removed two owned D1 leftovers after exit, and both explicitly released. Historical unrelated MCP preserved. No duplicate runtime; fresh published-head CI and separately granted official review remain required.
