import { describe, it, expect, vi } from "vitest";
import { unstable_readConfig } from "wrangler";
import {
  main,
  validateManagedDeployment,
  verifyRemotePrerequisites,
} from "../scripts/deploy-managed.mjs";

const parsed = () =>
  unstable_readConfig(
    { config: "wrangler.production.json" },
    { hideWarnings: true },
  );
const baseline = () =>
  unstable_readConfig({ config: "wrangler.jsonc" }, { hideWarnings: true });
describe("managed production deployment contract", () => {
  it("uses Wrangler-parsed configuration with unchanged state and asset bindings", () => {
    expect(
      validateManagedDeployment(parsed(), baseline()).vars.OPENFON_MANAGED_WEB,
    ).toBe("true");
  });
  it.each([
    "OPENFON_MANAGED_WEB",
    "WEB_VOICE_TRANSPORT",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_LIVE_DEPLOYMENT",
    "AZURE_OPENAI_TEXT_DEPLOYMENT",
    "LIVEKIT_URL",
  ])("refuses missing required routing %s", (key) => {
    const config = parsed();
    delete config.vars[key];
    expect(() => validateManagedDeployment(config, baseline())).toThrow();
  });
  it("rejects state rebinding and credential-bearing endpoint overrides", () => {
    const config = parsed();
    config.d1_databases[0].database_id = "wrong";
    expect(() => validateManagedDeployment(config, baseline())).toThrow();
    const endpoint = parsed();
    endpoint.vars.AZURE_OPENAI_ENDPOINT =
      "https://name:synthetic@duguet-labs-eu.cognitiveservices.azure.com/";
    expect(() => validateManagedDeployment(endpoint, baseline())).toThrow();
  });
  it("refuses command-line config or environment overrides", async () => {
    await expect(main(["--config", "wrangler.jsonc"])).rejects.toThrow();
  });
  it("stops before upload if approved migrations or credentials are missing", async () => {
    const env = {
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_API_TOKEN: "synthetic",
    };
    const incomplete = vi.fn(async () =>
      Response.json({ success: true, result: [{ results: [] }] }),
    );
    await expect(
      verifyRemotePrerequisites(parsed(), env, incomplete),
    ).rejects.toThrow("never applies migrations");
    expect(incomplete).toHaveBeenCalledTimes(1);
    const missingSecrets = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: [
            {
              results: [
                { name: "0026_business_actions.sql" },
                { name: "0027_commercial.sql" },
              ],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ success: true, result: [{ results: [] }] }),
      )
      .mockResolvedValueOnce(
        Response.json({ success: true, result: { bindings: [] } }),
      );
    await expect(
      verifyRemotePrerequisites(parsed(), env, missingSecrets),
    ).rejects.toThrow("Provision");
    const sql = missingSecrets.mock.calls
      .map(([, init]) => (init.body ? JSON.parse(init.body).sql : ""))
      .join("\n");
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE)\b/);
  });
});
it('canonical candidate selects Mini while only the explicit supported rollback remains valid',()=>{
 const candidate=parsed();expect(candidate.vars.AZURE_OPENAI_LIVE_DEPLOYMENT).toBe('gpt-realtime-2.1-mini');
 const stage=unstable_readConfig({config:'wrangler.staging.json'},{hideWarnings:true});
 expect(stage.vars.AZURE_OPENAI_LIVE_DEPLOYMENT).toBe(candidate.vars.AZURE_OPENAI_LIVE_DEPLOYMENT);expect(stage.name).toBe('openfon-staging');expect(stage.d1_databases[0].database_id).toBe('e1d93b7d-9024-447a-ae25-6b1e5ed298b3');expect(stage.triggers.crons).toEqual([]);expect(stage.vars.LIVEKIT_URL).toBe('wss://voice-staging.openfon.ai');
 for(const config of [candidate,stage])for(const flag of ['COMMERCIAL_CHARGING_ENABLED','TELNYX_PURCHASES_ENABLED','TELNYX_ENABLED','ASTERISK_ENABLED'])expect(config.vars[flag]).toBe('false');
 candidate.vars.AZURE_OPENAI_LIVE_DEPLOYMENT='gpt-live-1';expect(()=>validateManagedDeployment(candidate,baseline())).not.toThrow();
 candidate.vars.AZURE_OPENAI_LIVE_DEPLOYMENT='custom';expect(()=>validateManagedDeployment(candidate,baseline())).toThrow();
});
