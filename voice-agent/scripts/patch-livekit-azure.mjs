/** Minimal auth-only patch for pinned LiveKit 1.9.1. Fail closed on vendor drift. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = new URL(
  '../node_modules/@livekit/agents-plugin-openai/',
  import.meta.url
);
const version = JSON.parse(
  readFileSync(new URL('package.json', root), 'utf8')
).version;
if (version !== '1.9.1')
  throw Error('Azure auth patch requires reviewed LiveKit 1.9.1');
const hash = (s) => createHash('sha256').update(s).digest('hex');
const manifest = JSON.parse(
  readFileSync(new URL('./livekit-azure-patch.json', import.meta.url), 'utf8')
);
// Validate every file before changing any. A subsequent invocation accepts only exact patched bytes.
const updates = manifest.map(({ path, before, after }) => {
  const file = new URL(path, root),
    original = readFileSync(file, 'utf8');
  if (hash(original) === after) return null;
  if (hash(original) !== before)
    throw Error('Unexpected LiveKit source for Azure auth patch: ' + path);
  let patched = original.replace(
    'apiKey?: string;',
    "apiKey?: string;\n  /** OpenFon pinned patch: Azure resource key header; no bearer sent in this mode. */\n  apiKeyHeader?: 'Authorization' | 'api-key';"
  );
  if (!path.endsWith('.d.ts') && !path.endsWith('.d.cts'))
    patched = patched
      .replace(
        '      apiKey,',
        "      apiKey,\n      apiKeyHeader: options.apiKeyHeader ?? 'Authorization',"
      )
      .replace(
        'Authorization: `Bearer ${this.opts.apiKey}`',
        "...(this.opts.apiKeyHeader === 'api-key' ? {'api-key': this.opts.apiKey} : {Authorization: `Bearer ${this.opts.apiKey}`})"
      );
  if (hash(patched) !== after)
    throw Error('Azure auth patch output mismatch: ' + path);
  return { file, patched };
});
for (const update of updates)
  if (update) writeFileSync(update.file, update.patched);
console.log('Pinned LiveKit Azure auth patch verified.');
