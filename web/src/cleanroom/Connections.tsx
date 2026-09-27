import { useEffect, useRef, useState } from "react";
import {
  api,
  exportAssistantRecipe,
  parseAssistantRecipe,
  assistantRecipePatch,
  voiceChoicesFor,
} from "../cleanroom-runtime";
import type {
  Assistant,
  AssistantFields,
  AssistantRecipe,
  Provider,
  ProviderPatch,
  ProviderCatalog,
  SummarySettings,
  Preset,
} from "../cleanroom-runtime";
import { Button, Field, Notice, Loading, errorText, useDirtyGuard } from "./ui";
import { Icon } from "./icons";
export function Connections({
  assistant,
  onBack,
  onSaved,
}: {
  assistant: Assistant;
  onBack: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [provider, setProvider] = useState<Provider | null>(null);
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null);
  const [catalogUnavailable, setCatalogUnavailable] = useState(false);
  const [patch, setPatch] = useState<ProviderPatch>({});
  const [voice, setVoice] = useState<Partial<AssistantFields>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [recipe, setRecipe] = useState<AssistantRecipe | null>(null);
  const recipeLoad = useRef(0);
  const [summary, setSummary] = useState<SummarySettings | null>(null);
  const [summaryKey, setSummaryKey] = useState("");
  const [savedSummary, setSavedSummary] = useState<SummarySettings | null>(
    null,
  );
  const [summaryError, setSummaryError] = useState("");
  const [summaryNotice, setSummaryNotice] = useState("");
  const summaryVersion = useRef(0);
  const summaryDirty = !!summary && (!!summaryKey || JSON.stringify(summary) !== JSON.stringify(savedSummary));
  function changeSummary(fields: Partial<SummarySettings>) {
    summaryVersion.current++;
    setSummary(current => current && { ...current, ...fields });
    setSummaryNotice("");
  }
  async function writeSummary(reload = false) {
    if (!summary || (!reload && !summaryDirty)) return;
    const token = begin("settings"); if (!token) return;
    const version = summaryVersion.current;
    setSummaryError(""); setSummaryNotice("");
    try {
      const saved = reload ? await api.summaries() : await api.saveSummaries({
        mode: summary.mode, baseUrl: summary.baseUrl, model: summary.model,
        revision: savedSummary?.revision ?? null, apiKey: summary.mode === "custom" ? summaryKey : "",
      });
      setSavedSummary(saved);
      if (summaryVersion.current === version) { setSummary(saved); setSummaryKey(""); }
      else setSummary(current => current && { ...current, revision: saved.revision, apiKeyConfigured: saved.apiKeyConfigured });
      if (!reload) setSummaryNotice("Summary settings saved.");
    } catch (e) { setSummaryError(errorText(e)); }
    finally { finish(token); }
  }
  const [includeVoice, setIncludeVoice] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetName, setPresetName] = useState("");
  const operation = useRef<{ kind: "create" | "setup" | "settings" } | null>(null);
  const nameVersion = useRef(0);
  const listGeneration = useRef(0);
  const savedNames = useRef(new Map<string, string>());
  const editVersions = useRef(new Map<string, number>());
  const renames = useRef(new Map<string, { queued?: { name: string; version: number | undefined } }>());
  const [renaming, setRenaming] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const refreshKind = useRef<"apply" | "list">("list");
  const [loadFailed, setLoadFailed] = useState(false);
  const [connectionsRefreshPending, setConnectionsRefreshPending] = useState(false);
  const blocked = busy || renaming || refreshPending || connectionsRefreshPending;
  const voiceDirty = Object.keys(voice).length > 0 || Object.keys(patch).length > 0;

  function begin(kind: "create" | "setup" | "settings", recovery = false) {
    // Blur runs before click; refs admit writes before React renders disabled controls.
    if (operation.current || renames.current.size || ((refreshPending || connectionsRefreshPending) && !recovery)) return null;
    const token = { kind };
    operation.current = token;
    listGeneration.current++;
    setBusy(true);
    return token;
  }
  function finish(token: NonNullable<typeof operation.current>) {
    if (operation.current !== token) return;
    operation.current = null;
    setBusy(false);
  }
  async function loadPresets(recovery = false) {
    if (operation.current && !recovery) return false;
    const generation = ++listGeneration.current;
    const rows = await api.presets();
    if (generation !== listGeneration.current || (operation.current && !recovery)) return false;
    const previous = new Map(savedNames.current);
    setPresets(current => rows.map(row => {
      const draft = current.find(old => old.id === row.id);
      return draft && previous.has(row.id) && draft.name !== previous.get(row.id)
        ? { ...row, name: draft.name } : row;
    }));
    for (const row of rows) savedNames.current.set(row.id, row.name);
    return true;
  }
  async function refreshSetups() {
    try {
      if (refreshKind.current === "apply") await onSaved();
      if (!await loadPresets(true)) throw new Error("A newer read started. Retry the refresh.");
      setRefreshPending(false);
      setError("");
    } catch (e) {
      setError(`The setup change was saved, but its display could not refresh: ${errorText(e)}`);
    }
  }
  async function setupAction(preset: Preset, remove = false) {
    if (!remove && voiceDirty) return;
    const token = begin("setup");
    if (!token) return;
    setError("");
    try {
      if (remove) await api.deletePreset(preset.id);
      else await api.applyPreset(preset.id, assistant.id);
      listGeneration.current++;
      if (remove) setPresets(rows => rows.filter(row => row.id !== preset.id));
      refreshKind.current = remove ? "list" : "apply";
      setRefreshPending(true);
      setNotice(remove ? "Setup deleted." : `Applied “${preset.name}” to this receptionist.`);
      await refreshSetups();
    } catch (e) { setError(errorText(e)); }
    finally { finish(token); }
  }
  async function renamePreset(id: string, name: string) {
    if (operation.current || refreshPending) return;
    const edit = { name, version: editVersions.current.get(id) };
    const running = renames.current.get(id);
    if (running) { running.queued = edit; return; }
    const request: { queued?: typeof edit } = { queued: edit };
    renames.current.set(id, request);
    listGeneration.current++;
    setRenaming(true);
    try {
      while (request.queued) {
        const next = request.queued;
        request.queued = undefined;
        const confirmed = savedNames.current.get(id);
        const normalized = next.name.trim() || confirmed || "";
        const acknowledge = () => setPresets(rows => rows.map(row =>
          row.id === id && editVersions.current.get(id) === next.version && row.name === next.name
            ? { ...row, name: normalized } : row));
        if (normalized === confirmed) { acknowledge(); continue; }
        try {
          await api.renamePreset(id, normalized);
          listGeneration.current++;
          savedNames.current.set(id, normalized);
          acknowledge();
          setError("");
        } catch (e) {
          if (editVersions.current.get(id) !== next.version) continue;
          setError(errorText(e));
          if (confirmed !== undefined) setPresets(rows => rows.map(row =>
            row.id === id && row.name === next.name ? { ...row, name: confirmed } : row));
        }
      }
    } finally {
      renames.current.delete(id);
      setRenaming(renames.current.size > 0);
    }
  }
  async function createPreset() {
    if (!presetName.trim() || voiceDirty) return;
    const token = begin("create");
    if (!token) return;
    const version = nameVersion.current;
    setError(""); setNotice("");
    try {
      const row = await api.createPreset({
        name: presetName.trim(), engine: assistant.engine,
        realtime_model: assistant.realtime_model, realtime_voice: assistant.realtime_voice,
        language: assistant.language, voice: assistant.voice, llm_model: assistant.llm_model,
      });
      savedNames.current.set(row.id, row.name);
      setPresets(rows => [...rows.filter(old => old.id !== row.id), row]);
      setPresetName(current => nameVersion.current === version ? "" : current);
      setNotice("Reusable voice setup saved.");
    } catch (e) { setError(errorText(e)); }
    finally { listGeneration.current++; finish(token); }
  }
  useDirtyGuard(
    Object.keys(patch).length > 0 ||
      Object.keys(voice).length > 0 ||
      !!summaryKey ||
      JSON.stringify(summary) !== JSON.stringify(savedSummary),
  );
  async function load(recovery = false) {
    try {
      const [p, c, s] = await Promise.all([
        api.provider(),
        api.providerCatalog().catch(() => null),
        api.summaries(),
      ]);
      setProvider(p);
      setCatalog(c);
      setCatalogUnavailable(!c);
      setSummary(s);
      setSavedSummary(s);
      setLoadFailed(false);
      setError("");
      try { await loadPresets(recovery); } catch (e) {
        refreshKind.current = "list"; setRefreshPending(true); setError(errorText(e));
      }
    } catch (e) {
      setLoadFailed(true); setError(errorText(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const value = (key: keyof ProviderPatch) =>
    String(
      patch[key] ??
        (provider as unknown as Record<string, unknown>)?.[key] ??
        "",
    );
  const set = (key: keyof ProviderPatch, val: string | boolean) =>
    setPatch((p) => {
      const next = { ...p, [key]: val };
      if (val === (provider as unknown as Record<string, unknown>)?.[key] ||
          (!val && ['apiKey','realtime_api_key','stt_api_key','tts_api_key'].includes(key))) delete next[key];
      return next;
    });
  function catalogApplies(kind: 'text' | 'transcription' | 'realtime') {
    if (kind === 'realtime') return (value('realtime_provider') === 'instance' ? provider?.effective_realtime_provider : value('realtime_provider')) === 'kataleptic';
    const endpoint = kind === 'text' ? value('baseUrl') : value('stt_base_url');
    try { return new URL(endpoint).href.replace(/\/$/, '') === 'https://api.kataleptic.com/v1'; } catch { return false; }
  }
  function inactiveCapability(key: string) {
    const capability = key.startsWith('realtime_') ? 'realtime' : key.startsWith('stt_') ? 'stt' : key.startsWith('tts_') ? 'tts' : null;
    return capability && ['instance', 'browser'].includes(value(`${capability}_provider`));
  }
  function endpoint(key: keyof ProviderPatch, label: string) {
    if (inactiveCapability(key)) return null;
    return (
      <Field label={label}>
        <input
          type="url"
          value={value(key)}
          onChange={(e) => set(key, e.target.value)}
          placeholder="https://your-provider.example/v1"
        />
      </Field>
    );
  }
  function model(key: keyof ProviderPatch, label: string) {
    if (inactiveCapability(key)) return null;
    return (
      <Field label={label}>
        <input
          value={value(key)}
          list={
            key === "stt_model" ? "of-transcription-models" : "of-text-models"
          }
          onChange={(e) => set(key, e.target.value)}
          placeholder="Provider model identifier"
        />
      </Field>
    );
  }
  function secret(
    key: keyof ProviderPatch,
    configured: boolean,
    clear: keyof ProviderPatch,
  ) {
    const capability = key === 'realtime_api_key' ? 'realtime' : key === 'stt_api_key' ? 'stt' : key === 'tts_api_key' ? 'tts' : null;
    const label = capability === 'realtime' ? 'Realtime API key' : capability === 'stt' ? 'Transcription API key' : capability === 'tts' ? 'Speech API key' : 'Text API key';
    if (capability && inactiveCapability(key)) {
      const mode = value(`${capability}_provider`);
      const savedMode = provider?.[`${capability}_provider`];
      return <p className="of-help">{mode === 'browser'
        ? 'Browser speech uses this device. No provider key is used.'
        : `Instance ${capability === 'stt' ? 'transcription' : capability === 'tts' ? 'speech' : 'realtime'} uses the operator’s key. ${savedMode === 'instance' ? (configured ? 'An operator key is configured; connection not verified.' : 'No operator key is configured.') : ''}`}
        {savedMode !== mode && ' Save to use the instance configuration and remove the saved workspace key.'}
      </p>;
    }
    // Operator presence never means that a workspace credential is stored.
    if (capability && provider?.[`${capability}_provider`] === 'instance') configured = false;
    return (
      <>
        <Field
          label={label}
          hint={
            configured
              ? "A key is already stored. Leave blank to keep it."
              : "Stored securely for this workspace."
          }
        >
          <input
            type="password"
            autoComplete="new-password"
            value={String(patch[key] || "")}
            onChange={(e) => set(key, e.target.value)}
            placeholder={configured ? "•••••••• · stored" : "Paste API key"}
          />
        </Field>
        {configured && (
          <label className="of-check">
            <input
              type="checkbox"
              checked={!!patch[clear]}
              onChange={(e) => set(clear, e.target.checked)}
            />
            Remove the saved key
          </label>
        )}
      </>
    );
  }
  async function save() {
    if (!voiceDirty) return;
    const token = begin("settings");
    if (!token) return;
    setError("");
    setNotice("");
    let providerSaved = false;
    let stage: "provider" | "provider-read" | "voice" | "assistant-read" = "provider";
    try {
      const clean = { ...patch };
      for (const key of [
        "apiKey",
        "realtime_api_key",
        "stt_api_key",
        "tts_api_key",
      ] as const)
        if (!clean[key]) delete clean[key];
      if (Object.keys(clean).length) { await api.saveProvider(clean); providerSaved = true; }
      setPatch(
        (current) =>
          Object.fromEntries(
            Object.entries(current).filter(
              ([key, value]) =>
                value !== (patch as Record<string, unknown>)[key],
            ),
          ) as ProviderPatch,
      );
      stage = "provider-read";
      setProvider(await api.provider());
      stage = "voice";
      if (Object.keys(voice).length) {
        await api.saveAssistant(assistant.id, voice);
        setVoice(
          (current) =>
            Object.fromEntries(
              Object.entries(current).filter(
                ([key, value]) =>
                  value !== (voice as Record<string, unknown>)[key],
              ),
            ) as Partial<AssistantFields>,
        );
      }
      stage = "assistant-read";
      await onSaved();
      setNotice(
        "Connections saved. Run a connection check, then rehearse to verify the full conversation.",
      );
    } catch (e) {
      if (stage === "provider-read" || stage === "assistant-read") setConnectionsRefreshPending(true);
      setError(
        `${providerSaved ? "Provider connections were saved, but the remaining update failed. Your unsaved voice choices are retained. " : ""}${errorText(e)}`,
      );
    } finally {
      finish(token);
    }
  }
  async function refreshConnections() {
    const token = begin("settings", true); if (!token) return;
    try {
      if (loadFailed) await load(true);
      else {
        const current = await api.provider();
        await onSaved();
        setProvider(current);
        setConnectionsRefreshPending(false);
        setError("");
      }
    } catch (e) { setError(`Refreshing connections failed: ${errorText(e)}`); }
    finally { finish(token); }
  }
  function download() {
    try {
      const blob = new Blob([exportAssistantRecipe(assistant)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${assistant.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "receptionist"}.openfon.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <section className="of-brand-operations of-brand-connections">
      <button className="of-back" onClick={onBack}>
        <Icon name="back" size={18} />
        Back to your desk
      </button>
      <div className="of-page-heading">
        <div>
          <h1>Your connections</h1>
          <p>
            Choose what powers the conversation. Keep your business brief
            portable.
          </p>
        </div>
      </div>
      {error && <Notice error>{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      {catalogUnavailable && <Notice>The live Kataleptic catalog is temporarily unavailable. Saved connections and custom model IDs remain usable.</Notice>}
      {(loadFailed || connectionsRefreshPending) && <Button kind="line" disabled={busy || renaming} onClick={() => void refreshConnections()}>Retry connections refresh</Button>}
      {!provider ? (
        <Loading />
      ) : (
        <div className="of-settings-layout">
          <aside>
            <h2>Made to be yours.</h2>
            <p>
              Use the instance defaults, connect your own providers, or move
              your receptionist between compatible services.
            </p>
            <div className="of-settings-fact">
              <span>Current text model</span>
              <strong>
                {provider.effective_text_model ||
                  provider.model ||
                  "Instance default"}
              </strong>
            </div>
            <div className="of-settings-fact">
              <span>Speech output</span>
              <strong>
                {provider.effective_tts_provider || "Instance default"}
              </strong>
            </div>
            <RouteEvidence
              provider={provider}
              catalog={catalog}
              model={voice.realtime_model ?? assistant.realtime_model}
              pending={voiceDirty}
            />
            <Button
              kind="line"
              disabled={
                blocked ||
                Object.keys(patch).length > 0 ||
                Object.keys(voice).length > 0
              }
              onClick={async () => {
                const token = begin("settings"); if (!token) return;
                setError("");
                try {
                  const result = await api.checkProvider(assistant.id);
                  setNotice(
                    `Connection check passed${result.model ? ` for ${result.model}` : ""}. This does not validate microphone, audio playback or a complete call.`,
                  );
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  finish(token);
                }
              }}
            >
              Check saved connection
            </Button>
          </aside>
          <div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <section className="of-setting-section">
                <h2>Conversation style</h2>
                <p className="of-help">
                  Separate text and speech services, or use a single realtime
                  voice model.
                </p>
                <div className="of-two-fields">
                  <Field label="Conversation engine">
                    <select
                      value={voice.engine || assistant.engine}
                      onChange={(e) =>
                        setVoice({
                          ...voice,
                          engine: e.target.value as AssistantFields["engine"],
                        })
                      }
                    >
                      <option value="pipeline">Text + speech services</option>
                      <option value="realtime">Realtime voice</option>
                    </select>
                  </Field>
                  <Field label="Language">
                    <input
                      value={voice.language ?? assistant.language}
                      onChange={(e) =>
                        setVoice({ ...voice, language: e.target.value })
                      }
                      placeholder="en"
                    />
                  </Field>
                </div>
                {(voice.engine || assistant.engine) === "realtime" ? (
                  <div className="of-two-fields">
                    <Field label="Realtime model">
                      <input
                        list="of-realtime-models"
                        value={voice.realtime_model ?? assistant.realtime_model}
                        onChange={(e) =>
                          setVoice({ ...voice, realtime_model: e.target.value })
                        }
                      />
                    </Field>
                    <Field label="Realtime voice">
                      <input
                        list="of-realtime-voices"
                        value={voice.realtime_voice ?? assistant.realtime_voice}
                        onChange={(e) =>
                          setVoice({ ...voice, realtime_voice: e.target.value })
                        }
                      />
                    </Field>
                  </div>
                ) : (
                  <div className="of-two-fields">
                    <Field
                      label="Text model override"
                      hint="Leave blank to use the workspace model."
                    >
                      <input
                        list="of-text-models"
                        value={voice.llm_model ?? assistant.llm_model}
                        onChange={(e) =>
                          setVoice({ ...voice, llm_model: e.target.value })
                        }
                      />
                    </Field>
                    <Field label="Voice">
                      <input
                        list="of-voices"
                        value={voice.voice ?? assistant.voice}
                        onChange={(e) =>
                          setVoice({ ...voice, voice: e.target.value })
                        }
                      />
                    </Field>
                  </div>
                )}
              </section>
              <details className="of-provider-section" open>
                <summary>
                  <span>Text & reasoning</span>
                  <small>
                    {provider.workspaceApiKeyConfigured
                      ? "Workspace connection"
                      : "Instance default"}
                  </small>
                </summary>
                <div className="of-form">
                  <Field label="Provider preset">
                    <select
                      value=""
                      onChange={(e) => {
                        const p = provider.presets.find(
                          (p) => p.id === e.target.value,
                        );
                        if (p)
                          setPatch({
                            ...patch,
                            baseUrl: p.baseUrl,
                            model: p.model,
                          });
                      }}
                    >
                      <option value="">Choose a preset…</option>
                      {provider.presets.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {endpoint("baseUrl", "Compatible API URL")}
                  {model("model", "Workspace text model")}
                  {secret(
                    "apiKey",
                    provider.workspaceApiKeyConfigured,
                    "clearApiKey",
                  )}
                </div>
              </details>
              <details className="of-provider-section">
                <summary>
                  <span>Realtime voice</span>
                  <small>{provider.realtime_provider}</small>
                </summary>
                <div className="of-form">
                  <Field label="Realtime provider">
                    <select
                      value={value("realtime_provider")}
                      onChange={(e) => {
                        const kind = e.target.value;
                        setPatch((p) => ({
                          ...p,
                          realtime_provider:
                            kind as Provider["realtime_provider"],
                          ...(kind === 'instance' ? { realtime_api_key:'', realtime_clear_api_key:false } : {}),
                          ...(kind === "kataleptic"
                            ? {
                                realtime_base_url:
                                  "wss://api.kataleptic.com/v1/realtime",
                              }
                            : kind === "openai"
                              ? {
                                  realtime_base_url:
                                    "wss://api.openai.com/v1/realtime",
                                }
                              : {}),
                        }));
                      }}
                    >
                      <option value="instance">Instance default</option>
                      <option value="kataleptic">Kataleptic</option>
                      <option value="openai">OpenAI</option>
                      <option value="custom">Custom compatible provider</option>
                    </select>
                  </Field>
                  {endpoint("realtime_base_url", "Realtime API URL")}
                  {secret(
                    "realtime_api_key",
                    provider.realtime_api_key_configured,
                    "realtime_clear_api_key",
                  )}
                </div>
              </details>
              <details className="of-provider-section">
                <summary>
                  <span>Speech recognition</span>
                  <small>{provider.stt_provider}</small>
                </summary>
                <div className="of-form">
                  <Field label="Transcription provider">
                    <select
                      value={value("stt_provider")}
                      onChange={(e) => {
                        const kind = e.target.value;
                        setPatch((p) => ({
                          ...p,
                          stt_provider: kind as Provider["stt_provider"],
                          ...(kind === 'instance' ? { stt_api_key:'', stt_clear_api_key:false } : {}),
                          ...(kind === "openai"
                            ? {
                                stt_base_url: "https://api.openai.com/v1",
                                stt_model: "whisper-1",
                              }
                            : {}),
                        }));
                      }}
                    >
                      <option value="instance">Instance default</option>
                      <option value="openai">OpenAI</option>
                      <option value="custom">Custom compatible provider</option>
                    </select>
                  </Field>
                  {endpoint("stt_base_url", "Transcription API URL")}
                  {model("stt_model", "Transcription model")}
                  {secret(
                    "stt_api_key",
                    provider.stt_api_key_configured,
                    "stt_clear_api_key",
                  )}
                </div>
              </details>
              <details className="of-provider-section">
                <summary>
                  <span>Speech output</span>
                  <small>{provider.tts_provider}</small>
                </summary>
                <div className="of-form">
                  <Field label="Voice provider">
                    <select
                      value={value("tts_provider")}
                      onChange={(e) => {
                        const kind = e.target.value as Provider['tts_provider'];
                        setPatch(p => ({ ...p, tts_provider:kind,
                          ...(['instance', 'browser'].includes(kind) ? {tts_api_key:'',tts_clear_api_key:false} : {}),
                          ...(kind === 'openai' ? {tts_base_url:'https://api.openai.com/v1',tts_model:'gpt-4o-mini-tts'} : kind === 'azure' ? {tts_base_url:'',tts_model:''} : {}),
                        }));
                      }}
                    >
                      <option value="instance">Instance default</option>
                      <option value="browser">Browser voice</option>
                      <option value="azure">Azure</option>
                      <option value="openai">OpenAI</option>
                      <option value="custom">Custom compatible provider</option>
                    </select>
                  </Field>
                  {endpoint("tts_base_url", "Speech API URL")}
                  {model("tts_model", "Speech model")}
                  {secret(
                    "tts_api_key",
                    provider.tts_api_key_configured,
                    "tts_clear_api_key",
                  )}
                </div>
              </details>
              <div className="of-actions of-save-row">
                <Button type="submit" disabled={blocked || !voiceDirty}>
                  {busy ? "Saving…" : "Save connections"}
                </Button>
              </div>
            </form>
            <details className="of-provider-section of-presets">
              <summary>
                <span>Reusable voice setups</span>
                <small>{presets.length} saved</small>
              </summary>
              <div className="of-form">
                <p className="of-help">
                  Save the current receptionist’s engine, model, language and
                  voice choices. Presets use the destination’s provider
                  connections.
                </p>
                <p className="of-help">Names save when you leave the field. If you click Use setup or Delete setup while a name is saving, click it again after saving finishes. Up to 64 setups are shown; delete unused ones to reveal more.</p>
                {voiceDirty && <p className="of-help">Save your connection and voice edits before using or saving a setup.</p>}
                {renaming && <p role="status">Saving setup names…</p>}
                {presets.map((p) => (
                  <div className="of-preset-row" key={p.id}>
                    <div className="of-preset-name">
                      <input aria-label="Setup name" value={p.name}
                        readOnly={Boolean(p.preview_only) || busy || refreshPending}
                        onChange={e => {
                          editVersions.current.set(p.id, (editVersions.current.get(p.id) ?? 0) + 1);
                          setPresets(rows => rows.map(row => row.id === p.id ? { ...row, name: e.target.value } : row));
                        }}
                        onBlur={e => { if (!p.preview_only) void renamePreset(p.id, e.target.value); }} />
                      <small>{p.engine === "realtime" ? "Realtime voice" : "Text + speech"} · {p.language}</small>
                      {Boolean(p.preview_only) && <small>Historical preview. Its full saved setup is used when applied; its name cannot be edited here.</small>}
                    </div>
                    <Button kind="line" disabled={blocked || voiceDirty} onClick={() => void setupAction(p)}>Use setup</Button>
                    <Button kind="quiet" disabled={blocked} onClick={() => void setupAction(p, true)}>Delete setup</Button>
                  </div>
                ))}
                <Field label="Name a reusable setup">
                  <input value={presetName}
                    onChange={e => { nameVersion.current++; setPresetName(e.target.value); }}
                    placeholder="Our everyday receptionist" />
                </Field>
                <Button kind="line" disabled={blocked || !presetName.trim() || voiceDirty}
                  onClick={() => void createPreset()}>Save current voice setup</Button>
                {refreshPending && <Button kind="line" disabled={busy || renaming} onClick={async () => {
                  const token = begin("settings", true); if (!token) return;
                  try { await refreshSetups(); } finally { finish(token); }
                }}>Retry setup refresh</Button>}
              </div>
            </details>
            <section className="of-setting-section">
              <h2>Take your receptionist with you</h2>
              <p className="of-help">
                Export a portable recipe of the saved behavior, language and
                voice choices. API keys, business knowledge and conversations
                are excluded.
              </p>
              <div className="of-actions">
                <Button kind="line" icon="download" onClick={download}>
                  Export recipe
                </Button>
                <label className="of-button line of-file-label">
                  <Icon name="upload" />
                  Import recipe
                  <input
                    type="file"
                    disabled={blocked}
                    accept="application/json,.json"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const revision = ++recipeLoad.current;
                      setRecipe(null); setIncludeVoice(false);
                      try {
                        if (file.size > 65536)
                          throw new Error(
                            "Choose a recipe smaller than 64 KiB.",
                          );
                        const parsed = parseAssistantRecipe(await file.text());
                        if (revision !== recipeLoad.current) return;
                        setRecipe(parsed); setIncludeVoice(false);
                        setError("");
                      } catch (err) {
                        if (revision === recipeLoad.current) setError(errorText(err));
                      }
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
              {recipe && (
                <div className="of-import-review">
                  <h3>Review “{recipe.assistant.name}”</h3>
                  <dl className="of-recipe-fields">
                    <dt>First words</dt>
                    <dd>{recipe.assistant.greeting || "Not set"}</dd>
                    <dt>Tone and personality</dt>
                    <dd>{recipe.assistant.persona || "Not set"}</dd>
                    <dt>Special instructions</dt>
                    <dd>{recipe.assistant.custom_instructions || "None"}</dd>
                    <dt>Messages</dt>
                    <dd>
                      {recipe.assistant.take_messages
                        ? "Take messages"
                        : "Do not take messages"}
                    </dd>
                    <dt>Language</dt>
                    <dd>{recipe.assistant.language}</dd>
                    <dt>Conversation engine</dt>
                    <dd>{recipe.assistant.engine}</dd>
                    <dt>Text model override</dt>
                    <dd>{recipe.assistant.llm_model || "Workspace model"}</dd>
                    <dt>Text + speech voice</dt>
                    <dd>{recipe.assistant.voice || "Default voice"}</dd>
                    <dt>Realtime model</dt>
                    <dd>
                      {recipe.assistant.realtime_model || "Default model"}
                    </dd>
                    <dt>Realtime voice</dt>
                    <dd>
                      {recipe.assistant.realtime_voice || "Default voice"}
                    </dd>
                  </dl>
                  <p className="of-help">
                    This replaces the saved receptionist behavior. Choose
                    whether to bring its voice settings too. It does not add
                    keys or knowledge.
                  </p>
                  <label className="of-check">
                    <input
                      type="checkbox"
                      checked={includeVoice}
                      disabled={blocked}
                      onChange={(e) => setIncludeVoice(e.target.checked)}
                    />
                    Also replace language, engine and voice settings
                  </label>
                  {voiceDirty && <p className="of-help">Save your connection and voice edits before saving this recipe.</p>}
                  <div className="of-actions">
                    <Button
                      disabled={blocked || voiceDirty}
                      onClick={async () => {
                        if (voiceDirty) return;
                        const token = begin("settings"); if (!token) return;
                        try {
                          await api.saveAssistant(
                            assistant.id,
                            assistantRecipePatch(
                              recipe,
                              includeVoice,
                            ) as Partial<AssistantFields>,
                          );
                          ++recipeLoad.current; setRecipe(null); setIncludeVoice(false);
                          setNotice("Recipe imported into this receptionist.");
                          try { await onSaved(); } catch (e) { setConnectionsRefreshPending(true); throw e; }
                        } catch (e) {
                          setError(errorText(e));
                        } finally {
                          finish(token);
                        }
                      }}
                    >
                      Save this recipe
                    </Button>
                    <Button kind="quiet" disabled={blocked} onClick={() => { ++recipeLoad.current; setRecipe(null); setIncludeVoice(false); }}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </section>
            {summary && (
              <details className="of-provider-section" aria-label="Conversation summaries">
                <summary><span>Conversation summaries</span><small>{summary.mode}</small></summary>
                <form className="of-form" onSubmit={e => { e.preventDefault(); void writeSummary(); }}>
                  {summaryError && <Notice error>{summaryError}</Notice>}
                  {summaryNotice && <Notice>{summaryNotice}</Notice>}
                  {summaryError && <Button kind="line" disabled={blocked} onClick={() => void writeSummary(true)}>Reload summary settings (discard edits)</Button>}
                  <Field label="Summary connection">
                    <select disabled={busy} value={summary.mode} onChange={e => {
                      setSummaryKey("");
                      changeSummary({ mode: e.target.value as SummarySettings["mode"], baseUrl: "", model: "" });
                    }}>
                      <option value="legacy">Use assistant text model</option>
                      <option value="workspace">Workspace text connection</option>
                      <option value="custom">Separate connection</option>
                    </select>
                  </Field>
                  {summary.mode !== "legacy" && <>
                    {summary.mode === "custom" && <Field label="API URL">
                      <input type="url" disabled={busy} value={summary.baseUrl} onChange={e => changeSummary({ baseUrl: e.target.value })} />
                    </Field>}
                    <Field label="Model" hint={summary.mode === "workspace" ? "Leave blank to use the workspace text model. This choice is only for summaries." : "A model supported by this summary provider."}>
                      <input disabled={busy} value={summary.model} onChange={e => changeSummary({ model: e.target.value })} />
                    </Field>
                    {summary.mode === "custom" && <Field label="API key" hint={summary.apiKeyConfigured ? "Leave blank to keep the stored key at this endpoint." : undefined}>
                      <input type="password" autoComplete="new-password" disabled={busy} value={summaryKey} onChange={e => { summaryVersion.current++; setSummaryKey(e.target.value); setSummaryNotice(""); }} />
                    </Field>}
                  </>}
                  <Button type="submit" disabled={blocked || !summaryDirty}>Save summary settings</Button>
                </form>
              </details>
            )}
          </div>
        </div>
      )}
      {(["text", "transcription", "realtime"] as const).map((kind) => (
        <datalist key={kind} id={`of-${kind}-models`}>
          {catalog?.models
            .filter((m) => m.kind === kind && catalogApplies(kind))
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
        </datalist>
      ))}
      {(["pipeline", "realtime"] as const).map((engine) => (
        <datalist
          key={engine}
          id={engine === "pipeline" ? "of-voices" : "of-realtime-voices"}
        >
          {(provider && Object.keys(patch).length === 0
            ? voiceChoicesFor(
                { ...assistant, ...voice, engine },
                provider,
                catalog,
              )
            : []
          ).map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </datalist>
      ))}
    </section>
  );
}

function RouteEvidence({
  provider,
  catalog,
  model,
  pending,
}: {
  provider: Provider;
  catalog: ProviderCatalog | null;
  model: string;
  pending: boolean;
}) {
  const saved = provider.realtimeRoute;
  const routes = catalog?.routing?.routes;
  const route =
    !pending && saved
      ? (Array.isArray(routes)
          ? routes.find((r: any) => r.requestedModel === model)
          : null) || (saved.requestedModel === model || !model ? saved : null)
      : null;
  return (
    <div className="of-route-evidence">
      <h3 className="of-reading-title">Realtime model routing</h3>
      <p>
        Requested model:{" "}
        <strong>
          {model || provider.effective_realtime_model || "Instance default"}
        </strong>
      </p>
      {route ? (
        <>
          <p>
            Upstream:{" "}
            <strong>{String(route.upstreamModel || "Not documented")}</strong>
          </p>
          <p>
            {String(route.upstreamService || "")}
            <br />
            {String(
              route.upstreamDeployment || "No deployment identity recorded",
            )}
          </p>
          <small>
            {route.distinctness === "verified-at-check"
              ? "Distinct deployment verified at the recorded check."
              : "Upstream distinctness is unverified."}{" "}
            Evidence: {String(route.evidence || "snapshot")},{" "}
            {String(route.checkedAt || "undated")}. This is a dated snapshot,
            not verification of a new call.
          </small>
        </>
      ) : (
        <small>
          {pending
            ? "Save connection changes to see applicable routing evidence."
            : "No dated routing evidence is available for this connection."}
        </small>
      )}
    </div>
  );
}
