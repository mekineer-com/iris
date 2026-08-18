# OpenAlma Mentra MiniApp

Nested at `mentra-os/miniapps/openalma/` for MentraOS development convenience. This is its own git repository, not part of MentraOS history.

After cloning MentraOS, add this path to the **parent** checkout’s local exclude (it does not survive a fresh MentraOS clone):

```
miniapps/openalma/
```

in `mentra-os/.git/info/exclude`.

Slice 2 is a Start/Stop shell with mock loopback audio. No Gemini or mcp yet.

```
bun install
bun test
bun run build
```
