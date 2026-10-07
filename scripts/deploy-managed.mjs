import { unstable_readConfig } from "wrangler";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const productionConfig = "wrangler.production.json";
const databaseId = "c45afdaa-c04e-4401-af5c-801bb79fc88c";
const requiredSecrets = [
  "AZURE_OPENAI_API_KEY",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "LIVEKIT_AGENT_SERVICE_TOKEN",
];

export function validateManagedDeployment(config, baseline) {
  if (config.name !== "openfon" || config.main !== baseline.main)
    throw Error("Unexpected production Worker or entrypoint.");
  const expected = {
    OPENFON_MANAGED_WEB: "true",
    WEB_VOICE_TRANSPORT: "livekit",
    AZURE_OPENAI_TEXT_DEPLOYMENT: "gpt-5.4-mini",
    LIVEKIT_URL: "wss://voice.openfon.ai",
  };
  for (const [name, value] of Object.entries(expected)) {
    if (config.vars?.[name] !== value)
      throw Error(`Production requires ${name}=${value}.`);
  }
  if(!["gpt-live-1","gpt-realtime-2.1-mini"].includes(config.vars?.AZURE_OPENAI_LIVE_DEPLOYMENT))throw Error("Unsupported production voice deployment.");
  const endpoint = new URL(config.vars.AZURE_OPENAI_ENDPOINT || "");
  if (
    endpoint.origin !== "https://duguet-labs-eu.cognitiveservices.azure.com" ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password
  )
    throw Error("Unexpected production Azure resource.");
  for (const name of [
    "d1_databases",
    "durable_objects",
    "migrations",
    "assets",
  ]) {
    if (JSON.stringify(config[name]) !== JSON.stringify(baseline[name]))
      throw Error(
        `Production ${name} differs from the reviewed application bindings.`,
      );
  }
  if (
    config.d1_databases?.length !== 1 ||
    config.d1_databases[0].database_id !== databaseId
  )
    throw Error("Unexpected production database.");
  if (JSON.stringify(config.triggers?.crons) !== JSON.stringify(["* * * * *"]))
    throw Error("Commercial maintenance requires the one-minute schedule.");
  return config;
}

export async function verifyRemotePrerequisites(
  config,
  environment,
  fetcher = fetch,
) {
  const account = environment.CLOUDFLARE_ACCOUNT_ID;
  const token = environment.CLOUDFLARE_API_TOKEN;
  if (!/^[a-f0-9]{32}$/.test(account || "") || !token)
    throw Error(
      "Production requires its explicit Cloudflare account and deploy credential.",
    );
  async function api(path, body) {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${account}${path}`,
      {
        method: body ? "POST" : "GET",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    if (!response.ok)
      throw Error(
        "Production prerequisite lookup failed; no deployment started.",
      );
    const result = await response.json();
    if (
      !result.success ||
      (Array.isArray(result.result) &&
        result.result.some((entry) => entry.success === false))
    )
      throw Error(
        "Production prerequisite verification failed; no deployment started.",
      );
    return result.result;
  }
  const result = await api(`/d1/database/${databaseId}/query`, {
    sql: "SELECT name FROM d1_migrations WHERE name IN ('0026_business_actions.sql','0027_commercial.sql','0028_business_country.sql','0029_phone_eligibility.sql')",
  });
  const names = new Set(result[0]?.results?.map((row) => row.name));
  if (
    !names.has("0026_business_actions.sql") ||
    !names.has("0027_commercial.sql") ||
    !names.has("0028_business_country.sql") ||
    !names.has("0029_phone_eligibility.sql")
  )
    throw Error(
      "Apply only reviewed migrations 0026–0029 after backup and staging acceptance before deploying. This command never applies migrations.",
    );
  await api(`/d1/database/${databaseId}/query`, {
    sql: "SELECT businesses.contact_email,businesses.country,call_action_extractions.token,commercial_payment_writers.token,commercial_phone_approvals.revision,commercial_phone_quotes.approval_id FROM businesses,call_action_extractions,commercial_payment_writers,commercial_phone_approvals,commercial_phone_quotes LIMIT 0",
  });
  const settings = await api(`/workers/scripts/${config.name}/settings`);
  const secretNames = new Set(
    settings.bindings
      ?.filter((binding) => binding.type === "secret_text")
      .map((binding) => binding.name),
  );
  if (requiredSecrets.some((name) => !secretNames.has(name)))
    throw Error(
      "Provision the required Azure and voice-service credentials before deploying. No credential values were read.",
    );
}

export async function main(args = process.argv.slice(2)) {
  if (
    args.some((arg) => !["--check", "--dry-run"].includes(arg)) ||
    args.length > 1
  )
    throw Error(
      "Use deploy-managed.mjs, --check, or --dry-run. Environment/config overrides are not accepted.",
    );
  const config = validateManagedDeployment(
    unstable_readConfig({ config: productionConfig }, { hideWarnings: true }),
    unstable_readConfig({ config: "wrangler.jsonc" }, { hideWarnings: true }),
  );
  if (args.includes("--check")) {
    console.log("Managed production configuration and bindings verified.");
    return;
  }
  if (!args.includes("--dry-run"))
    await verifyRemotePrerequisites(config, process.env);
  const run = (command, commandArgs) => {
    const result = spawnSync(command, commandArgs, {
      stdio: "inherit",
      env: process.env,
    });
    if (result.error || result.status !== 0)
      throw Error(
        "Production command failed. Inspect the preceding diagnostics.",
      );
  };
  const revision = spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  const head = revision.stdout?.trim();
  if (revision.status !== 0 || !/^[a-f0-9]{40}$/.test(head || ""))
    throw Error("Cannot identify the production source commit.");
  if (!args.includes("--dry-run")) {
    const status = spawnSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
    });
    if (status.status !== 0 || status.stdout.trim())
      throw Error(
        "Commit the exact reviewed production source before deployment.",
      );
  }
  run("npm", ["run", "build"]);
  run("npx", [
    "--no-install",
    "wrangler",
    "deploy",
    "--config",
    productionConfig,
    "--var",
    `OPENFON_RELEASE_SHA:${head}`,
    ...(args.includes("--dry-run") ? ["--dry-run"] : []),
  ]);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
