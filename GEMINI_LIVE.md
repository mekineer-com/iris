# Gemini Live Provider Contract

Read this before changing `GeminiLiveController.ts` or diagnosing a Gemini
socket failure. This is the local contract for Iris, not a copy of all Gemini
documentation.

Documentation snapshots and fictional-provider observations: 2026-10-20.

Iris runs on Gemini 3.8 Live. MCP returns the constrained `v1beta` socket;
token minting stays on `v1alpha/auth_tokens`. The server default is
`gemini-3.8-live`, and configs still naming the retired 2.5 preview model are
migrated to it with a backup.

The coordinated ordinary-photo contract requires and echoes
`photo_work_protocol: "iris-photo-work-v2"`. Iris refuses a missing/mismatched
response marker before opening Gemini and releases any acquired lease. Token
mint/renewal expose six NON_BLOCKING tools, including argument-free
`nothing_to_add`; Iris handles it through the local photo dispatcher, using
SILENT on regular Live for an empty acknowledgment without taking away a pending human answer's
continuation. Audio Start uses the deliberate-photo startup instruction; Video
Start sends `vision: true` and receives the combined camera/selection prompt.

## Source Contract

- Models: `gemini-3.8-live` / `gemini-3.8-live-extended-thinking`. The phone's
  Thinking switch saves the shared OpenAlma setting through
  `POST /integration/mentra/model`; Start sends no model and uses the server's.
- Socket API: `v1beta`; token minting: `v1alpha/auth_tokens`.
- Method: `BidiGenerateContentConstrained`
- Input audio: 16 kHz PCM
- Output audio: 24 kHz PCM
- Authentication and model/system/tool constraints are minted by
  `mcp-memu-server`; the permanent Gemini key never reaches Iris.

Google's examples may use a newer model. Do not infer that a preview 2.5 model
supports a newer model's behavior without one redacted wire fixture or a real
fictional-soul call.

## Official Sources

- WebSocket message reference:
  <https://ai.google.dev/api/live>
- Session lifetime, resumption, GoAway, and generation completion:
  <https://ai.google.dev/gemini-api/docs/live-api/session-management>
- Live API operational guidance:
  <https://ai.google.dev/gemini-api/docs/live-api/best-practices>

## Iris Wire Shapes

### Setup and resumption

Each controller owns one sitting and accepts Start once. SessionController
creates a replacement for another sitting; renewals and socket reconnections
stay inside the existing controller and lease. Recovery uses the phone journal,
not resetting/restarting an old controller.

New connection:

```json
{"setup":{"sessionResumption":{}}}
```

Replacement connection:

```json
{"setup":{"sessionResumption":{"handle":"<opaque handle>"}}}
```

Because setup includes `sessionResumption`, Gemini may send:

```json
{"sessionResumptionUpdate":{"resumable":true,"newHandle":"<opaque handle>"}}
```

Keep only a non-empty `newHandle` when `resumable` is true. A false update
clears the handle. The handle is provider state, never transcript content.

### Internal invitation and photo identity

The internal invitation is exactly `nokoru`, sent as text. Continuous uses
`realtimeInput.text`; Manual reuses a completed `clientContent` text turn between
takes. The startup instruction identifies it as Iris input, not human dialogue.
Successful background recall may queue one invitation; native tool batches,
human speech, playback drain and Manual recording/review hold it. An existing
quiet choice can consume readiness without another cue. No audio cue, spelling
filter, fixed mute interval or independent idle timer is used. Never replay a
sent invitation on reconnect; an unsent reason stays within its current sitting.

Picked photos use the phone's persisted timestamp reservation before upload.
The journal carries original/receipt time and timezone provenance to finalization;
filing uses that time, not the later caption arrival. Missing EXIF uses receipt
time; a missing original timezone stays unspecified. Accepted filing metadata
cannot be changed by a conflicting duplicate. Only a confirmed original-ID
conflict before model delivery offers another suffix; uncertain uploads retry
the same ID. The file picker is bound to the sitting in which it opened.

### Internal photo task

