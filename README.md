# OpenAlma Mentra MiniApp

Iris is part of [OpenAlma](https://github.com/mekineer-com/OpenAlma). For project-wide questions and ideas, use [OpenAlma Discussions](https://github.com/mekineer-com/OpenAlma/discussions).

## Get Started

Install Iris from the OpenAlma launcher and use a trusted private connection,
such as your VPN, to reach your OpenAlma computer. Devices allowed onto that
connection can access the Soul's Iris data.

Choose an existing Soul or create one, then press **Start**. The selected Soul
stays fixed until the sitting and any pending recovery are finished. Connection
settings live on your phone; **Edit Connection** can repair the server address
without losing your selected Soul or installation identity.

## Voice and Photos

Talk continuously, or use manual mode: record a take, press **Done**, then choose
**Send** or **Redo**. Done does not send it. Microphone and camera switches work
independently. A temporary transcript-sync failure retries without ending voice.
After at least two completed user turns, Stop may play and save a short reflection.

During a sitting, use **Take photo** or **Choose image** to show her a JPEG or
PNG. Photos send immediately unless you enable preview, which offers Send or
Retake. Files over 1 MB show a dismissible cost and latency warning. Expand
**Photo captions** to see the last five captions received while Iris is running,
in arrival order. A green check means memU accepted the caption for filing, not
that memory extraction has finished. Spoken photo descriptions remain separate.

Unconfirmed uploads stay in phone recovery after Stop; Start Iris again to check
the saved original. Once the server accepts a caption for filing, it owns that
work. Failed server filings can be retried or discarded while Iris is idle,
including after reopening the app. Discard does not delete the original image.

## Memory Processing

If Memorize or consolidation fails, Iris pauses new input and directs you to
**Retry** in the OpenAlma launcher. Transcript saving and Stop remain available;
unfinished manual takes are kept. Input resumes when processing is healthy.

## Development

See [AGENTS.md](AGENTS.md) for checkout, build and implementation guidance.

```sh
bun install
bun test
bun run build
```
