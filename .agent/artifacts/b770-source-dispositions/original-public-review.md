Official open-source PR-Agent — one-off local CLI full code/security review, published under the existing authorized personal GitHub account. This is actual PR-Agent output, not an independently authored QA review or a GitHub App identity.

- Reviewed PR16 head: `b7700fa4ead7ed88c625d146e7e8eaa63d7143cf` (verified before/after execution and immediately before publication).
- Official source: [The-PR-Agent/pr-agent@ca725b1](https://github.com/The-PR-Agent/pr-agent/tree/ca725b1ba511d82930d372ed9d79d9e95da23262), package 0.45.0, unchanged tracked source, frozen isolated dependencies.
- Official CLI: `pr_agent.cli.run_command(PR16_URL, "review")`; Kataleptic OpenAI-compatible endpoint, `gpt-5.6-sol`, medium reasoning, no fallback. Full-diff chunking and security review enabled, 20 findings allowed per chunk; original prompts unchanged.
- Standard PR-Agent file/asset filtering applies, including `.gitignore`, SVG and binary visual artifacts. This reviews eligible code diffs, not audiovisual acceptance. Any failed chunks or token-budget omissions reported below remain limitations.
- This is a fresh full review after the first run on `526be52`, whose original result remains [available](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5645886103). No result was edited or suppressed to obtain required phrases.

Original generated output follows unchanged.

---

## PR Reviewer Guide 🔍

Here are some key observations to aid the review process:

<table>
<tr><td>⏱️&nbsp;<strong>Estimated effort to review</strong>: 5 🔵🔵🔵🔵🔵</td></tr>
<tr><td>🧪&nbsp;<strong>PR contains tests</strong></td></tr>
<tr><td>🔒&nbsp;<strong>No security concerns identified</strong></td></tr>
<tr><td>⚡&nbsp;<strong>Recommended focus areas for review</strong><br><br>

<details><summary><a href='https://github.com/duguetlabs/openfon/pull/16/files#diff-89ec26df94e5ce5518ddc0789df15158d3c1f5270d3db86c597f16741df5a5d3R521-R524'><strong>Direct Startup</strong></a>

`runStart` unconditionally calls `resolveLlm` before resolving the realtime provider. A direct OpenAI realtime assistant configured with only `realtime_api_key` can therefore fail startup when no text LLM key exists, even though the realtime conversation itself does not require that configuration. Resolve the text provider only for pipeline operation or when text completion is actually needed.
</summary>

```typescript
// caller mid-conversation (realtime calls would only notice at summary time).
try {
  resolveLlm(this.env, this.settings);
  if (this.settings?.engine === 'realtime') this.realtimeConfig = resolveRealtime(this.env, this.settings);

```

</details>

<details><summary><a href='https://github.com/duguetlabs/openfon/pull/16/files#diff-25342a311206e2f6dcfb1e63660f7cb5d3967f75c639e9bc80ea2641dc6d3a19R403-R406'><strong>Stalled Calls</strong></a>

A successful `answer` command is marked permanently accepted without advancing `answered` or scheduling further verification. If the corresponding `call.answered` webhook is lost, the command is never retried and streaming is never started; the admitted call eventually reaches `media_setup_timeout` and is hung up. Use the stable command ID to retry until confirmation, reconcile provider state, or safely treat command success as the required transition.
</summary>

```typescript
if (accepted && command.action !== 'hangup') command.accepted = true;
// Successful hangup means command accepted, not proven carrier release.
// Keep the reservation and retry until a signed call.hangup is received.
command.nextAt = Date.now() + (accepted ? 30_000 : Math.min(60_000, 1000 * 2 ** Math.min(command.attempts, 6)));

```

</details>

<details><summary><a href='https://github.com/duguetlabs/openfon/pull/16/files#diff-f60b592eec00443b4219f48e9075a5ee821ad4bea2dc3d54878e357ac8e545baR1-R8'><strong>Test Discovery</strong></a>

Generated `.agent/artifacts` files include duplicate `*.test.ts` suites with relative imports resolved from their artifact directories. Standard Vitest discovery will collect these copies, where imports such as `../src/index` do not target the repository source tree, causing collection failures or running the account suite multiple times. Remove the generated artifact trees from the PR or explicitly exclude them from test and TypeScript discovery.
</summary>

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { AccountAuthBudget, accountAuthBudget } from '../src/account-auth-budget';
import { DatabaseSync } from 'node:sqlite';
import { createVerifiedSession, hashPassword, verifyPassword } from '../src/auth';
import { fakeCtx, fakeEnv } from './fake-d1';
import { applyMigrations, SqliteD1 } from './sqlite-d1';
import type { Env } from '../src/types';
```

</details>

<details><summary><a href='https://github.com/duguetlabs/openfon/pull/16/files#diff-daaccd12dc6edb5a89ca1bf44746ce813ad21241d8cfaabbc9977304dff9aef3R113-R116'><strong>Reorder Failure</strong></a>

The capacity check rejects the missing next packet when the reorder map is already full. For example, if chunks 2 through 11 arrive before chunk 1, all ten are buffered, but the subsequent chunk 1 triggers `reorder_overflow` instead of draining the now-contiguous sequence. Permit `chunk === nextChunk` to be inserted/drained at capacity, or process it directly before applying the buffered-packet limit.
</summary>

```typescript
if (chunk - this.nextChunk > 10 || this.reorder.size >= 10) throw new Error('reorder_overflow');
const bytes = decodePcmuFrame(media.payload).length;
if (this.reorderBytes + bytes > 8000) throw new Error('reorder_overflow');
this.reorder.set(chunk, { payload: media.payload as string, timestamp, sequence, bytes });

```

</details>

</td></tr>
</table>


<hr>

ℹ️ **Chunked review:** the diff exceeded the model token budget, so it was reviewed in 6 chunks and the per-chunk results were merged.
<hr>
<details> <summary><strong>⚙️ Agent run details</strong></summary>

- Model: gpt-5.6-sol
- Tokens: 1,001,839 in / 17,706 out / 1,019,545 total
- Time cost: 117.3s
- AI calls: 6

</details>

