/**
 * Emit the exact system prompt OpenFon would send for the Riverside Dental
 * fixture, by calling the real `buildSystemPrompt`.
 *
 * The Python harness cannot import TypeScript, and re-implementing the prompt
 * would mean benchmarking a prompt the product does not actually use — the
 * calendar block alone is load-bearing for every date question in the scenario
 * set. So we render it here and hand the harness a frozen artefact.
 *
 *   npx vite-node bench/quality/gen_prompt.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSystemPrompt, defaultGreeting, sttVocab } from '../../src/prompt';
import type { AgentSettings, Business } from '../../src/types';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  await import('node:fs').then((fs) => fs.readFileSync(join(here, 'fixtures/riverside.json'), 'utf8')),
) as { business: Business; settings: AgentSettings; now: string };

// Pinned instant: the prompt embeds a 21-day calendar, so a moving "now" would
// silently change every date-grounded expectation between runs.
const now = new Date(fixture.now);

const out = {
  generated_from: 'src/prompt.ts buildSystemPrompt',
  now: fixture.now,
  business: fixture.business.name,
  language: fixture.settings.language,
  greeting: defaultGreeting(fixture.business, fixture.settings),
  stt_vocab: sttVocab(fixture.business, fixture.settings),
  system_prompt: buildSystemPrompt(fixture.business, fixture.settings, now),
};

writeFileSync(join(here, 'fixtures/riverside-prompt.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`system prompt: ${out.system_prompt.length} chars`);
console.log(`greeting: ${out.greeting}`);
