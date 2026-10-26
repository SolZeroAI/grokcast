// Raycast wiring: tokens in Raycast's encrypted OAuth store, the client ID and
// dictation and Talk to Grok settings from preferences, the dictation history in
// LocalStorage, the Swift microphone helper from the extension's assets, and macOS
// `afplay` for Grok's spoken replies.

import { spawn } from "node:child_process"
import { chmodSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { environment, getPreferenceValues, LocalStorage, OAuth } from "@raycast/api"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import {
  AudioPlayer,
  Conversation,
  PlaybackError,
  TalkPreferences,
  TalkSettings,
} from "./conversation.ts"
import {
  AfterDictation,
  DictationPreferences,
  DictationSettings,
  languageFromPreference,
} from "./dictation.ts"
import { DictationHistory } from "./history.ts"
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
import { LiveTranscriber, WsWebSocketConstructor } from "./live-transcriber.ts"
import { Transcriber } from "./transcriber.ts"
import { XaiClient } from "./xai.ts"
import { microphoneAccess, requestMicrophoneAccess } from "swift:../../recorder"

// Only the token store is used. Sign-in runs the device-code flow in `account.tsx`,
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

const Preferences = Schema.Struct({
  clientId: Schema.OptionFromOptionalKey(Schema.String),
  language: Schema.OptionFromOptionalKey(Schema.String),
  formatNumbers: Schema.OptionFromOptionalKey(Schema.Boolean),
  afterDictation: Schema.OptionFromOptionalKey(AfterDictation),
  keepHistory: Schema.OptionFromOptionalKey(Schema.Boolean),
  talkVoice: Schema.OptionFromOptionalKey(Schema.String),
  talkVoiceId: Schema.OptionFromOptionalKey(Schema.String),
  talkInstructions: Schema.OptionFromOptionalKey(Schema.String),
})

const preferences = () => Schema.decodeUnknownOption(Preferences)(getPreferenceValues())

export const RaycastClientId = Layer.sync(ClientId, () =>
  preferences().pipe(
    Option.flatMap((values) => values.clientId),
    Option.map((clientId) => clientId.trim()),
    Option.filter((clientId) => clientId !== ""),
    Option.getOrElse(() => DEFAULT_CLIENT_ID),
  ),
)

/** Defaults match the preferences in `package.json`. */
export const RaycastDictationPreferences = Layer.sync(DictationPreferences, () => {
  const values = preferences()
  const value = <A>(pick: (decoded: typeof Preferences.Type) => Option.Option<A>, fallback: A) =>
    values.pipe(
      Option.flatMap(pick),
      Option.getOrElse(() => fallback),
    )
  return new DictationSettings({
    language: languageFromPreference(value((decoded) => decoded.language, "en")),
    formatNumbers: value((decoded) => decoded.formatNumbers, true),
    afterDictation: value((decoded) => decoded.afterDictation, "paste"),
    keepHistory: value((decoded) => decoded.keepHistory, true),
  })
})

/** A preference with text in it. An empty one leaves the choice to xAI. */
const filled = (value: Option.Option<string>) =>
  Option.filter(
    Option.map(value, (text) => text.trim()),
    (text) => text !== "",
  )

/** Talk to Grok's preferences. A custom voice ID wins over the voice picked from the list. */
export const RaycastTalkPreferences = Layer.sync(TalkPreferences, () => {
  const values = preferences()
  const pick = (field: (decoded: typeof Preferences.Type) => Option.Option<string>) =>
    filled(Option.flatMap(values, field))
  return new TalkSettings({
    voice: Option.orElse(
      pick((decoded) => decoded.talkVoiceId),
      () =>
        Option.filter(
          pick((decoded) => decoded.talkVoice),
          (voice) => voice !== "default",
        ),
    ),
    instructions: pick((decoded) => decoded.talkInstructions),
  })
})

const storageCall = <A>(method: string, call: () => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: (cause) =>
      new KeyValueStore.KeyValueStoreError({
        method,
        message: "Could not use Raycast's local storage.",
        cause,
      }),
  })

/** Raycast's LocalStorage: encrypted, on this Mac, and only for this extension. */
export const RaycastKeyValueStore = Layer.sync(KeyValueStore.KeyValueStore, () =>
  KeyValueStore.makeStringOnly({
    get: (key) => storageCall("get", () => LocalStorage.getItem<string>(key)),
    set: (key, value) => storageCall("set", () => LocalStorage.setItem(key, value)),
    remove: (key) => storageCall("remove", () => LocalStorage.removeItem(key)),
    clear: storageCall("clear", () => LocalStorage.clear()),
    size: storageCall("size", () => LocalStorage.allItems()).pipe(
      Effect.map((items) => Object.keys(items).length),
    ),
  }),
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
        // Not stdin: Tinycast closes it at once.
        finish: () => {
          child.kill("SIGTERM")
        },
        kill: () => {
          child.kill("SIGKILL")
        },
      }
    },
  }),
)

const AFPLAY = "/usr/bin/afplay"

/** Each piece of Grok's reply is written here, then played. The next piece replaces it. */
const replyFile = () => join(environment.supportPath, "talk-reply.wav")

/**
 * Plays Grok's reply with macOS `afplay`, as a child of the command, so it stops
 * when the conversation does. Untested in Tinycast so far.
 */
export const RaycastAudioPlayer = Layer.succeed(
  AudioPlayer,
  AudioPlayer.of({
    play: Effect.fn("RaycastAudioPlayer.play")(function* (wav: Uint8Array<ArrayBuffer>) {
      const file = replyFile()
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(environment.supportPath, { recursive: true })
          await writeFile(file, wav)
        },
        catch: () => new PlaybackError({ message: "Could not save Grok's reply to play it." }),
      })
      yield* Effect.callback<void, PlaybackError>((resume) => {
        // No stdin: Tinycast does not give children a pipe.
        const child = spawn(AFPLAY, [file], { stdio: "ignore" })
        child.on("error", () =>
          resume(Effect.fail(new PlaybackError({ message: "Could not play Grok's reply." }))),
        )
        child.on("exit", () => resume(Effect.void))
        return Effect.sync(() => {
          child.kill("SIGTERM")
        })
      })
    }),
  }),
)

/** Every service but `Conversation`, which needs several of them. */
const GrokServices = Layer.mergeAll(
  Layer.mergeAll(Transcriber.layer, LiveTranscriber.layer).pipe(
    Layer.provideMerge(WsWebSocketConstructor),
    Layer.provideMerge(XaiClient.layer),
    Layer.provideMerge(GrokSession.layer),
    Layer.provideMerge(XaiEndpoints.layer),
    Layer.provideMerge(Layer.mergeAll(RaycastTokenStore, RaycastClientId)),
    Layer.provideMerge(FetchHttpClient.layer),
  ),
  Recorder.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(RaycastMicrophonePermission, RaycastRecorderLauncher)),
  ),
  DictationHistory.layer.pipe(Layer.provideMerge(RaycastKeyValueStore)),
  RaycastDictationPreferences,
  RaycastTalkPreferences,
)

/**
 * Everything a command needs: xAI as the signed-in user, speech-to-text (live and
 * in one request), spoken conversations, the microphone, and the dictation and
 * Talk to Grok preferences and the dictation history.
 */
export const GrokLive = Conversation.layer.pipe(
  Layer.provideMerge(RaycastAudioPlayer),
  Layer.provideMerge(GrokServices),
)

/** Runs command programs with `GrokLive`. Each command builds it once. */
export const GrokRuntime = ManagedRuntime.make(GrokLive)
