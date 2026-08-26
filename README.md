# OpenAlma Mentra MiniApp

Nested at `mentra-os/miniapps/openalma/` for MentraOS development convenience. This is its own git repository (`mekineer-com/iris`), not part of MentraOS history.

After cloning MentraOS, add this path to the **parent** checkout’s local exclude (it does not survive a fresh MentraOS clone):

```
miniapps/openalma/
```

in `mentra-os/.git/info/exclude`.

MentraOS `package.json` lists `miniapps/*` as workspaces. Keep OpenAlma out of that glob with a local parent line `!miniapps/openalma` (do not push that MentraOS edit upstream). Otherwise `bun install` here rewrites MentraOS `bun.lock` and links the in-tree SDK instead of npm `0.3.0-dev.1`.

The MiniApp connects OpenAlma's authenticated Mentra bootstrap to Gemini Live native audio and sitting-scoped durable transcripts. Continuous mode uses provider VAD. Manual mode records one memory-only take, then waits for `Send` or `Redo`; `Done` never sends by itself. Temporary transcript-sync failure remains visible and retries without ending voice; contract rejection ends the sitting. Graceful Stop may play and persist one short first-person reflection after two completed user turns.

Create `.env.local` from `.env.example`. The dedicated bearer is bundled into the private MiniApp and only grants access over the private WireGuard route; the permanent Gemini key stays on the OpenAlma server.

```
bun install
bun test
bun run build
```
