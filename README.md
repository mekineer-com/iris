# OpenAlma Mentra MiniApp

Iris is part of [OpenAlma](https://github.com/mekineer-com/OpenAlma). For project-wide questions and ideas, use [OpenAlma Discussions](https://github.com/mekineer-com/OpenAlma/discussions).

Nested at `mentra-os/miniapps/openalma/` for MentraOS development convenience. This is its own git repository (`mekineer-com/iris`), not part of MentraOS history.

After cloning MentraOS, add this path to the **parent** checkout’s local exclude (it does not survive a fresh MentraOS clone):

```
miniapps/openalma/
```

in `mentra-os/.git/info/exclude`.

The OpenAlma Mentra fork already commits `!miniapps/openalma` in its workspace list. An unmodified upstream MentraOS checkout may need that exclusion locally; do not send it upstream. Otherwise `bun install` here rewrites MentraOS `bun.lock` and links the in-tree SDK instead of the MiniApp's pinned npm dependency.

The MiniApp connects OpenAlma's authenticated Mentra bootstrap to Gemini Live native audio and sitting-scoped durable transcripts. Continuous mode uses provider VAD. Manual mode records one memory-only take, then waits for `Send` or `Redo`; `Done` never sends by itself. Persistent Iris-local switches independently mute microphone capture or disable camera actions without ending the sitting. Temporary transcript-sync failure remains visible and retries without ending voice; a provider turn missing usable transcript text records a non-conversational gap marker before failing loud. Graceful Stop may play and persist one short first-person reflection after two completed user turns.

Before changing the Gemini wire or diagnosing provider behavior, read
[`GEMINI_LIVE.md`](GEMINI_LIVE.md). It pins Iris's model-specific contract,
official sources, proven behavior, and local redacted fixtures.

Iris stores its OpenAlma connection profile and selected soul in phone-local
`session.storage`. With no profile it asks you to install Iris from the launcher
and makes no OpenAlma or Gemini request. Discovery checks the one shared OpenAlma
owner through the bearer-authenticated `/integration/mentra/owner` contract; a
saved profile whose user does not match that owner is kept for address repair,
but Soul selection and Start refuse the mismatched owner.
Existing soul suggestions come from authenticated
`GET /integration/mentra/souls?user_id=...`. Selection or creation uses `POST`
on the same route with `user_id`, `soul_id`, and `use_existing`. Only a 409
with `detail.reason: existing_exact` offers consent to reuse; sanitized-name
collisions remain errors. Start waits for local preferences and discovery.
A saved name missing from discovery requires explicit selection or creation.
Selection stays locked during a sitting and while its Gemini journal remains;
Start recovers that journal's original soul, then Stop completes finalization.
The bottom gear opens existing settings. **Edit Connection** preserves the
installation identity and selected Soul; its Save is locked during a sitting or
settings work, but allows address-only repair with pending recovery data intact.
The owner and installation ID are read-only. There is no
Clear Connection/reset path.

While a sitting is active, **Take photo** and **Choose image** durably store a non-empty JPEG/PNG before sending it to Gemini. Immediate send is the default; optional preview provides Send/Retake. Files over 1 MB pause for a cost/latency warning that can be permanently dismissed. Gemini's spoken description is saved as the image caption only after its transcript is acknowledged.

The MiniApp ZIP is generic and contains no endpoint, credential, user, soul, or
phone identity. `.env.local` is used only by the private release wrapper for its
WireGuard bind and installation-completion poll; it is never compiled into Iris.

A failed Memorize or consolidation pauses new activity for that Soul. Start
reports launcher recovery; an active sitting learns the pause on its existing
heartbeat, stops new audio/photo sends and preserves manual takes. Already-paid
output can finish, and transcript saving, token renewal and Stop remain usable.
Stop skips a new reflection while paused. Retry belongs to the launcher; a later
healthy heartbeat permits input again. No offline input queue is created.

```
bun install
bun test
bun run build
```
