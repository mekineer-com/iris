# OpenAlma Iris

Keep README.md for people installing and using Iris. Durable implementation
constraints belong here or in the existing Gemini contract, not in work logs.

## Checkout and Build

Nested at `mentra-os/miniapps/openalma/` for MentraOS development convenience. This is its own git repository (`mekineer-com/iris`), not part of MentraOS history.

After cloning MentraOS, add this path to the **parent** checkout’s local exclude (it does not survive a fresh MentraOS clone):

```
miniapps/openalma/
```

in `mentra-os/.git/info/exclude`.

The OpenAlma Mentra fork already commits `!miniapps/openalma` in its workspace list. An unmodified upstream MentraOS checkout may need that exclusion locally; do not send it upstream. Otherwise `bun install` here rewrites MentraOS `bun.lock` and links the in-tree SDK instead of the MiniApp's pinned npm dependency.

Source is in `src/`; build/release tooling is in `scripts/` and `build.ts`.
Use `bun test`, `bun run typecheck`, and `bun run build` as appropriate.
The MiniApp has its own version and release artifacts, separate from the host APK.

## Sitting and Recovery Contracts

A completed provider turn missing required transcript text records a
non-conversational gap marker before failing; do not silently drop the turn.

Before changing the Gemini wire or diagnosing provider behavior, read
[`GEMINI_LIVE.md`](GEMINI_LIVE.md). It pins Iris's model-specific contract,
official sources, proven behavior, and local redacted fixtures.

Soul Presence is fixed at Start: narrative self, both identity anchors, the flat
**My Categories** list, and recent conversations. Working thoughts and intentions
stay live instead: Gemini can read their current state, save a working thought,
and complete or let go of an intention through server tools. Lost write results
are uncertain; Iris never automatically repeats those writes. Connection renewal
keeps the original entry context.

Invalid tool arguments are answered without ending voice or running part of a
rejected batch. A shortened working thought is reported as truncated. Authentication
and expired-sitting failures still end the session. Server-request deadlines cover
response bodies as well as headers; interrupted transcript sync retains the phone
backup. Stop abandons waits from interrupted playback before playing a reflection.

Iris stores its OpenAlma connection profile and selected soul in phone-local
`session.storage`. With no profile it asks you to install Iris from the launcher
and makes no OpenAlma or Gemini request. Discovery checks the one shared OpenAlma
owner through the private-network `/integration/mentra/owner` contract; a
saved profile whose user does not match that owner is kept for address repair,
but Soul selection and Start refuse the mismatched owner.
Existing soul suggestions come from
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

If the phone's conversation backup cannot match the server, Iris keeps its exact
original in phone-local **Recovered Chats** (`openalma:recovered-chats`) before
starting fresh. Original line numbers and photo references are retained there,
not automatically replayed or memorized. If the backup cannot be read or copied,
its old key stays untouched and Iris starts a fresh numbered backup. Both readers
use the newest key; an empty marker after Stop prevents older backups resurfacing.
Backup trouble never blocks Start. If phone storage itself is unavailable, server
transcript saving stays enabled with a visible local-backup warning.

The MiniApp ZIP is generic and contains no endpoint, credential, user, soul, or
phone identity. `.env.local` is used only by the private release wrapper for its
explicit address bind and installation-completion poll; it is never compiled into Iris.

Photos must be stored before sending to Gemini. Save captions only after the
spoken transcript is acknowledged. Pending photo recovery survives Stop; stale
button results cannot mutate a later sitting.

A Soul's processing pause blocks new input, not transcript saving, token renewal
or Stop. Keep unfinished manual takes; Retry belongs to the launcher. Do not
invent an offline input queue.
