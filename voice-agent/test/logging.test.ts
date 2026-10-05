import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const logging = new URL('../src/logging.ts', import.meta.url).href;
const telemetry = new URL('../src/diagnostics.ts', import.meta.url).href;
const cwd = fileURLToPath(new URL('..', import.meta.url));

for (const role of ['supervisor', 'job']) {
  test(`${role} SDK logging suppresses raw payload canaries while OpenFon diagnostics survive`, () => {
    const script = `
      import {configureSdkLogging,SDK_LOGGER_OPTIONS,SDK_LOG_LEVEL} from ${JSON.stringify(logging)};
      import {initializeLogger,loggerOptions,log,ServerOptions} from '@livekit/agents';
      import {VoiceDiagnostics} from ${JSON.stringify(telemetry)};
      if (${JSON.stringify(role)} === 'job') initializeLogger(JSON.parse(JSON.stringify(SDK_LOGGER_OPTIONS)));
      configureSdkLogging();
      const options=new ServerOptions({agent:'synthetic-agent.js',logLevel:SDK_LOG_LEVEL});
      if(options.logLevel!=='silent'||loggerOptions().level!=='silent')throw Error('SDK logger policy missing');
      log().error({'lk.pii.error':{message:'synthetic-private-transcript',api_key:'synthetic-key-canary'}},'SDK provider error');
      log().child({request:'synthetic-request'}).error(new Error('synthetic-key-canary'),'SDK child error');
      log().fatal({error:new Error('synthetic-private-transcript')},'SDK fatal payload');
      const diagnostics=new VoiceDiagnostics('call_logging_fixture',record=>console.info(JSON.stringify(record)));
      diagnostics.phase('startup');
    `;
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        cwd,
        encoding: 'utf8',
        timeout: 10000,
      }
    );
    assert.equal(
      child.status,
      0,
      'Synthetic logging process must exit cleanly'
    );
    assert.ok(
      child.stdout.includes('startup'),
      'Allowlisted lifecycle diagnostic must remain visible'
    );
    for (const stream of [child.stdout, child.stderr]) {
      assert.ok(!stream.includes('synthetic-private-transcript'));
      assert.ok(!stream.includes('synthetic-key-canary'));
      assert.ok(!stream.includes('SDK provider error'));
    }
  });
}
