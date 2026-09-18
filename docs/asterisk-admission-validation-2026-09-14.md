# Asterisk admission and local Docker connection validation — 2026-09-14

Base: `1ba053df3f6463f3601a3eaa41a465d914c64d9c`, official report5657301610.
The correction pins the credential identity of the readiness read, then compares
provider presence/raw fields and assistant engine/model/voice in the reservation
INSERT. Conflicts return403 without a D1 call or session dispatch; the Durable
Object still writes its replay/retirement state. CallSession continues to reload
settings at pickup. This does not freeze configuration after reservation.

Local validation:

- Original source with17 new targeted admission cases:11 failed,6 passed,
  54 existing cases deliberately skipped. The existing engine guard already
  rejects its race; unchanged/default/custom and unrelated-STT cases also pass.
- Fixed control/credentials/media/runtime focused suite:124/124 passed,4 files.
- Worker and web typechecks passed.
- Original actual-workerd held-key-change case reserved1 call and dispatched1
  session, returning the synthetic session failure503 instead of admission403.
  An initial negative log lacked those observation counts; a reporting-only
  harness addition retained that log and repeated the one case with counts.
- Fixed actual workerd owner plus migrated D1:8 held reservation conflicts
  (provider key/selection/URL, model, voice, provider insert/delete and route
  reassignment) each returned403 with0 calls/0 session dispatches. Two controls
  (unchanged and unrelated STT edit) admitted1 call/1 dispatch before the
  deliberately failing synthetic session returned503. Retired markers and
  absent alarms survived disposing/restarting the SQLite-backed runtime.
  This uses a synthetic trusted-binding credential and session stub; it does
  not exercise public PBKDF2 authentication, provider startup or real PBX audio.
- macOS Docker Desktop, existing image only: real Asterisk22.11.0 Local-channel
  smoke passed with the pinned daemon and Desktop connection mode. Caller PCM
  reached the mock provider; assistant recording19200 bytes, peak7932 and
  440Hz amplitude7981. Actual ANSWER1/MARK_MEDIA12/FLUSH_MEDIA1/HANGUP1 and
  MEDIA_MARK_PROCESSED12;3 persisted turns and completed/released call.
  Revoked attempt sequence2/runtime-revoked/HTTP401 attempted0 rate writes,
  preserved counters and created no extra call. Zero channels remained.
- All processes exited; Miniflare and named fixture/proxy disposed. Follow-up
  pinned-daemon query found no openfon-asterisk fixture containers; ports
  8811/9251/8821 had no listeners. No image build or pull occurred.

The Linux selection and Docker environment precedence/pinned lifecycle were
covered by focused tests. Native Linux Docker/PBX execution was unavailable and
is not claimed. Other VM or forwarded Unix-socket topologies remain unsupported
operator-locality conditions, not universally detectable refusals. No live AI,
physical microphone, SIP trunk, PSTN, account, staging or production action ran.

These historical local results do not replace current-commit review and CI, or a real carrier pilot.
