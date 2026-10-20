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

Requests to xAI go through `@xai-official/sdk` (pinned exactly). `Transcriber` in `src/lib/transcriber.ts` creates the `SpaceXAI` client on first use:

- The SDK will not start without an API key, so it gets a placeholder. `GrokSession.fetch` replaces the authorization header with the user's OAuth token on every request. Never pass a real API key.
- Tinycast reports Node 22.0.0 (and sets `process.versions.tinycast`), which fails the SDK's Node 22.13 check. In Tinycast only, `Transcriber` raises the reported version while the constructor runs, then puts it back.
- Tinycast's `Request` has no `clone()`, so `GrokSession.fetch` copies a request with `new Request(request)` there. Tinycast can send the same body twice; Node cannot, so Node still uses `clone()`.
- Speech-to-text sends raw PCM (`audio_format: "pcm"`, `sample_rate: 16000`) as one multipart request. A 429 is not retried, because on a subscription it usually means the usage limit.

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
