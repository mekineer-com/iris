# Gemini Live Provider Contract

Read this before changing `GeminiLiveController.ts` or diagnosing a Gemini
socket failure. This is the local contract for Iris, not a copy of all Gemini
documentation.

Documentation snapshots and fictional-provider observations: 2026-10-20.

Source migration in progress, 2026-10-20: MCP now returns `v1beta` and Iris
requires that constrained socket; token minting stays on `v1alpha/auth_tokens`.
The unsupported proactivity setting and its constraint-mask entry are removed.
These seams follow the Gemini 3.8 provider checks in `PLAN_iris_gemini38.md`.
No model/configuration cutover has occurred. Photo/tool plumbing, late-speech
reservations and requested-answer scheduling are implemented locally.
The current source is not a release-ready migration.

Checkpoint-3 foundations, 2026-10-22: Start requires and echoes
`photo_work_protocol: "iris-photo-work-v1"`. Iris refuses a missing/mismatched
response marker before opening Gemini and releases any acquired lease. Token
mint/renewal expose six NON_BLOCKING tools, including argument-free
`nothing_to_add`; Iris handles its empty acknowledgment locally with SILENT,
without taking away a pending human answer's continuation. Startup/photo prompt
replacement and the text-invitation/inline-job dispatcher are not yet applied.
The delivery/accounting behavior below still describes the current photo sender.

## Source Contract

- Target model: `gemini-3.8-live`; installed model settings stay unchanged until
  coordinated acceptance/cutover in Slice 5.
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

### Internal photo task

Iris snapshots the original in OpenAlma before provider delivery; upload and
replay each allow 120 seconds. Between spoken turns it sends the original as
realtime video, then the unchanged caption task after 500 ms:

```json
{"realtimeInput":{"video":{"data":"<base64>","mimeType":"image/jpeg"}}}
{"realtimeInput":{"text":"image_id: <id>\n<PHOTO_CAPTION_INSTRUCTION>"}}
```

The text contains `image_id: <id>` and `PHOTO_CAPTION_INSTRUCTION`, the exact
Marcos-approved wording.
Manual mode disables automatic activity detection, so its delayed text uses
`clientContent` with one user text part and `turnComplete: true`. Continuous
mode retains the realtime text shown above. Neither photo path sends activity
markers or admits a spoken request. An activityStart/text/activityEnd sequence
without audio caused a real1007 "Precondition check failed" and destroyed the
provider session; subsequent1008 resumption errors were its consequence.
The original video stays500ms before the text in both modes. The explicit text
turn passed a quiet, grounded Manual provider check before implementation.
Receipt-checked replay adds Marcos's approved line before the unchanged caption
instruction: "Your memory store didn't receive the photo caption. Please send it!"
This covers reconnect recovery, automatic/explicit Retry and deferred delivery;
it is not added to direct initial delivery. Existing accepted receipts return
without resending either image or request. The line reports missing filing,
not proof that Gemini saw the image or never attempted a tool call. Accounting,
normal native completion and durable handoff remain required.
Immediate separate delivery failed three cold checks;500ms spacing passed
those three but later missed a photo after resumption.
The wait alone is not acknowledgment. The reviewed candidate therefore holds
tool captions provisionally until normal native response completion and a
response-owned IMAGE token count above the pre-photo baseline. Only then may the
caption enter the journal's accepted-caption field, timeline or durable filing.
Preview rows can appear earlier without a green check. JPEG and PNG remain
native inputs. Caption content comes only from `save_photo_caption`,
never from a nearby answer or output transcription. Its `photo_caption` event
carries the original's `media_ref` and has no spoken-transcript status.

Use any IMAGE-count increase, not a fixed increment: the sequential test measured
266 then329, retained329 after resumed setup and stayed329 when a third photo
was missed. Fresh provider contexts start at zero; resumed contexts retain their
known count and pending baseline with the existing journal. A valid detail list
without IMAGE reports zero, as in the fresh-miss observations; missing or invalid
details remain unknown. Invalidating a resumption handle does not reset the
current context. Native response ownership, rather than merely sending a frame,
determines which photo may consume a usage sample.

One normally completed failed response permits an actual retry of the same
stored original and ID. Persist retryUsed when entering this retry phase; it is
not a frame-send limit. Interruption, speech deferral, reconnect/go-away replay
and aborted pre-send writes do not spend it. A second completed failure exposes
Retry/Discard. A rising count without a caption fails promptly; a completed
reply with unknown accounting can use its retry at the existing 30-second bound.
Stop retains its shorter drain. If speech starts during the500ms delay, defer
the task until the spoken answer finishes without spending the retry. Immediate
idle go-away rotation waits for the photo, but the existing deadline still wins.
No receipt or durable success is invented. Explicit Retry is separate from this
automatic allowance. Copies need no new deduplication guard. Internal photo
output is kept off playback/history without muting an adopted spoken request.
The implementation still needs provider acceptance; this is not a guarantee of
visual grounding or successful resend.

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

Normal Stop mutes provider output before callbacks and retains the socket/lease
for an eight-second caption handoff window. Continuous Stop flushes existing
audio with 1.8 seconds of real-time-paced silence and `audioStreamEnd`, then
waits for the preceding response's native completion before a new image
turn. `audioStreamEnd` alone cannot release that fence. The existing flush owner
can wait for replacement readiness within the same drain cap. Manual
Stop does not send an unsent take. Replay cannot deliver a task mid-flush or
after the drain closes. An already-delivered task is not resent merely
because Stop was pressed. Timeout is logged and retains recovery state. Optional
reflection follows both handoff and the caption's native completion, even if the
handoff preceded Stop. An unrelated failed photo does not suppress reflection.
Its text can settle at
`generationComplete` rather than waiting for delayed playback completion.

### Completion and connection rotation

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
  Sequenced rows remain immutable, including after a lost acknowledgment. Cold
  recovery closes old drafts before new-input admission; provider resumption
  does not close them. Drafts retain the expected sequence boundary, so a reset
  position archives them instead of mixing old speech into replacement history.
  Fresh cold-bootstrap context is still Slice 4 work.
- The journal writes payload version 3 with arrival-ordered `pendingImages` under
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
  dispatcher must remove the old sender and IMAGE-accounting gates in its slice;
  do not keep them as a fallback path.
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
