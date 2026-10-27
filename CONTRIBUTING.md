# Contributing

Grokcast is a Raycast extension. It must also run in Tinycast. It follows the Shared Project DNA where a Raycast extension can.

## Toolchain

- **nub `0.9.6`** is the package manager tool. `packageManager` is set to npm (`nub pm use npm`) so the lockfile is `package-lock.json`. The Raycast Store runs `npm ci`, so it needs that file. nub reads and updates it in place. Do not run `npm install` on the lockfile as well; npm and nub format it differently.
- **Node `24.15.0`** for development and CI (`engines` is `>=24.15.0 <25`). An older Node 24 only gets a warning from npm, so `npm run dev` still works. At run time the extension uses the host's JavaScript runtime: Raycast runs Node 22, and Tinycast runs its own engine with a partial Node layer. Types are `@types/node` 22 to match the lower of the two.
- **TypeScript `7.0.2`**. TypeScript 7 does not load `@types` packages on its own, so `tsconfig.json` lists `"types": ["node"]`.
- **Effect `4.0.5`**. Write new code in idiomatic Effect v4: namespace imports (`import * as Effect from "effect/Effect"`), services as `Context.Service` classes provided by `Layer`, errors as `Schema.TaggedError`, functions as `Effect.fn("name")`, `Option` instead of `undefined`, `Match` instead of `switch`, `Redacted` for tokens, and `effect/http` `HttpClient` for requests. Commands run programs through `GrokRuntime` (a `ManagedRuntime`); nothing else calls `Effect.run*`.
- **Xcode 16.3 or later** (macOS only) for `ray build` and `ray develop`. They compile the Swift recorder in `recorder/` with Raycast's Swift tools ([`extensions-swift-tools`](https://github.com/raycast/extensions-swift-tools)), the same way the Raycast Store builds it. On Linux, `nub run check` stops at the build step; CI builds on a macOS runner.
- **oxlint `1.87.0`** and **oxfmt `0.72.0`**, with `anti-slop`, `anti-slop-effect`, and `@mpsuesser/oxlint-plugin-effect` rules as warnings. The Effect rule set matches the other SolZero repositories. `.prettierrc.json` matches the oxfmt settings, because the Raycast Store checks formatting with Prettier.

```sh
nub install --frozen-lockfile
nub run check     # typecheck, lint, format, test, ray build
nub run dev       # load the extension in Raycast
npx ray lint      # Raycast's manifest and icon checks
```

## Tests

Unit tests use Node's test runner (`node --import tsx --test`). They cover the code in `src/lib/`, which has no Raycast imports. Provide fakes as layers (see `tests/support.ts`: a fake `fetch`, an in-memory token store, and `TestClock`); do not mock modules. tester-army/e2e is not used: a Raycast extension has no web UI for it to drive. This is the same exception the DNA gives libraries.

Try each user-facing change in Raycast and in Tinycast before you merge it. Tinycast does not run real Node. Do not use `child_process.fork`, `worker_threads`, or other Node modules outside the common set (files, child processes, crypto, buffers, `fetch`, and the `ws` package).

## Microphone recorder

`recorder/` is a Swift package built by `ray build` into `assets/compiled_raycast_swift/recorder` (git-ignored). No compiled binary is committed.

- `microphoneAccess` and `requestMicrophoneAccess` are called through the generated `swift:` bindings. `src/swift.d.ts` declares them so `tsc` runs before a build.
- `record` streams audio, which the bindings cannot do, so `RecorderLauncher` starts the binary as `recorder record 16000 600` and reads stdout: mono, signed 16-bit little-endian PCM at 16 kHz.
- To stop, send SIGTERM. Do not use stdin: Tinycast closes it as soon as the process starts. The recorder also stops on SIGINT, when its parent process exits, and after the time limit (the last argument, in seconds). `Recorder` kills it if it has not exited 2 seconds after SIGTERM.
- macOS asks for microphone access for the host app (Raycast or Tinycast), not for the recorder. `Recorder.ensureAccess` shows the prompt the first time and fails with `RecorderError` (`reason: "denied"`) when access is off.

## xAI SDK

Requests to xAI go through `@xai-official/sdk` (pinned exactly). `XaiClient` in `src/lib/xai.ts` creates one `SpaceXAI` client on first use, and every feature shares it. `describeXaiError` turns an SDK failure into a reason and a message for the user, in the words of the feature that failed:

- The SDK will not start without an API key, so it gets a placeholder. `GrokSession.fetch` replaces the authorization header with the user's OAuth token on every request. Never pass a real API key.
- Tinycast reports Node 22.0.0 (and sets `process.versions.tinycast`), which fails the SDK's Node 22.13 check. In Tinycast only, `XaiClient` raises the reported version while the constructor runs, then puts it back.
- Tinycast's `Request` has no `clone()`, so `GrokSession.fetch` copies a request with `new Request(request)` there. Tinycast can send the same body twice; Node cannot, so Node still uses `clone()`.
- Speech-to-text sends raw PCM (`audio_format: "pcm"`, `sample_rate: 16000`) as one multipart request. A 429 is not retried, because on a subscription it usually means the usage limit.

## Live speech-to-text