Iris stores each original in OpenAlma before provider delivery. Upload and stored
original lookup retain their existing 120-second request deadline. A newly
chosen/taken photo is previewed as realtime video, including during conversation;
that preview does not request a caption. Recovered originals are not replayed
as standalone video over a newer preview. Captioning has one path only:

1. At a quiet opening, an eligible readiness call or one coalesced `nokoru`
   invitation starts work. Manual recording/review and actual playback hold new
   jobs. Ordinary memory results retain their existing requested-answer behavior.
2. The first `nothing_to_add` after fresh previews receives only
   `{"next":"A photo task is ready. Call nothing_to_add to receive it."}`,
   scheduled WHEN_IDLE. A fresh preview during lookup/preparation requires this
   settling step again. Same-cohort calls do not bypass it or consume a retry.
3. A distinct readiness call receives `response.task: "please-caption-<id>"`
   and that exact stored original in `functionResponses[].parts[].inlineData`,
   with the actual provider call ID and WHEN_IDLE scheduling. No separate caption
   text turn, 500ms timer, IMAGE-token baseline or ingestion-count gate exists.
4. `save_photo_caption` names its exact original. A valid first caption is
   journaled and handed off independently of timeline append. Its successful
   durable receipt uses WHEN_IDLE so the next readiness call can follow.
5. An empty queue gets `{"ok":true}` / SILENT (Thinking: see quiet choices
   below). Stop and optional spoken
   descriptions wait for that real closing-readiness native completion; Iris
   never manufactures a provider completion event.

One existing arrival-ordered pending collection owns recovery; one active job
tracks loading, settling, dispatch and filing. Valid late captions target their
known dispatched original, not whichever photo is first. Wrong/undispatched IDs
and conflicting captions cannot file. An image-based caption receipt ID is stable
across timeline replacement. Actual human speech remains audible and saved;
internal captions are `photo_caption` events, not assistant dialogue.

A readiness call that normally returns without its caption checks existing
filing receipts, then resends the same ID/original once with the approved prefix:
"Your memory store didn't receive the photo caption. Please send it!" A second
miss parks that original for user Retry/Discard and serves the next eligible
original through the same call. Interruption, reconnect and pre-send deferral
do not spend or refill that allowance. Explicit Retry resets it. A stalled
settling/job phase has a 30-second deadline and retains its original for Retry.

JPEG and PNG stay native inputs. Correct ID, native completion and durable
handoff prove their own boundaries, not correct visual perception or image
arrival. No new runtime visual classifier or fabricated ingestion receipt is
introduced. Historical IMAGE-count experiments remain evidence in the workspace,
not a production fallback. This dispatcher still needs phone acceptance.

The existing snapshot-finalize route acknowledges durable server ownership from
the scoped original and caption independently of transcript append. Its stable
image-based caption ID is journaled before submission; it need not wait for a
timeline sequence. That receipt ID is not a timeline ID: every timeline event
still uses its required sitting/sequence ID. The acknowledgment clears photo-filing responsibility, not
the pending caption timeline event. Extraction continues independently; later
transcript saves do not wait for it. Replays
inspect the server filing receipt before requesting another caption, even after
provider resumption. A different photo cannot implicitly discard pending work.
An optional spoken description remains separate from this internal caption.

The main Start/Stop row has **Closing thoughts**, checked by default and
remembered in phone-local SDK storage. It controls reflection playback only;
existing generation/saving rules are unchanged when unchecked. Stop freezes
the last confirmed choice; a preference save still pending at that moment
applies to later sittings without delaying Stop or changing speech midstream.
Ordinary conversation is cut immediately either way. Lifecycle earcons remain
nonverbal; the preference does not remove the existing Stop beep.

