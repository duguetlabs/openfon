import { useState } from "react";
import { promptExamples } from "../prompt-examples-data";
import { Button, Field } from "./ui";

export function PromptExamples({ current, onUse }: { current: string; onUse: (instructions: string) => void }) {
  const [selectedId, setSelectedId] = useState(promptExamples[0].id);
  const selected = promptExamples.find(example => example.id === selectedId)!;
  return <details className="of-provider-section of-prompt-examples">
    <summary><span>Use an example</span><small>Deutsch & English</small></summary>
    <div className="of-form">
      <p className="of-help">Fictional businesses to help you get started. Adapt the instructions to your business and add real facts in your business brief and knowledge.</p>
      <Field label="Business example">
        <select value={selectedId} onChange={e => setSelectedId(e.target.value)}>
          {promptExamples.map(example => <option key={example.id} value={example.id}>{example.label}</option>)}
        </select>
      </Field>
      <Field label="Example instructions">
        <textarea readOnly lang={selected.id.endsWith("-de") ? "de" : "en"} rows={9} value={selected.prompt} />
      </Field>
      <p className="of-help">Suggested language: {selected.language}. This replaces only the extra instructions above. Check the first words and language separately, then save your brief.</p>
      <Button kind="line" onClick={() => {
        if (current.trim() && !window.confirm("Replace your extra instructions with this example? Your other receptionist settings stay as they are.")) return;
        onUse(selected.prompt);
      }}>Use these instructions</Button>
    </div>
  </details>;
}
