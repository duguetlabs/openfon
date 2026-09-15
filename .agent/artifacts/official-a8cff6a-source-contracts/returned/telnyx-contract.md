# Capacity Leak — exact a8 source-only receipt

Status: completed owner source assessment; the existing independent QA review is pending. This receipt persists the contract already sent to integration and QA. It selects no correction or execution.

Authority: Root68ee914 and integration selection `1e1805c5afbdac7b25be303193a8f79f2f2c43331cea0864d27d7cfdd7426588`; citation map `c946f89ccd4c34c1a2f24b3752efeb97feaf70a484e8cb8b426b7d66669876c6`. Documentation authorized separately after the source assessment. Recorded 2026-09-15 UTC.

## Frozen application and report identities

Integration commit: `a8cff6a7eab73bff0e48c2afe992a3cb69d995c0`. The following application files were read from that exact commit and independently matched the integration working bytes. The older owner application checkout was not used as current source.

| Source | SHA-256 |
| --- | --- |
| `src/telnyx-routes.ts` | `2351a3bcdca548785d439ae32be2cdfb64be6148e1d1c03a681281b8b2d73c41` |
| `src/telnyx-webhook-admission.ts` | `fc043545b374aa6b6d378faf64a51006df6bfb9ebc752535dcaa62807c777e24` |
| `src/telnyx-webhook.ts` | `fba2355f23073ae5fdaa2ae4f4d056cb4e27dca67c49dad18c7f3c15d66a97e5` |

Original review: <https://github.com/duguetlabs/openfon/pull/16#issuecomment-5677843598>. Original SHA-256 `ba4a975674d31d1349f878363bdda270774226a03275daab1c5e82fa08f561ff`; full public body independently read and matched `2ac5b5d5cf9ab7a8d32e7f80b87d5003327c19e02b6600fa702b7a37042f4473`. The report's 542 omissions remain; this receipt is not exhaustive review or security/major clearance.

The Capacity Leak assertion is that a body deadline leaves a pending read, immediate releaseLock throws despite eventual successful cancellation, and sixteen such requests permanently quarantine the isolate. The assessment below qualifies that specific causal assertion. It does not deny other availability limitations.

## Existing application contract and ordering

In `telnyx-routes.ts`, module admission precedes reader/buffer/timer acquisition. Sixteen scalar leases are shared across route registrations within an isolate; excess requests receive 503 without a rejected-request reader or cleanup queue. Existing configuration/missing-body precedence remains.

On body error/deadline, lines17-25 and59-68 first mark cancellation requested, call reader.cancel once without awaiting it, and register fulfillment/rejection handling. Finally marks finished, clears the timer, attempts releaseLock once, records successful release or quarantine, then marks body settlement. The consuming promise independently records settlement at line56. The outer route records settlement at line109, including after verification and durable dispatch. The finished/absolute deadline guards prevent a late read from returning a successful body into dispatch.

The lease releases exactly once only when routeDone, bodyDone, consumeDone, lockReleased and cancelFulfilled are all true and quarantined is false. Calling cancellationStarted before cancel prevents an early successful release; early callbacks cannot bypass the remaining conditions. Outer 408 alone does not return credit. The existing 128KiB allocation, finite read-work bound, five-second body budget, signature bytes/statuses and durable acceptance contract remain unchanged. There is no new downstream deadline.

## Standards and Workers source are distinct

Current WHATWG default-reader releaseLock delegates to ReadableStreamDefaultReaderRelease, which releases the reader and errors outstanding read requests with TypeError. This is rejection of read promises, not the claimed synchronous pending-read releaseLock exception. ReadableStreamCancel closes a readable stream and resolves outstanding default reads before reacting to the underlying source cancellation promise. Thus the standard does not require awaiting that promise before releasing the reader.

