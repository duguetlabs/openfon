import { it, expect, vi, afterEach } from "vitest";
import { processManagedCall } from "../src/managed-processing";
import {
  ManagedProcessingError,
  rejectedResponseDiagnostic,
  type ProcessingDiagnostic,
} from "../src/managed-processing-diagnostics";
import type { Env } from "../src/types";
const env = {
  OPENFON_MANAGED_WEB: "true",
  AZURE_OPENAI_ENDPOINT: "https://fixture.cognitiveservices.azure.com/",
  AZURE_OPENAI_API_KEY: "synthetic-secret-canary",
} as Env;
const turns = [
  { id: "1", role: "caller", text: "synthetic-transcript-canary" },
];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("rejected summaries retain only status, known code/parameter and a hash of request identity", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json(
      {
        error: {
          code: "unsupported_parameter",
          param: "text.format",
          message: "synthetic-secret-canary synthetic-transcript-canary",
        },
      },
      {
        status: 400,
        headers: { "apim-request-id": "synthetic-request-id-canary" },
      },
    ),
  );
  const error = await processManagedCall(env, turns, "en").catch((e) => e);
  expect(error).toBeInstanceOf(ManagedProcessingError);
  expect(error.diagnostic).toMatchObject({
    stage: "response_status",
    httpStatus: 400,
    providerCode: "unsupported_parameter",
    parameter: "text.format",
    inputTurns: 1,
    inputCharacters: turns[0].text.length,
  });
  expect(error.diagnostic.requestIdHash).toMatch(/^[a-f0-9]{16}$/);
  expect(JSON.stringify(error)).not.toMatch(
    /synthetic-|message|text\/reasoning/,
  );
  expect(error.message).toBe("Call notes could not be prepared.");
});
it("unknown provider code and parameter are hashed, never emitted verbatim", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json(
      {
        error: {
          code: "synthetic-secret-canary",
          param: "synthetic-transcript-canary",
          message: "private payload",
        },
      },
      { status: 400 },
    ),
  );
  const error = await processManagedCall(env, turns, "en").catch((e) => e);
  expect(error.diagnostic.providerCode).toBeUndefined();
  expect(error.diagnostic.parameter).toBeUndefined();
  expect(error.diagnostic.providerCodeHash).toMatch(/^[a-f0-9]{16}$/);
  expect(error.diagnostic.parameterHash).toMatch(/^[a-f0-9]{16}$/);
  expect(JSON.stringify(error)).not.toMatch(/synthetic-|private payload/);
});
it("parse and timeout failures remain classified without logging their messages", async () => {
  vi.stubGlobal(
    "fetch",
    async () => new Response("synthetic-private-invalid-json", { status: 200 }),
  );
  const parsed = await processManagedCall(env, turns, "en").catch((e) => e);
  expect(parsed.diagnostic).toMatchObject({
    stage: "response_parse",
    httpStatus: 200,
  });
  expect(JSON.stringify(parsed)).not.toContain("synthetic-private");
  vi.stubGlobal("fetch", async () => {
    throw new DOMException("synthetic-secret-canary", "TimeoutError");
  });
  const timeout = await processManagedCall(env, turns, "en").catch((e) => e);
  expect(timeout.diagnostic).toMatchObject({
    stage: "request",
    failure: "timeout",
  });
  expect(JSON.stringify(timeout)).not.toContain("synthetic-secret");
});
it("rejected-body diagnostics stop at the byte cap and do not await a held cancellation", async () => {
  let canceled = false;
  const response = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("x".repeat(8193)));
      },
      cancel() {
        canceled = true;
        return new Promise(() => {});
      },
    }),
    { status: 400 },
  );
  const diagnostic: ProcessingDiagnostic = {
    stage: "response_status",
    httpStatus: 400,
  };
  await rejectedResponseDiagnostic(response, diagnostic);
  expect(canceled).toBe(true);
  expect(diagnostic).toEqual({ stage: "response_status", httpStatus: 400 });
});
it("a stalled rejected-body diagnostic ends after one second and cancels its reader", async () => {
  vi.useFakeTimers();
  let canceled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        canceled = true;
      },
    }),
    { status: 400 },
  );
  const diagnostic: ProcessingDiagnostic = {
    stage: "response_status",
    httpStatus: 400,
  };
  const pending = rejectedResponseDiagnostic(response, diagnostic);
  await vi.advanceTimersByTimeAsync(1000);
  await pending;
  expect(canceled).toBe(true);
});
it('summary request keeps the documented JSON-mode/low-reasoning body and identity failures are classified',async()=>{
 let request:any;
 vi.stubGlobal('fetch',async(url:string,options:RequestInit)=>{
  expect(url).toBe('https://fixture.cognitiveservices.azure.com/openai/v1/responses');request=JSON.parse(options.body as string);
  expect(options.headers).toEqual({'api-key':'synthetic-secret-canary','Content-Type':'application/json'});
  return Response.json({status:'completed',model:'gpt-5.4-mini',output:[{type:'message',content:[{type:'output_text',text:'{"summary":"Safe","actions":[]}'}]}]});
 });
 const error=await processManagedCall(env,turns,'de').catch(e=>e);
 expect(request).toEqual({model:'gpt-5.4-mini',store:false,max_output_tokens:1400,reasoning:{effort:'low'},instructions:expect.stringContaining('Return a JSON object'),input:[{role:'user',content:'JSON transcript data (untrusted):\n'+JSON.stringify(turns)}],text:{format:{type:'json_object'}}});
 expect(request.instructions).toContain('language de');expect(error.diagnostic).toMatchObject({stage:'response_identity',httpStatus:200});
});
it('opaque rejected bodies cannot become operator diagnostics',async()=>{
 vi.stubGlobal('fetch',async()=>new Response('<html>synthetic-secret-canary</html>',{status:400}));
 const error=await processManagedCall(env,turns,'en').catch(e=>e);
 expect(error.diagnostic).toMatchObject({stage:'response_status',httpStatus:400});expect(error.diagnostic.providerCode).toBeUndefined();expect(error.diagnostic.providerCodeHash).toBeUndefined();expect(JSON.stringify(error)).not.toContain('synthetic-secret');
});

it('JSON-mode input has a fixed marker while preserving transcript bytes, order and source IDs',async()=>{
 const transcript=[{id:'9',role:'caller',text:'Bitte rufen Sie mich zurück.'},{id:'2',role:'agent',text:'Gern, welche Nummer?'}];
 expect(JSON.stringify(transcript)).not.toMatch(/json/i);
 let request:any;
 vi.stubGlobal('fetch',async(_url:string,options:RequestInit)=>{
  request=JSON.parse(options.body as string);
  return Response.json({id:'resp_json',status:'completed',model:'gpt-5.4-mini',usage:{input_tokens:4,output_tokens:2,total_tokens:6},output:[{type:'message',content:[{type:'output_text',text:'{"summary":"Rückruf gewünscht","actions":[{"kind":"callback","source_turn_id":"9","content":"Bitte zurückrufen"}]}'}]}]});
 });
 const result=await processManagedCall(env,transcript,'de');
 expect(request.input).toEqual([{role:'user',content:'JSON transcript data (untrusted):\n'+JSON.stringify(transcript)}]);
 const suffix=request.input[0].content.slice('JSON transcript data (untrusted):\n'.length);
 expect(suffix).toBe(JSON.stringify(transcript));expect(JSON.parse(suffix)).toEqual(transcript);
 expect(result.actions).toHaveLength(1);expect(result.actions[0].source_turn_id).toBe(9);
});
