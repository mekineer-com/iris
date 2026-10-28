# OpenAlma Mentra MiniApp

Iris is part of [OpenAlma](https://github.com/mekineer-com/OpenAlma). For project-wide questions and ideas, use [OpenAlma Discussions](https://github.com/mekineer-com/OpenAlma/discussions).

## Get Started

Install Iris from the OpenAlma launcher and use a trusted private connection,
such as your VPN, to reach your OpenAlma computer. Devices allowed onto that
connection can access the Soul's Iris data.

Choose an existing Soul or create one, then choose **Audio** or **Video**. The
**Thinking** switch picks Gemini's extended-thinking voice model; it is saved
on your OpenAlma computer and can only change between calls. The selected Soul
stays fixed until the sitting and any pending recovery are finished. Connection
settings live on your phone; **Edit Connection** can repair the server address
without losing your selected Soul or installation identity.

## Voice and Photos

Talk continuously, or use manual mode: press **Talk**, then **Done**, then choose
**Send** or **Redo**. Done does not send it. Microphone and camera switches work
independently. A temporary transcript-sync failure retries without ending voice.
After at least two completed user turns, Stop may save a short reflection. The
**Closing thoughts** box shown during a call (on by default, remembered) decides
whether you hear it. Stop gives unfinished photo work and the reflection up to
30 seconds, shown as a countdown, or five minutes if you leave Iris meanwhile.

During a sitting, use **Take photo** or **Choose image** to show her a JPEG or
PNG. Photos larger than 800 pixels on their longest edge are shrunk on your
phone before upload; files chosen from your gallery stay untouched. With a
supporting host, Take photo also saves the original to your gallery (a
stream-resolution still during Video), even if the call ended while the camera
was open; in that case choose the photo again to send it in a new call. Other
hosts show a one-time warning; a gallery-save failure never prevents sending.
Photos send immediately unless you enable preview, which offers Send or
Retake. Uploads over 1 MB show a dismissible transfer-size warning. Expand
**Photo captions** to see the last five captions received while Iris is running,
in arrival order. A green check means memU accepted the caption for filing, not
that memory extraction has finished. Unchecked captions are unconfirmed previews
and may be wrong, including when the photo did not arrive. Spoken photo
descriptions remain separate.

Video uses the foreground phone camera as well as audio. In Video, Take photo
grabs a still from the current view; Audio keeps the normal phone-camera picker. Hiding Iris releases the
camera; returning resumes an active Video call. A provider reconnect keeps
the camera but pauses frame submission.

Under Settings, **Maximum memorized photos** limits photos she chooses to keep
from Video, not deliberate photos. Slider changes apply to the next call.

Unconfirmed uploads stay in phone recovery after Stop; Start Iris again to check
the saved photo. Once the server accepts a caption for filing, it owns that
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
bun run test:browser # Requires Chromium; CHROMIUM can name its executable.
bun run build
```