Workers documentation explicitly says releaseLock throws TypeError and retains the lock if reads are pending. That platform distinction is retained; a WHATWG-only dismissal would be insufficient. The documentation's displayed cancel return type is not used to infer the implementation's settlement timing.

The inspected workerd native controller at tag `v1.20260911.1`, commit `925464ba9fe5751e4468626ce77f7a5810df274f`, wraps pending native reads in the reader lock's canceler (internal.c++ lines718-720). cancel at1008-1018 calls doCancel before returning its resolved promise. doCancel at1021-1035 synchronously invokes that canceler's cancel, then cancels/closes the readable source. releaseReader at1185-1206 checks the same canceler's isEmpty at1190, rather than waiting for JavaScript read reactions to execute.

That workerd revision pins Cap'n Proto `851c45bb39c34c3f20f9d9ebe9f34a7e39109b6f`. Its KJ Canceler implementation at async.c++201-209 unlinks and cancels entries synchronously until the list is empty. async.h941-942 explicitly guarantees cancellation/destruction before cancel returns; isEmpty at980 tests that list. Therefore, on the traced successful native cancellation path, pending JavaScript read reactions do not establish that releaseReader's outstanding-native-read guard remains nonempty. This is source reasoning, not a newly observed native execution result.

The locally installed workerd package reports version `1.20260911.1`. This is version-to-upstream-tag correspondence only: no binary hash, build provenance, deployed runtime identity, hosted behavior, or historical-runtime equivalence was attested. Native behavior outside the inspected controller/revision is not proved. No probe was run.

## Exact external citations and byte identities

These are documentation/source reads only. Immutable links and full SHA-256 values below identify the citation bytes. Initial WHATWG and Workers documentation reads used their live URLs; immutable revisions were resolved and hashed while persisting this receipt. Do not relabel the earlier unpinned reads as historically pinned captures. No external source was imported into or executed by the application.