Normal Stop mutes provider output before callbacks and retains the socket/lease
for a shared 30-second foreground allowance, shown as an inline countdown. While
Iris lacks focus, the allowance extends to five minutes from the original Stop,
not from the focus change. Returning after 30 elapsed seconds ends admission
immediately. Work may finish early; no compulsory delay or popup is added.
The same deadline caps reflection. Native UI close/open and WebView visibility
update the actual provider deadline, not only its display. Hidden execution is
not guaranteed by the host; the absolute deadline is checked on return.
The speaker wait is capped too, including pending creation, retirement and
final playback. Expiry explicitly stops host playback and invalidates the old
writer epoch without awaiting a stalled SDK close (abort is a no-op once that
writer is settled). Neither late completion nor a later visibility change may
reopen an expired budget or affect the next sitting. Actual reflection text
available at expiry is retained through `sitting_summary`, without the
transcript-only `status` field.
Continuous Stop flushes existing
audio with 1.8 seconds of real-time-paced silence and `audioStreamEnd`, then
waits for the preceding response's native completion before a new image
turn. `audioStreamEnd` alone cannot release that fence. The existing flush owner
can wait for replacement readiness within the same drain cap. Manual
Stop does not send an unsent take. Replay cannot deliver a task mid-flush or
after the drain closes. An already-delivered task is not resent merely
because Stop was pressed. Timeout is logged and retains recovery state. Optional
reflection follows both handoff and the caption's native completion, even if the
handoff preceded Stop. A receipt turn that genuinely completes without another
readiness call is sufficient; parked originals alone do not hold Stop open.
Stop waits for a pending nokoru reply before reflection rather than silently
skipping the summary because an internal cue was outstanding. An unrelated failed photo does not suppress reflection.
Thinking also waits for an unfinished interaction's IDLE within that same
allowance before reflecting. A disconnect retires the interrupted interaction
and releases Manual Talk, even after an intermediate response segment.
Reflection-time tool requests receive an unavailable result without executing
tools. A GoAway preparation warning does not truncate reflection; actual socket
closure, interruption and the existing deadlines still retain received text.
Its text can settle at
`generationComplete` rather than waiting for delayed playback completion.

### Live frames and selected photos

`SessionSnapshot.frameDeliveryOpen`, paired with `startGeneration`, projects
the current sitting's delivery opportunity. It closes during original upload,
runnable photo work, filing, caption receipts and their native continuation,
reconnect, pause or teardown. Parked Retry items alone do not close it, and
ordinary user/Soul speech does not impose the quiet-invitation gate. Hidden
or camera-disabled UI also projects closed. Native opportunity changes publish
through the existing SessionController snapshot path without a polling timer.
This is not vision activation or permission to bypass cadence/catch-up.

An explicit Video Start opts into the approved combined starter; Audio retains
its existing instructions. `openalma:frame` carries the sitting generation,
reserved reference/sequence, receipt time, unmarked JPEG and stamped model copy.
The sequence rejects late arrivals. One bounded collection retains recent
candidates while protecting offered/chosen originals; full retention does not
block current-view delivery. Shared `VISION_SETTINGS` provides qualification
inputs (2s cadence, 12 entries, 8MiB encoded payload), not phone-proven settings.
The background send guard allows half-period jitter; the UI still samples every
2s. A waiting, unsent selection is dropped when a new human request starts so
it cannot close current-view delivery through the human's turn.
`openalma:frames` reads exact originating-sitting references, including Stop drain;
its bridge response contains only original bytes and imageId/mimeType/time, not
unused stamped copies or the intake reservation sequence.

The background projects one `catchUpRender` descriptor; the visible UI renders
those originals and returns JPEG data through `openalma:catch-up-rendered`.
Attempt, foreground/camera, socket, cadence and age are rechecked before send.
One chronological collage has priority for one capture period, then the current
view resumes; a missing renderer cannot hold voice or live delivery indefinitely.
The UI side of frames and collages is `src/ui/hooks/usePhoneVision.ts`.

Selection uses the same readiness/settling dispatcher, not another queue.
Deliberate photos have priority. Every offer needs remaining allowance; keep-none
is valid only on actual native completion, without requiring a further readiness
call. One per-sitting chosen-ID set counts admission once, preserving uncertainty
without a second upload charge. Normal capture refreshes the current view
between selection batches; Stop does not
wait for a new view after capture has closed. Maximum-photo preference is pinned
at Start and allowance time freezes at Stop.

