// Raycast wiring: tokens in Raycast's encrypted OAuth store, the client ID and
// dictation settings from preferences, the dictation history in LocalStorage, and
// the Swift microphone helper from the extension's assets.

import { spawn } from "node:child_process"
import { chmodSync } from "node:fs"
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
import { Chat, ChatPreferences, ChatSettings, ChatTool, ReasoningEffort } from "./chat.ts"
import { ChatConversations } from "./conversations.ts"
import { ChatImages } from "./images.ts"
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

const ChatPreferenceValues = Schema.Struct({
  chatModel: Schema.OptionFromOptionalKey(Schema.String),
  reasoningEffort: Schema.OptionFromOptionalKey(Schema.String),
  chatInstructions: Schema.OptionFromOptionalKey(Schema.String),
  webSearch: Schema.OptionFromOptionalKey(Schema.Boolean),
  xSearch: Schema.OptionFromOptionalKey(Schema.Boolean),
  codeExecution: Schema.OptionFromOptionalKey(Schema.Boolean),
})

const filled = (text: Option.Option<string>) =>
  text.pipe(
    Option.map((value) => value.trim()),
    Option.filter((value) => value !== ""),
  )

/** Grok Chat's command preferences. Defaults match `package.json`. */
export const RaycastChatPreferences = Layer.sync(ChatPreferences, () => {
  const values = Schema.decodeUnknownOption(ChatPreferenceValues)(getPreferenceValues())
  const pick = <A>(f: (decoded: typeof ChatPreferenceValues.Type) => Option.Option<A>) =>
    Option.flatMap(values, f)
  const on = (tool: ChatTool, enabled: Option.Option<boolean>, fallback: boolean) =>
    Option.getOrElse(enabled, () => fallback) ? [tool] : []
  return new ChatSettings({
    model: filled(pick((decoded) => decoded.chatModel)),
    reasoningEffort: pick((decoded) => decoded.reasoningEffort).pipe(
      Option.flatMap(Schema.decodeUnknownOption(ReasoningEffort)),
    ),
    instructions: filled(pick((decoded) => decoded.chatInstructions)),
    tools: [
      ...on(
        "webSearch",
        pick((decoded) => decoded.webSearch),
        true,
      ),
      ...on(
        "xSearch",
        pick((decoded) => decoded.xSearch),
        true,
      ),
      ...on(
        "codeExecution",
        pick((decoded) => decoded.codeExecution),
        false,
      ),
    ],
  })
})

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

/**
 * Everything a command needs: xAI as the signed-in user, speech-to-text (live and
 * in one request), chat, the microphone, and the preferences and saved history.
 */
export const GrokLive = Layer.mergeAll(
  Layer.mergeAll(Transcriber.layer, LiveTranscriber.layer, Chat.layer).pipe(
    Layer.provideMerge(WsWebSocketConstructor),
    Layer.provideMerge(XaiClient.layer),
    Layer.provideMerge(ChatImages.layer),
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
  ChatConversations.layer.pipe(Layer.provideMerge(RaycastKeyValueStore)),
  RaycastChatPreferences,
)

/** Runs command programs with `GrokLive`. Each command builds it once. */
export const GrokRuntime = ManagedRuntime.make(GrokLive)
