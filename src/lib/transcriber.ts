// Speech-to-text with the xAI SDK, as the signed-in user. No Raycast imports, so
// tests run it under plain Node with a fake `fetch`.

import {
  APIConnectionError,
  APIError,
  APIStatusError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
  SpaceXAI,
  TimeoutError,
} from "@xai-official/sdk"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as P from "effect/Predicate"
import * as Schema from "effect/Schema"
import { SAMPLE_RATE } from "./recorder.ts"
import { GrokSession } from "./session.ts"

/**
 * The SDK will not start without an API key. `GrokSession.fetch` replaces the
 * authorization header with the signed-in user's token on every request.
 */
const UNUSED_API_KEY = "grokcast-uses-oauth"

/** How long one transcription request may take. */
const REQUEST_TIMEOUT = Duration.seconds(60)

/** Transcription failed. `reason` picks what the UI offers, `message` is for the user. */
export class TranscriptionError extends Schema.TaggedError<TranscriptionError>()(
  "TranscriptionError",
  {
    reason: Schema.Literals(["signIn", "plan", "usageLimit", "network", "failed"]),
    message: Schema.String,
  },
) {}

export class Transcript extends Schema.Class<Transcript>("Transcript")({
  text: Schema.String,
  /** Length of the audio in seconds, as xAI measured it. */
  seconds: Schema.Finite,
}) {}

export interface TranscribeOptions {
  /** A language code such as `en`. None lets xAI detect the language. */
  readonly language: Option.Option<string>
  /** Write spoken numbers, currencies, and units as digits. xAI needs a language for this. */
  readonly formatNumbers: boolean
}

const failed = (reason: TranscriptionError["reason"], message: string) =>
  new TranscriptionError({ reason, message })

/** The SDK threw or rejected. `cause` is what it threw. */
class XaiSdkError extends Schema.TaggedError<XaiSdkError>()("XaiSdkError", {
  cause: Schema.Defect(),
}) {}

const SessionFailure = Schema.Struct({ _tag: Schema.String, message: Schema.String })

/** The error `GrokSession.fetch` rejected with (such as `NotSignedInError`), inside the SDK's error. */
const sessionFailure = (error: XaiSdkError) =>
  Schema.decodeUnknownOption(SessionFailure)(
    APIError.is(error.cause) ? error.cause.cause : undefined,
  )

const toTranscriptionError = (error: XaiSdkError): TranscriptionError =>
  Option.match(sessionFailure(error), {
    onSome: (session) =>
      Match.value(session._tag).pipe(
        Match.when("NotSignedInError", () => failed("signIn", session.message)),
        Match.orElse(() => failed("failed", session.message)),
      ),
    onNone: () =>
      Match.value(error.cause).pipe(
        Match.when(Match.instanceOf(AuthenticationError), () =>
          failed("signIn", "xAI did not accept your sign-in. Run Sign in to Grok again."),
        ),
        Match.when(Match.instanceOf(PermissionDeniedError), () =>
          failed(
            "plan",
            "xAI refused speech-to-text for this account. Check that your Grok or X plan includes it.",
          ),
        ),
        Match.when(Match.instanceOf(RateLimitError), () =>
          failed("usageLimit", "You reached your Grok usage limit. Try again later."),
        ),
        Match.when(Match.instanceOf(TimeoutError), () =>
          failed("network", "xAI took too long to answer. Try again."),
        ),
        Match.when(Match.instanceOf(APIConnectionError), () =>
          failed("network", "Could not reach xAI. Check your internet connection."),
        ),
        Match.when(Match.instanceOf(APIStatusError), (status) =>
          failed("failed", `xAI could not transcribe the audio (status ${status.status}).`),
        ),
        Match.orElse(() => failed("failed", "xAI could not transcribe the audio.")),
      ),
  })

/** The lowest Node version the SDK's constructor accepts. */
const SDK_MIN_NODE = "22.13.0"

/** Tinycast's `process.versions`, where it sets `tinycast`. None in Raycast. */
const tinycastVersions = () =>
  Option.fromNullishOr(globalThis.process?.versions).pipe(
    Option.filter((versions) => P.hasProperty(versions, "tinycast")),
  )

const newClient = (fetch: GrokSession["Service"]["fetch"]) =>
  Effect.try({
    try: () => new SpaceXAI({ apiKey: UNUSED_API_KEY, fetch }),
    catch: (cause) => new XaiSdkError({ cause }),
  })

/**
 * Start the SDK client. Tinycast runs extensions in its own engine and reports Node
 * 22.0.0, which fails the SDK's Node 22.13 check in its constructor, though Tinycast
 * provides every web API the SDK uses. So in Tinycast only, the reported version is
 * raised while the constructor runs, then put back.
 */
const startClient = (fetch: GrokSession["Service"]["fetch"]) =>
  Option.match(tinycastVersions(), {
    onNone: () => newClient(fetch),
    onSome: (versions) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const reported = versions.node
          versions.node = SDK_MIN_NODE
          return reported
        }),
        () => newClient(fetch),
        (reported) =>
          Effect.sync(() => {
            versions.node = reported
          }),
      ),
  }).pipe(Effect.mapError(() => failed("failed", "The xAI SDK could not start in this app.")))

const makeTranscriber = Effect.fn("Transcriber.make")(function* () {
  const session = yield* GrokSession

  // Made on first use, so a host the SDK refuses to start in fails only here.
  const client = yield* Effect.cached(startClient(session.fetch))

  const transcribe = Effect.fn("Transcriber.transcribe")(function* (
    audio: Uint8Array<ArrayBuffer>,
    options: TranscribeOptions,
  ) {
    const xai = yield* client
    const language = Option.match(options.language, {
      onNone: () => ({}),
      onSome: (code) => ({ language: code, format: options.formatNumbers }),
    })
    const result = yield* Effect.tryPromise({
      try: (signal) =>
        xai.voice.transcribe(
          {
            file: new Blob([audio]),
            audio_format: "pcm",
            sample_rate: SAMPLE_RATE,
            ...language,
          },
          // A 429 here is usually the plan's usage limit, so say so at once instead of waiting.
          { signal, maxRetries: 0, timeout: Duration.toMillis(REQUEST_TIMEOUT) },
        ),
      catch: (cause) => new XaiSdkError({ cause }),
    }).pipe(Effect.mapError(toTranscriptionError))
    return new Transcript({ text: result.text.trim(), seconds: result.duration })
  })

  return Transcriber.of({ transcribe })
})

export class Transcriber extends Context.Service<
  Transcriber,
  {
    /** Transcribe mono 16 kHz signed 16-bit little-endian PCM. */
    readonly transcribe: (
      audio: Uint8Array<ArrayBuffer>,
      options: TranscribeOptions,
    ) => Effect.Effect<Transcript, TranscriptionError>
  }
>()("grokcast/Transcriber") {
  static readonly layer = Layer.effect(Transcriber, makeTranscriber())
}
