import { useId, useState } from 'react';
import { Button, TextArea, inputClass } from './ui';

import { promptExamples as examples } from './prompt-examples-data';

export function PromptExamples({ current, onUse }: { current: string; onUse: (prompt: string) => void }) {
  const selectId = useId();
  const [selectedId, setSelectedId] = useState(examples[0].id);
  const selected = examples.find(example => example.id === selectedId)!;
  return <details className="rounded-xl border border-line-strong p-4">
    <summary className="cursor-pointer font-medium">Example prompts · Deutsch & English</summary>
    <div className="mt-4 space-y-4">
      <p className="text-sm text-ink-soft">Fictional local businesses to help you get started. Adapt the wording to your business and add its real facts in Settings and Knowledge.</p>
      <div><label htmlFor={selectId} className="block text-sm">Business example</label>
        <select id={selectId} className={inputClass} value={selectedId} onChange={e => setSelectedId(e.target.value)}>
          {examples.map(example => <option key={example.id} value={example.id}>{example.label}</option>)}
        </select>
      </div>
      <TextArea label="Example instructions" readOnly lang={selected.id.endsWith('-de') ? 'de' : 'en'} rows={9} value={selected.prompt} />
      <p className="text-sm text-ink-soft">Suggested default language: {selected.language}. Using this prompt changes only Additional instructions. Check your business name, opening greeting and language separately, then save.</p>
      <Button type="button" variant="ghost" onClick={() => {
        if (current.trim() && !window.confirm('Replace your additional instructions with this example? Other assistant settings will stay as they are.')) return;
        onUse(selected.prompt);
      }}>Use this prompt</Button>
    </div>
  </details>;
}
