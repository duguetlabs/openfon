#!/usr/bin/env node
/** Read a PBX password from stdin; emit only its salted verifier. Keep input and
 * output out of shell history/logs. Format matches src/auth.ts hashPassword. */
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
const password=readFileSync(0,'utf8').replace(/\r?\n$/,'');
if(!/^[\x21-\x7e]{32,512}$/.test(password)){
  console.error('PBX password must contain 32–512 printable ASCII characters without spaces.');process.exit(1);
}
const salt=webcrypto.getRandomValues(new Uint8Array(16));
const key=await webcrypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
const bits=await webcrypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:100000},key,256);
process.stdout.write(`${Buffer.from(salt).toString('base64')}:${Buffer.from(bits).toString('base64')}\n`);