Chosen originals are cached before their metadata commit is acknowledged.
Every admitted choice saves its bytes and metadata before waiting for an earlier
upload; Stop can preserve all choices, not just the first one in the upload lane.
Upload returns the original-byte receipt; acknowledged media-reference metadata
precedes cache deletion and finalization. Retry reuses the same bytes, caption
and original receipt, without recaptioning or renaming. Caption rows belong only
to the originating sitting; a later sitting can finish filing without claiming
the old caption as its own dialogue. Discard commits metadata removal before
cache cleanup; an unacknowledged removal warns rather than pretending durability.
Discard rejects during Stop rather than acknowledging an unsaved removal.

Stop closes new admission and gives retained candidates the existing shared
30-second/five-minute window. At expiry, still-unselected candidates are
discarded, not journaled or carried into a contextless new sitting. Access
refreshes the absolute deadline even if host timers were delayed. Protected
originals remain in their existing recovery collection. Terminal teardown also
releases unselected candidates; reconnect, hide and camera-disable do not
discard accepted candidates. Source wiring and offline checks do not establish
provider perception, camera/UI integration or phone acceptance.

Stored candidates alone are not active Stop work: an actual review/caption job
or filing owns the drain. Idle retained bytes must not force the full allowance
or prevent closing thoughts. They remain available during active work/reflection
and clear at expiry or terminal context teardown. Selection demand enters actual
review work, not a candidate-count wait.

One session-owned journal serializes immutable submitted snapshots across live
controllers. At Stop expiry only durability waits detach; retired producers
cannot overwrite successors. Warm reads use latest logical state. Uncertain
native writes rotate the next journal key, since timeout does not cancel physical
execution. An uncertain Recovered Chats write quarantines subsequent archive
rewrites; fresh-key preservation retains raw dialogue instead of risking an
older physical write erasing a newer archive. Specific chosen-photo commits
still require real acknowledgments; ordinary backup waits are not globally removed.

### Completion and connection rotation

The scheduling rules below describe regular Live. Thinking uses the same
dispatcher/tools but omits function-response `scheduling`; constrained setup
fixes its thinking level to LOW. At Thinking's intermediate `turnComplete`, Iris
records the output segment and can return pending tool results, without treating
the whole interaction as finished. `serverContent.interactionStatus: IDLE`
releases the request/Manual submission. Segment-local photo sibling markers do
not survive into the next segment; original-photo/native continuation ownership
does. The human transcription group remains open until final completion so late
suffixes are not counted as a second turn. All-zero Thinking PCM remains playback
but is not evidence of spoken words requiring a transcript; actual nonzero
speech retains the existing transcription integrity checks.

Thinking cannot reach IDLE while a readiness call waits, so an empty readiness
call gets the text "No photo task is ready. Say 'Done' once to finish this
private exchange." Iris then suppresses that private reply's audio and
transcript locally; the same applies to a background photo reply (caption
receipt or dispatched job) with no live human request. Suppression ends at
native activity start, spoken-request admission, interruption, disconnect or
interaction IDLE. A memory result arriving first releases it and turns already
queued quiet replies into plain `{"ok":true}`.

Start's returned model is authoritative.
Renewal stays pinned to the lease, not later config edits. The v3 phone journal
records the actual model; an ordinary no-recovery handle needs matching model
metadata to resume. Call mode is also pinned with the handle: Audio/Video changes
connect cold, since the startup instructions differ. Missing/different model metadata connects cold while retaining
photo/transcript ownership. Before-bootstrap dialogue recovery stays cold as
before. This does not assert context compatibility merely from equal model IDs.
Offline source checks are not live-provider/phone qualification of Thinking.

- A spoken request is admitted at Continuous native activity start or Manual
  Send, independently of when its transcription arrives. Tool calls retain
  their native batch and request ownership across separate messages.
- Results associated with an unanswered request wait for native completion, the
  end of capture, and every associated outstanding result. Earlier results use
  `SILENT` and the last uses `WHEN_IDLE`; holding the cohort also preserves a
  result that can wake the request if its slow sibling is canceled. Fresh tools
  requested during that continuation can provide another
  opportunity. Audible output makes further results silent. A completed response
  without outstanding tools, including intentional silence, closes normally.
