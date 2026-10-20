# Contributing

Grok Voice is a Raycast extension. It must also run in Tinycast. It follows the Shared Project DNA where a Raycast extension can.

## Toolchain

- **nub `0.9.6`** is the package manager tool. `packageManager` is set to npm (`nub pm use npm`) so the lockfile is `package-lock.json`. The Raycast Store runs `npm ci`, so it needs that file. nub reads and updates it in place. Do not run `npm install` on the lockfile as well; npm and nub format it differently.
- **Node `24.15.0`** for development and CI (`engines` is `>=24.15.0 <25`). At run time the extension uses the host's JavaScript runtime: Raycast runs Node 22, and Tinycast runs its own engine with a partial Node layer. Types are `@types/node` 22 to match the lower of the two.
- **TypeScript `7.0.2`**. TypeScript 7 does not load `@types` packages on its own, so `tsconfig.json` lists `"types": ["node"]`.
- **oxlint `1.87.0`** and **oxfmt `0.72.0`**, with `anti-slop` rules as warnings. `.prettierrc.json` matches the oxfmt settings, because the Raycast Store checks formatting with Prettier.

```sh
nub install --frozen-lockfile
nub run check     # typecheck, lint, format, test, ray build
nub run dev       # load the extension in Raycast
npx ray lint      # Raycast's manifest and icon checks
```

## Tests

Unit tests use Node's test runner (`node --import tsx --test`). They cover the code in `src/lib/`, which has no Raycast imports. Pass fakes as arguments; do not mock modules. tester-army/e2e is not used: a Raycast extension has no web UI for it to drive. This is the same exception the DNA gives libraries.

Try each user-facing change in Raycast and in Tinycast before you merge it. Tinycast does not run real Node. Do not use `child_process.fork`, `worker_threads`, or other Node modules outside the common set (files, child processes, crypto, buffers, `fetch`, and the `ws` package).

## Sign-in rules

- Never log or show a token. The only value that may reach the clipboard is the short device user code.
- Send the bearer token only to `x.ai` or its subdomains. `isXaiUrl()` checks discovery results.
- xAI rotates the refresh token on every refresh. Always save the new one, and refresh through `GrokSession.refresh()` so one refresh runs at a time.
- Only `invalid_grant` clears the sign-in. Keep it on network errors and 5xx responses.

## Releases

Tegami (`tegami` 1.5.0) owns versions, `VERSION`, and GitHub releases. `scripts/tegami.mts` is the config. Do not bump `package.json` or `VERSION` in a feature pull request. Add a changelog under `.tegami/` when users can see the change:

```md
---
packages:
  npm:grok-voice:
    type: minor
---

## What changed

One paragraph.
```

When a pull request does not change the extension, add the `release:none` label and no `.tegami/` entry.

`.github/workflows/release.yml` runs after Validate passes on `master`. It needs the `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` secrets. It opens the `tegami/version-packages` pull request, and after that merges, `scripts/github-release.mts` creates the GitHub release and the `grok-voice@x.y.z` tag. The extension is private and is not published to npm.

The Raycast Store submission (`nub run publish`) is a manual step after a release. It opens a pull request on `raycast/extensions`.
