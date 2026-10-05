/** Real workerd execution of commercial HTTP helpers; provider/D1 fixtures are local.
 * No remote credentials, DNS, provider calls, purchases or payments.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
const root = resolve(import.meta.dirname, ".."),
  temp = await mkdtemp(join(tmpdir(), "openfon-commercial-http-"));
let mf;
const requests = [];
try {
  const result = await build({
    stdin: {
      contents: `import {dodoRequest} from './src/commercial-dodo';import {phoneRequest} from './src/commercial-phone';import {getCommercialInvoice} from './src/commercial-payment';
 export default {async fetch(request,env){const u=new URL(request.url),kind=u.searchParams.get('kind'),redirect=u.searchParams.get('redirect')==='1';const config={...env,DODO_MODE:'test',DODO_API_KEY:redirect?'synthetic-redirect':'synthetic',TELNYX_API_KEY:redirect?'synthetic-redirect':'synthetic'};
 try{if(kind==='dodo'){const r=await dodoRequest(config,'/probe');return Response.json({ok:r.value==='fixture'});}
 if(kind==='phone'){const r=await phoneRequest(config,'/probe');return Response.json({ok:r.value==='fixture'});}
 const r=await getCommercialInvoice(config,'business','payment');return Response.json({ok:r.headers.get('content-type')==='application/pdf'&&(await r.text()).startsWith('%PDF-')});}
 catch(e){return Response.json({ok:false,error:e.message});}}};`,
      resolveDir: root,
      sourcefile: "commercial-native-entry.ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      host: "127.0.0.1",
      port: 0,
      inspectorPort: 0,
      defaultPersistRoot: temp,
      workers: [
        {
          name: "commercial-http",
          modules: true,
          script: result.outputFiles[0].text,
          compatibilityDate: "2026-05-01",
          d1Databases: { DB: "commercial-http" },
          outboundService: async (request) => {
            const u = new URL(request.url);
            requests.push({
              host: u.host,
              path: u.pathname,
              redirect: request.redirect,
            });
            if (u.host === "must-not-follow.invalid")
              return Response.json({ value: "fixture" });
            if (u.pathname === "/payments/payment")
              return Response.json({ customer: { customer_id: "customer" } });
            if (
              request.headers.get("authorization") ===
              "Bearer synthetic-redirect"
            )
              return new Response(null, {
                status: 302,
                headers: {
                  Location: "https://must-not-follow.invalid/credential-leak",
                },
              });
            if (u.pathname === "/invoices/payments/payment")
              return new Response("%PDF-synthetic", {
                headers: { "Content-Type": "application/pdf" },
              });
            return Response.json({ value: "fixture" });
          },
        },
      ],
    }),
  );
  await mf.ready;
  const db = await mf.getD1Database("DB", "commercial-http");
  await db.batch([
    db.prepare(
      "CREATE TABLE commercial_accounts(business_id TEXT,customer_id TEXT,provider_mode TEXT)",
    ),
    db.prepare("CREATE TABLE commercial_deletion_jobs(business_id TEXT)"),
    db.prepare(
      "CREATE TABLE commercial_payment_events(business_id TEXT,provider_mode TEXT,payment_id TEXT)",
    ),
    db.prepare(
      "INSERT INTO commercial_accounts VALUES('business','customer','test')",
    ),
    db.prepare(
      "INSERT INTO commercial_payment_events VALUES('business','test','payment')",
    ),
  ]);
  const observations = [];
  for (const kind of ["dodo", "phone", "invoice"])
    for (const redirect of [false, true]) {
      const response = await mf.dispatchFetch(
        "http://fixture/?kind=" + kind + "&redirect=" + (redirect ? "1" : "0"),
      );
      const body = await response.json();
      observations.push({ kind, redirect, ...body });
    }
  console.log(
    JSON.stringify({
      observations,
      requestCount: requests.length,
      redirectFollowed: requests.some(
        (x) => x.host === "must-not-follow.invalid",
      ),
      runtime: "workerd",
      provider: "local synthetic outbound service",
    }),
  );
  for (const item of observations)
    assert.equal(
      item.ok,
      !item.redirect,
      item.kind +
        " " +
        (item.redirect ? "redirect rejection" : "successful request"),
    );
  assert.equal(
    requests.some((x) => x.host === "must-not-follow.invalid"),
    false,
  );
  assert.equal(requests.length, 8);
  console.log(
    "PASS 6 workerd commercial HTTP cases: Dodo, phone, invoice success and redirect rejection; no external traffic.",
  );
} finally {
  await mf?.dispose();
  await rm(temp, { recursive: true, force: true });
}