- Unresolved background work may overlap a new admission; only that unresolved
  batch can adopt it. Completed old batches and superseded requests cannot wake
  later speech. Cancellation of the last outstanding tool closes its settled
  request. Stop revokes continuation immediately but permits silent photo handoff.
- A new explicit photo task starts a background batch, not an older spoken
  request's cohort. Its native phase fences the next photo's provider delivery,
  not acceptance/storage of that next original. A missing caption at a provider
  boundary exposes logged Retry/Discard; an eventual valid caption can still
  complete its original task. Failed filing itself still requires explicit Retry.
- A reply cut by Stop is saved as interrupted. Late transcription of that reply
  is retained while its pre-Stop audio is still being settled; this does not
  establish an exact heard-word cutoff. Missing text for heard audio records a
  nonfatal gap during Stop, without canceling photo calls. Muted-only output
  does not become shared dialogue. An orphan text fragment without an admitted
  capture is not labeled interrupted merely because no activity-end arrived.
- This is a scheduling policy, not proof that tools caused silence or that any
  PCM fully answered a question. Gemini supplies no request IDs for those claims.
  It can still choose silence after `WHEN_IDLE`; no synthetic transcript or
  semantic question classifier is introduced. Late ASR cannot reopen a request.
- In-process replacement preserves already-settled pending requests and does not
  repeat uncertain writes. A socket loss before native completion (including an
  in-flight continuation) cannot certify completion: its unfinished results
  resume silently, without an invented wake. Retiring a Manual request releases
  its submitted state even if playback never began; retained settled debt stays
  pending.
  Provider acceptance of these integrated races remains a separate gate.
- `serverContent.turnComplete: true` closes response generation, not input
  transcription ownership. Reserve spoken input at native activity start, or
  Manual Send; the Manual echo does not create another reservation.
- Preserve the existing normal save boundary when words are present at response
  completion. This is not proof of a native ASR final marker. If the response
  completes first, keep an unsequenced group in the existing journal. Overlapping
  admissions combine words with an explicit uncertain-timing, received-order
  label. Once words are present and capture has ended, the current request's
  normal response completion closes that group so later clean turns stay
  separate. Older-owner completions and photo-only background completions cannot
  close it. Stop/recovery seals any remaining group. No new timeout or
  reconstructed split is used.
- Only a ready prefix receives server sequences, after Unicode-safe splitting.
  Sequenced rows remain immutable, including after a lost acknowledgment.
  Before Start, identifiable saved drafts seal against their original sitting
  ID and saved boundary. Start carries the whole original-ID tail in `recovery`,
  so publication precedes entry-context construction/token minting. Exact
  `sitting_id`/`ack_sequence` acknowledgment is required before retirement and
  provider connection; rows are never reassigned to the replacement lease.
  Missing acknowledgment keeps the backup and refuses that Start, including
  on an older server which silently ignores recovery.
- Recovery starts cold: its newly minted context already contains the recovered
  dialogue. No synthetic client-content history turns are sent. No-recovery
  resumption and ordinary same-sitting renewal retain their existing path.
  Legacy identity-less drafts, mixed-origin rows and inconsistent boundaries
  are preserved through Recovered Chats rather than guessing or regrouping.
  `mentra_recovery_conflict` or422 on a recovery Start preserves/warns and
  retries once without recovery; another422 fails normally. Photo originals,
  stable filing receipts and original times retain independent recovery.
- Phone-storage failure warns but never disables server transcript saving or
  imposes a new Start blockade. Freeze/retirement writes use the existing
  journal tail; a failed write moves subsequent writes to a fresh key, retaining
  a replay-safe older snapshot. Unavailable storage cannot promise durability
  for new, not-yet-server-acknowledged speech if the process dies. Cancellation
  blocks retry Start calls and releases late returned leases even with bad acks.
- The journal writes payload version 3 with its owning `sessionId` and arrival-ordered `pendingImages` under
  the existing storage key; version 1/2 singleton records normalize at the read
  boundary. Filing/replay completions remove only their owned original, not a
  newly selected queue head. Parked photos retain ID-specific Retry/Discard and
  do not block another accepted original. Transcript-boundary repair preserves
  independently recoverable originals and stable caption receipt IDs. Older
  clients archive unknown versions; a downgrade is not pending-photo acceptance.
