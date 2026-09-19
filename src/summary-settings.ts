import type { Hono } from 'hono';
import type { AgentSettings, Env, LlmConfig, ProviderSettings } from './types';
import { LlmConfigError, resolveLlm, validateLlmBaseUrl } from './providers';
import { ProviderInputError, retainedProviderKey } from './provider-settings';
import { readWorkspaceBody } from './request-validation';

export interface SummarySettings {
  mode: 'legacy' | 'workspace' | 'custom';
  base_url: string;
  api_key: string;
  model: string;
  revision: string;
}

export function resolveSummary(env: Env, config: SummarySettings | null, provider: ProviderSettings | null, assistant: AgentSettings | null): LlmConfig {
  if (!config || config.mode === 'legacy') return resolveLlm(env, assistant);
  if (config.mode === 'workspace') {
    return resolveLlm(env, { ...provider, llm_model: config.model || provider?.llm_model || '' } as AgentSettings);
  }
  // Explicit summary providers never borrow an instance or conversation key,
  // even when the destination happens to equal the operator's endpoint.
  const bad = validateLlmBaseUrl(config.base_url, env.ALLOW_INSECURE_LLM_URL === 'true');
  if (config.mode !== 'custom' || bad || !config.api_key || !config.model) throw new LlmConfigError('Call summaries need a valid endpoint, model and separate API key.');
  return { baseUrl: config.base_url, apiKey: config.api_key, model: config.model };
}

export async function loadSummaryLlm(env: Env, businessId: string, assistant: AgentSettings | null): Promise<LlmConfig> {
  const config = await env.DB.prepare('SELECT * FROM summary_settings WHERE business_id=?').bind(businessId).first<SummarySettings>();
  const provider = config?.mode === 'workspace'
    ? await env.DB.prepare('SELECT * FROM provider_settings WHERE business_id=?').bind(businessId).first<ProviderSettings>() : null;
  return resolveSummary(env, config, provider, assistant);
}

function view(config: SummarySettings | null) {
  return { mode: config?.mode || 'legacy', baseUrl: config?.base_url || '', model: config?.model || '',
    apiKeyConfigured: Boolean(config?.api_key), revision: config?.revision ?? null };
}

function update(env: Env, current: SummarySettings | null, body: Record<string, unknown>): SummarySettings {
  const str = (key: string, max: number) => {
    if (typeof body[key] !== 'string' || (body[key] as string).length > max) throw new ProviderInputError(`${key} must be a string of at most ${max} characters.`);
    return (body[key] as string).trim();
  };
  const mode = str('mode', 32);
  if (!['legacy', 'workspace', 'custom'].includes(mode)) throw new ProviderInputError('Choose a supported summary provider.');
  const model = str('model', 256);
  const baseUrl = str('baseUrl', 2048);
  const replacement = str('apiKey', 4096);
  if (mode !== 'custom' && (baseUrl || replacement)) throw new ProviderInputError('Separate summary credentials require a custom provider.');
  const key = mode === 'custom' ? retainedProviderKey(current?.base_url || '', baseUrl, current?.api_key || '', replacement, false) : '';
  const result: SummarySettings = { mode: mode as SummarySettings['mode'], base_url: mode === 'custom' ? baseUrl : '',
    api_key: key, model: mode === 'legacy' ? '' : model, revision: crypto.randomUUID() };
  if (mode === 'custom') {
    try { resolveSummary(env, result, null, null); }
    catch (e) { if (e instanceof LlmConfigError) throw new ProviderInputError(e.message); throw e; }
  }
  return result;
}

export function registerSummaryApi(app: Hono<{ Bindings: Env; Variables: { userId: string } }>): void {
  app.get('/api/me/call-summaries', async c => {
    const workspace = await c.env.DB.prepare('SELECT id FROM businesses WHERE user_id=?').bind(c.get('userId')).first<{ id: string }>();
    if (!workspace) return c.json({ error: 'Create a workspace first' }, 409);
    const current = await c.env.DB.prepare('SELECT * FROM summary_settings WHERE business_id=?').bind(workspace.id).first<SummarySettings>();
    return c.json(view(current));
  });
  app.put('/api/me/call-summaries', async c => {
    const workspace = await c.env.DB.prepare('SELECT id FROM businesses WHERE user_id=?').bind(c.get('userId')).first<{ id: string }>();
    if (!workspace) return c.json({ error: 'Create a workspace first' }, 409);
    const body = await readWorkspaceBody<Record<string, unknown>>(c.req);
    if (body.revision !== null && (typeof body.revision !== 'string' || body.revision.length > 64)) return c.json({ error: 'Reload summary settings before saving.' }, 400);
    const current = await c.env.DB.prepare('SELECT * FROM summary_settings WHERE business_id=?').bind(workspace.id).first<SummarySettings>();
    if ((current?.revision ?? null) !== body.revision) return c.json({ error: 'Summary settings changed. Reload them before saving again.' }, 409);
    let next: SummarySettings;
    try { next = update(c.env, current, body); }
    catch (e) { if (e instanceof ProviderInputError) return c.json({ error: e.message }, 400); throw e; }
    const saved = await c.env.DB.prepare(`INSERT INTO summary_settings (business_id,mode,base_url,api_key,model,revision)
      SELECT ?,?,?,?,?,? WHERE ? IS NULL OR EXISTS(SELECT 1 FROM summary_settings WHERE business_id=? AND revision=?)
      ON CONFLICT(business_id) DO UPDATE SET mode=excluded.mode,base_url=excluded.base_url,api_key=excluded.api_key,model=excluded.model,revision=excluded.revision
      WHERE summary_settings.revision=? RETURNING revision`)
      .bind(workspace.id, next.mode, next.base_url, next.api_key, next.model, next.revision,
        body.revision, workspace.id, body.revision, body.revision).first();
    if (!saved) return c.json({ error: 'Summary settings changed. Reload them before saving again.' }, 409);
    // Return the acknowledged snapshot directly: no post-write read can turn a
    // successful save into a failure or restore an older draft.
    return c.json(view(next));
  });
}
