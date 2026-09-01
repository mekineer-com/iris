# Gemini Live Provider Contract

Read this before changing `GeminiLiveController.ts` or diagnosing a Gemini
socket failure. This is the local contract for Iris, not a copy of all Gemini
documentation.

Last verified against Google's official documentation: 2026-08-31.

## Pinned Runtime

- Model: `gemini-2.5-flash-native-audio-preview-12-2025`
- API: `v1alpha`
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

### Deliberate image turn

Iris durably snapshots the image in OpenAlma before sending:

```json
{
  "clientContent": {
    "turns": [{
      "role": "user",
      "parts": [
        {"inlineData": {"data": "<base64>", "mimeType": "image/jpeg"}},
        {"text": "Describe this image."}
      ]
    }],
    "turnComplete": true
  }
}
```

Per the API reference, `clientContent` is appended to conversation history and
interrupts current model generation. `turnComplete: true` asks Gemini to begin
its response. Iris therefore waits for its existing turn boundary before this
send; it must not be treated as silent context injection.

### Completion and connection rotation

- `serverContent.turnComplete: true` closes the semantic turn.
- `serverContent.generationComplete: true` means generation has finished; it is
  not a replacement for `turnComplete` in Iris transcript finalization.
- `goAway.timeLeft` announces a provider disconnect deadline. Iris rotates
  before that deadline using the latest resumption handle. Without a handle,
  Iris ends the sitting rather than inventing continuity.
- A WebSocket close event has `code`, `reason`, and `wasClean`. Preserve those
  in diagnostics; a generic "Gemini connection closed" is not enough evidence
  to classify a provider rejection, lease expiry, or network loss.

## Behavior Proven On Gemini 2.5

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