- Interruption and reconnect reset the actual photo attempt, not the queue head.
  Retry/Discard require an explicit photo ID; there is no head-targeting fallback.
  Graceful Stop drains runnable accepted photos, including those behind a
  captioned original awaiting filing. Non-graceful Stop retains unsent originals.
- `openalma:reserve-image` reserves phone-assigned timestamp IDs before replying,
  using serialized, owner/Soul/day-scoped high-water counters in `session.storage`.
  It merges pending and matching recovered-journal IDs. A lost unpublished reply
  may leave an unused suffix; a known reference is reused, never renamed on Retry.
  This naming adapter does not admit frames or send photos. The replacement
  dispatcher replaces the old sender and IMAGE-accounting gates; neither remains
  as a fallback path.
- `serverContent.generationComplete: true` means generation has finished; it is
  not a replacement for `turnComplete` in Iris transcript finalization.
- `goAway.timeLeft` announces a provider disconnect deadline. Iris rotates
  before that deadline using the latest resumption handle. Without a handle,
  Iris ends the sitting rather than inventing continuity.
- A WebSocket close event has `code`, `reason`, and `wasClean`. Preserve those
  in diagnostics; a generic "Gemini connection closed" is not enough evidence
  to classify a provider rejection, lease expiry, or network loss.

## Behavior Proven On Gemini 2.5

Historical evidence, not the current source's photo protocol:

- `clientContent` with inline image and `turnComplete: true` reaches Gemini and
  produces an image description.
- Continuous mode currently uses `END_SENSITIVITY_LOW` after an utterance was
  truncated while Iris remained in listening state. The cause remains unproven;
  native PCM or WebSocket delivery loss remain alternative explanations.
- The description transcript can be bound to the durable image and used as its
  caption.
- Session resumption works when Gemini has supplied a current non-empty handle.
- Gemini 2.5 may close an otherwise healthy pre-first-turn socket after about
  30 seconds with code `1006`, reason `timeout`, before issuing a resumption
  handle. Iris cold-reconnects once in that state because no completed provider
  turn can be lost. Once any provider turn completes, recovery still requires
  a handle.
- `clientContent` with `turnComplete: false` was silent but did not reliably
  become usable visual context on a later natural turn.
- SILENT tool-response `inlineData` remained connected but did not give the
  later turn usable image knowledge.

The last two results are why original-byte silent re-seeing remains deferred.
Captions supplement visual embeddings; they do not prove Gemini re-saw bytes.

## Local Evidence

Workspace evidence for 3.8 is in `PLAN_iris_gemini38.md` and
`_research/gemini-3.8-live/`. Slice 2 established caption feasibility. The
Slice 3 native-signal check observed speech activity events in both modes but
no input transcript offsets/IDs; it did not exercise late-input overlap, photo
handoff, interruption, reconnect or production Manual framing. Source tests and
provider/phone acceptance remain distinct.

- Image and resumption unit contract:
  `src/background/GeminiLiveController.test.ts`
- Redacted replacement-token live fixture:
  `../../../mcp-memu-server/tests/fixtures/mentra_gemini25_replacement_token_live.redacted.json`
- Redacted image wire fixture:
  `../../../mcp-memu-server/tests/fixtures/mentra_slice8_image_phase0.redacted.json`
- Redacted silent re-seeing fixture:
  `../../../mcp-memu-server/tests/fixtures/mentra_slice8_image_resee_phase0c.redacted.json`

Paths above are relative to the `apps-codex` workspace layout. The unit test is
the repository-local executable contract.

## Diagnostic Order

1. Read the WebSocket close `code`, `reason`, and `wasClean`.
2. Check whether a resumable handle existed before the close.
3. Check the redacted wire event immediately before the close.
4. Confirm the OpenAlma snapshot/finalize result separately; provider delivery
   and durable persistence are independent boundaries.
5. Only then alter retry or image-turn behavior.

Do not reconstruct the API from memory, add another transport, or infer a
provider rule from a generic close message.
