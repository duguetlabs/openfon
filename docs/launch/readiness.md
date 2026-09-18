# Release checklist

This release is not approval to deploy production or claim live telephone readiness.

## Code release

- [ ] Pass required CI on the final commit.
- [ ] Resolve real review findings and obtain the required PR-Agent security and major-issue clearance before merging.

## External acceptance still required

- [ ] Rehearse a fresh installation and production-shaped migration/preservation/recovery using separate disposable resources. A D1 backup does not restore Durable Object state. See [migration compatibility](../migration-compatibility.md).
- [ ] Verify authenticated setup and an actual microphone conversation against an independently configured provider. Synthetic PCM and browser graph tests do not prove physical audio or provider behavior.
- [ ] Verify interruption follow-up in an audible real-provider call: old playback stops, the matching new answer completes, and only then does the next prompt begin. Strict provider-explicit natural-VAD causality is not established by the existing recordings.
- [ ] Complete a consented SIP/PSTN pilot with the chosen carrier, number and spending explicitly authorized. Telnyx setup still requires the authorized account login; the existing support appeal must not be duplicated. See [pilot evaluation](pilot-evaluation.md).
- [ ] Before a separately approved production deployment, confirm operator/hostname/provider configuration, take a fresh backup, verify rollback/recovery, and explicitly enable only accepted routes. See [production preflight](production-preflight.md).

## Existing evidence and limits

The [corrective staging recording](demo/corrected/README.md) demonstrates canonical opening hours, missing-phone handling and persisted messages with a disclosed synthetic caller. Its interruption follow-up is inconclusive. The [original recording](demo/audible/README.md) remains labeled with its failures.

Local tests cover provider configuration, stale knowledge writes, confirmed deletion, reservation cleanup, and realtime transport bounds. Past synthetic and silent-browser checks do not establish live-provider, microphone, physical audibility or PSTN acceptance. See [audio harness](demo/capture-harness.md) for reproducible local commands.