- WHATWG Streams: revision `b9ba9f49d95b4280be0dc2372377a006c3a91c18`, [index.bs](https://raw.githubusercontent.com/whatwg/streams/b9ba9f49d95b4280be0dc2372377a006c3a91c18/index.bs), 417076 bytes, SHA-256 `24360b4f8446e6c80e185c5021fcca9b67a7e0bb62490a00109080ebc04c6440`. Relevant algorithms: [releaseLock](https://streams.spec.whatwg.org/#default-reader-release-lock), [default-reader release](https://streams.spec.whatwg.org/#readablestreamdefaultreaderrelease), [stream cancel](https://streams.spec.whatwg.org/#readable-stream-cancel), [stream close](https://streams.spec.whatwg.org/#readable-stream-close), and [generic-reader release](https://streams.spec.whatwg.org/#readable-stream-reader-generic-release). Rendered links are live; the immutable source/hash is authoritative for this receipt.
- Workers documentation: [rendered DefaultReader page](https://developers.cloudflare.com/workers/runtime-apis/streams/readablestreamdefaultreader/); repository revision `6b5995d95d622b3350227af41ceb30a920e7c44c`, [readablestreamdefaultreader.mdx](https://raw.githubusercontent.com/cloudflare/cloudflare-docs/6b5995d95d622b3350227af41ceb30a920e7c44c/src/content/docs/workers/runtime-apis/streams/readablestreamdefaultreader.mdx), 2106 bytes, SHA-256 `b07ba58fd4c5b3d017e179b9b1fac3baf306bc7d509bd408de53d55984df7c2c`.
- workerd native implementation: tag `v1.20260911.1` resolves to commit `925464ba9fe5751e4468626ce77f7a5810df274f`; [internal.c++](https://raw.githubusercontent.com/cloudflare/workerd/925464ba9fe5751e4468626ce77f7a5810df274f/src/workerd/api/streams/internal.c++), 131912 bytes, SHA-256 `01aad068408472741e6ed6046c799b8b978c10872856c968eacc826c05c39e73`.
- workerd dependency pin at the same commit: [deps.MODULE.bazel](https://raw.githubusercontent.com/cloudflare/workerd/925464ba9fe5751e4468626ce77f7a5810df274f/build/deps/gen/deps.MODULE.bazel), 6131 bytes, SHA-256 `6e7744f0cacb095d16784f1b1d9071f73e220c46b5e5efc35ec5fb9339ffbfe5`. Lines27-34 pin Cap'n Proto to the revision below; archive SHA-256 is `dcd96af005ea6fab167e63b6d53b05db13c03339766d26c07e0b3cbe54e1982e`.
- KJ implementation at pinned Cap'n Proto revision `851c45bb39c34c3f20f9d9ebe9f34a7e39109b6f`: [async.c++](https://raw.githubusercontent.com/capnproto/capnproto/851c45bb39c34c3f20f9d9ebe9f34a7e39109b6f/c++/src/kj/async.c++), 109290 bytes, SHA-256 `34649fc3ca4924c6640afd3472c75b9f8dc6047ca0d231969b2a8b790a3dc9d1`.
- KJ contract at the same pinned revision: [async.h](https://raw.githubusercontent.com/capnproto/capnproto/851c45bb39c34c3f20f9d9ebe9f34a7e39109b6f/c++/src/kj/async.h), 77194 bytes, SHA-256 `e4bab67a70e4c948f8ce1f638b21420f0036a49a85ef93fa0f6508319abdf4fe`.

## Retained evidence and availability limits

Historical evidence remains in `webhook-leases-ddce/evidence/validation.json`, with original identity `df9e6499006c67c97c4cbdf77b71a1c0d9ad241709b6fdf62ddd6b8d9ba4959b` and explicit public-derived metadata. That historical fixed run records the identical route/lease production hashes above: fixed207 tests and Worker types passed; native HTTP saturation/refill and held-dispatch passed. This is prior evidence, not new a8 execution or a blanket current-runtime claim.

The native HTTP fixture wraps the actual HTTP body's reader; its source separately marks held-cancel and failed-lock as synthetic readers. Native results remain exactly 2PASS/2UNAVAILABLE/0FAIL. The two unavailable scenarios did not observe late callbacks in finite windows after gate release. They do not prove eventual refill, successful fully-settled quarantine, or request-context teardown as the cause. Native HTTP success does not establish every closure/transport schedule. The Node real-ReadableStream case in test/telnyx-webhook-admission.test.ts202-210 is separate from native HTTP; synthetic lockFails proves lease response to an injected throw, not that native releaseLock throws after successful cancellation. Repeated Promise resolution attempts are not repeated actual lease callbacks.

Actual cancellation rejection/throw, lock-release/timer-cleanup failure, unresolved work, or lost contexts can still retain/quarantine capacity under the previously accepted policy. In particular an already-errored stream can return a rejected cancellation promise; this receipt does not reinterpret that path as successful cleanup. Sixteen stranded leases can deny this isolate indefinitely. There is no TTL/reset-on-408, unconditional cancellation guarantee, global/distributed admission bound, TCP teardown proof, zero-DoS claim, or exhaustive host/real-DO/D1 guarantee. Preserving this limitation does not substantiate the report's distinct claim that an ordinary successful cancellation necessarily leaves a pending-read releaseLock failure.

## Qualified disposition and handoff

Recommend declining the specific ordinary-timeout-to-permanent-lock-quarantine causal assertion on the inspected source, subject to the existing independent QA agreement. Do not claim all Streams implementations share WHATWG behavior or that the application cannot strand capacity. No correction, fixture, retry, timeout change, dependency change or runtime was selected or performed. Prior lease/reason evidence and all original failures, unavailable classifications and cleanup limitations remain intact. Integration alone selects any correction and public disposition.

This is the durable pointer for the same pending QA request already sent once; it does not request a second assessment. Only this source receipt and an additive owned checkpoint pointer are changed.
