// Raycast wiring: tokens in Raycast's encrypted OAuth store, the client ID from
// preferences, and the Swift microphone helper from the extension's assets.

import { spawn } from "node:child_process"
import { chmodSync } from "node:fs"
import { join } from "node:path"
import { environment, getPreferenceValues, OAuth } from "@raycast/api"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { ClientId, DEFAULT_CLIENT_ID, XaiEndpoints } from "./oauth.ts"
import {
  exitFromCode,
  MicrophoneAccess,
  MicrophonePermission,
  Recorder,
  RecorderError,
  RecorderExit,
  RecorderLauncher,
} from "./recorder.ts"
import { GrokSession, StoredTokens, TokenStore, TokenStoreError } from "./session.ts"
import { microphoneAccess, requestMicrophoneAccess } from "swift:../../recorder"

// Only the token store is used. Sign-in runs the device-code flow in `sign-in.tsx`,
// not `authorize()`, so the redirect method is never exercised.
const client = new OAuth.PKCEClient({
  redirectMethod: OAuth.RedirectMethod.Web,
  providerName: "Grok",
  providerIcon: "extension-icon.png",
  description: "Sign in with your Grok or X subscription.",
})

const storeCall = <A>(message: string, call: () => Promise<A>) =>
  Effect.tryPromise({ try: call, catch: (cause) => new TokenStoreError({ message, cause }) })

const fromRaycast = (tokens: OAuth.TokenSet): Option.Option<StoredTokens> =>
  Option.map(
    Option.liftPredicate(tokens.accessToken, (token) => token !== ""),
    (accessToken) =>
      new StoredTokens({
        accessToken: Redacted.make(accessToken),
        refreshToken: Option.map(Option.fromNullishOr(tokens.refreshToken), Redacted.make),
        idToken: Option.map(Option.fromNullishOr(tokens.idToken), Redacted.make),
        expiresAt: tokens.updatedAt.getTime() + (tokens.expiresIn ?? 0) * 1000,
      }),
  )

const unredact = (token: Option.Option<Redacted.Redacted<string>>) =>
  Option.getOrUndefined(Option.map(token, Redacted.value))

export const RaycastTokenStore = Layer.succeed(
  TokenStore,
  TokenStore.of({
    load: storeCall("Could not read the Grok sign-in.", () => client.getTokens()).pipe(
      Effect.map((tokens) => Option.flatMap(Option.fromNullishOr(tokens), fromRaycast)),
    ),
    save: (tokens) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        storeCall("Could not save the Grok sign-in.", () =>
          client.setTokens({
            access_token: Redacted.value(tokens.accessToken),
            refresh_token: unredact(tokens.refreshToken),
            id_token: unredact(tokens.idToken),
            expires_in: Math.max(0, Math.round((tokens.expiresAt - now) / 1000)),
          }),
        ),
      ),
    clear: storeCall("Could not remove the Grok sign-in.", () => client.removeTokens()),
  }),
)

const Preferences = Schema.Struct({ clientId: Schema.OptionFromOptionalKey(Schema.String) })

export const RaycastClientId = Layer.sync(ClientId, () =>
  Schema.decodeUnknownOption(Preferences)(getPreferenceValues()).pipe(
    Option.flatMap((preferences) => preferences.clientId),
    Option.map((clientId) => clientId.trim()),
    Option.filter((clientId) => clientId !== ""),
    Option.getOrElse(() => DEFAULT_CLIENT_ID),
  ),
)

const helperCall = <A>(call: () => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: () =>
      new RecorderError({ reason: "failed", message: "Could not check microphone access." }),
  })

export const RaycastMicrophonePermission = Layer.succeed(
  MicrophonePermission,
  MicrophonePermission.of({
    status: helperCall(microphoneAccess).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(MicrophoneAccess)),
      Effect.mapError(
        () =>
          new RecorderError({ reason: "failed", message: "Could not check microphone access." }),
      ),
    ),
    request: helperCall(requestMicrophoneAccess),
  }),
)

/** `ray build` compiles `recorder/` to this path in the extension's assets. */
const recorderBinary = () => join(environment.assetsPath, "compiled_raycast_swift", "recorder")

export const RaycastRecorderLauncher = Layer.succeed(
  RecorderLauncher,
  RecorderLauncher.of({
    start: (args, events) => {
      const binary = recorderBinary()
      // An installed extension's assets can lose the executable bit.
      chmodSync(binary, 0o755)
      const child = spawn(binary, [...args], { stdio: ["pipe", "pipe", "pipe"] })
      const stderr: Array<string> = []
      child.stdout.on("data", (chunk: Buffer) => events.audio(chunk))
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")))
      child.on("error", () =>
        events.exit(RecorderExit.Failed({ message: "Could not start the microphone recorder." })),
      )
      child.on("exit", (code) =>
        events.exit(exitFromCode(Option.fromNullishOr(code), stderr.join(""))),
      )
      return {
        finish: () => child.stdin.end(),
        kill: () => {
          child.kill("SIGKILL")
        },
      }
    },
  }),
)

/** Everything a command needs: xAI as the signed-in user, and the microphone. */
export const GrokLive = Layer.mergeAll(
  GrokSession.layer.pipe(
    Layer.provideMerge(XaiEndpoints.layer),
    Layer.provideMerge(Layer.mergeAll(RaycastTokenStore, RaycastClientId)),
    Layer.provideMerge(FetchHttpClient.layer),
  ),
  Recorder.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(RaycastMicrophonePermission, RaycastRecorderLauncher)),
  ),
)

/** Runs command programs with `GrokLive`. Each command builds it once. */
export const GrokRuntime = ManagedRuntime.make(GrokLive)
