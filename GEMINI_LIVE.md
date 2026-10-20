# Gemini Live Provider Contract

Read this before changing `GeminiLiveController.ts` or diagnosing a Gemini
socket failure. This is the local contract for Iris, not a copy of all Gemini
documentation.

Documentation snapshots and fictional-provider observations: 2026-10-20.

Source migration in progress, 2026-10-20: MCP now returns `v1beta` and Iris
requires that constrained socket; token minting stays on `v1alpha/auth_tokens`.
The unsupported proactivity setting and its constraint-mask entry are removed.
These seams follow the Gemini 3.8 provider checks in `PLAN_iris_gemini38.md`.
No model/configuration cutover has occurred. Photo/tool plumbing and late-speech
reservations are implemented; requested-answer continuation is still incomplete.
The current source is not a release-ready migration.

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
replay each allow 120 seconds. Between spoken turns it sends these two messages:

```json
{
  "realtimeInput": {
    "video": {"data": "<base64>", "mimeType": "image/jpeg"}
  }
}
```

The second message is `realtimeInput.text`, containing `image_id: <id>` and
`PHOTO_CAPTION_INSTRUCTION`, the exact Marcos-approved wording. JPEG and PNG
remain native inputs. Caption content comes only from `save_photo_caption`,
never from a nearby answer or output transcription. Its `photo_caption` event
carries the original's `media_ref` and has no spoken-transcript status.

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
audio with 1.8 seconds of real-time-paced silence and `audioStreamEnd`; Manual
Stop does not send an unsent take. An already-delivered task is not resent merely
because Stop was pressed. Timeout is logged and retains recovery state. Optional
reflection follows handoff, outside that caption deadline; its text can settle at
`generationComplete` rather than waiting for delayed playback completion.

### Completion and connection rotation

- `serverContent.turnComplete: true` closes response generation, not input
  transcription ownership. Reserve spoken input at native activity start, or
  Manual Send; the Manual echo does not create another reservation.
- Preserve the existing normal save boundary when words are present at response
  completion. This is not proof of a native ASR final marker. If the response
  completes first, keep an unsequenced suffix in the existing journal through
  terminal Stop/recovery. Late fragments fill that reservation, not a later turn.
  Overlapping admissions combine the words with an explicit uncertain-timing,
  received-order label. No new timeout or reconstructed split is used.
- Only a ready prefix receives server sequences, after Unicode-safe splitting.
  Sequenced rows remain immutable, including after a lost acknowledgment. Cold
  recovery closes old drafts before new-input admission; provider resumption
  does not close them. Drafts retain the expected sequence boundary, so a reset
  position archives them instead of mixing old speech into replacement history.
  Fresh cold-bootstrap context is still Slice 4 work.
- The journal writes payload version 2 under the existing storage key and reads
  existing version 1 at the boundary. Older clients already archive unknown
  versions; they must not treat drafts as ignorable version-1 extension fields.
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