The xAI SDK does not cover streaming speech-to-text, so `LiveTranscriber` in `src/lib/live-transcriber.ts` talks to `wss://api.x.ai/v1/stt` with Effect's `Socket`:

- Sockets come from the `ws` package (`WsWebSocketConstructor`), because it can send the `authorization` header. Raycast runs Node, and Tinycast supports `ws`.
- The URL sets `sample_rate=16000`, `encoding=pcm`, `interim_results=true`, `endpointing=400`, and the language when there is one. With a language, xAI writes numbers as digits.
- Wait for `transcript.created` before sending audio. Send PCM as binary frames, then the text frame `{"type":"audio.done"}`.
- `transcript.partial` events carry the piece of speech in progress. `is_final` marks a piece that will not change. `speech_final` ends an utterance, and its text restates the whole utterance. `transcript.done` has come back with empty text, so the text comes from the partials (`addPartial`, `textOf`).
- xAI drops the connection without a close frame (1006) after the last event. After `audio.done` was sent, any close ends the transcript normally. Before that, a close is a failure.
- `dictateSpeech` records into the live session and keeps the audio. When the live session fails, gives no text, or does not finish within 10 seconds after recording stops, it sends the whole recording with `Transcriber` instead.

## Read Aloud

- `Speaker` in `src/lib/speech.ts` calls `xai.voice.speak` for MP3 audio. It sends `voice_id` and `speed` only when the user picks them, so xAI's defaults apply otherwise, and `language` is `auto` unless the user picks one. xAI accepts up to 60,000 characters and speeds from 0.7 to 1.5. A 429 is not retried.
- `SpeechPlayer` in `src/lib/speech-player.ts` plays in the background and keeps the player's process ID in LocalStorage, so the next run can stop it. Before it stops a process, `AudioLauncher.isPlaying` checks that the ID still belongs to `afplay`.
- `RaycastAudioLauncher` writes the audio to `read-aloud.mp3` in the extension's support folder and plays it with `/usr/bin/afplay`, detached so it outlives the command. Stop it with SIGTERM.
- `read-aloud.tsx` is a no-view command. It reads its argument, then the selection, then the clipboard (`firstText`), and stops at the first with text.

## Images

`ImageGenerator` in `src/lib/images.ts` calls `images.generate`, or `images.edit` when there are source images:

- The request leaves out `model`, so xAI uses its current image model. The SDK types `model` as required, so the body has one type assertion with a `SAFETY` comment.
- It asks for `response_format: "b64_json"`, so the bytes arrive in the response and nothing is fetched from a second URL. A missing `mime_type` means JPEG, xAI's default.
- One source image goes in `image`, several in `images`. The SDK turns each `Blob` into a data URL. Grokcast allows 3 sources and 4 results per request.
- `ImageLibrary` in `src/lib/image-library.ts` writes the files through `ImageFiles` (the extension's support folder in Raycast) and keeps the list in the key-value store. It keeps 200 images and deletes the files of older ones.

## Video generation

`VideoGenerator` in `src/lib/video.ts` uses the SDK's `videos.generate`, `videos.edit`, `videos.extend`, and `videos.get`:

- Never set `model`. SDK 0.2.4's types require it, but the API uses xAI's default without it, so `withXaiDefaultModel` leaves it out (the one type assertion, with a SAFETY comment).
- Pictures and MP4s go as `Blob`s; the SDK sends them inline as data URLs.
- A job starts with a `request_id`. `follow` polls `videos.get` every 5 seconds with an Effect `Schedule` instead of the SDK's `wait`, so it reports xAI's `progress` and runs on `TestClock` in tests. After 10 minutes it fails with the request ID, and the UI offers **Check Again**.
- `pending` (also a 202 with no body) keeps polling. `done` without a URL, or with `respect_moderation: false`, means moderation blocked the video. `failed` passes on xAI's message. `expired` means the result is gone.
- The video URL is public and temporary. `download` fetches it with the Effect `HttpClient`, without the Grok token.

## Sign-in rules

- Never log or show a token. The only value that may reach the clipboard is the short device user code.
- Send the bearer token only to `x.ai` or its subdomains. `isXaiUrl()` checks discovery results.
- xAI rotates the refresh token on every refresh. Always save the new one, and refresh through `GrokSession.refresh`, which holds a semaphore so one refresh runs at a time.
- Only `invalid_grant` clears the sign-in. Keep it on network errors and 5xx responses.

## Releases

Tegami (`tegami` 1.5.0) owns versions, `VERSION`, and GitHub releases. `scripts/tegami.mts` is the config. Do not bump `package.json` or `VERSION` in a feature pull request. Add a changelog under `.tegami/` when users can see the change:

```md
---
packages:
  npm:grokcast:
    type: minor
---

## What changed

One paragraph.
```

When a pull request does not change the extension, add the `release:none` label and no `.tegami/` entry.

`.github/workflows/release.yml` runs after Validate passes on `master`. It needs the `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` secrets. It opens the `tegami/version-packages` pull request, and after that merges, `scripts/github-release.mts` creates the GitHub release and the `grokcast@x.y.z` tag. The extension is private and is not published to npm.

The Raycast Store submission (`nub run publish`) is a manual step after a release. It opens a pull request on `raycast/extensions`.
