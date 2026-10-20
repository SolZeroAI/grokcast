// Dictation: record until told to stop while xAI transcribes live, then keep the
// text in the history. When live transcription stops, the whole recording is sent
// instead. No Raycast imports, so tests run it under plain Node.

import * as Arr from "effect/Array"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { DictationHistory } from "./history.ts"
import { LiveTranscriber } from "./live-transcriber.ts"
import { durationOfBytes, levelDbfs, Recorder } from "./recorder.ts"
import { Transcriber, Transcript } from "./transcriber.ts"

/** Recording stops on its own after this long and is transcribed. */
export const MAX_DICTATION = Duration.minutes(5)

/** A recording shorter than this is not sent to xAI. */
export const MIN_DICTATION_SECONDS = 0.3

/** After recording stops, how long to wait for the live text before sending the whole recording. */
export const LIVE_FINISH_TIMEOUT = Duration.seconds(10)

export const AfterDictation = Schema.Literals(["paste", "copy"])
export type AfterDictation = typeof AfterDictation.Type

export class DictationSettings extends Schema.Class<DictationSettings>("DictationSettings")({
  /** A language code such as `en`. None lets xAI detect the language. */
  language: Schema.Option(Schema.String),
  /** Write spoken numbers, currencies, and units as digits. Needs a language. */
  formatNumbers: Schema.Boolean,
  /** Paste the text into the frontmost app, or only copy it. */
  afterDictation: AfterDictation,
  keepHistory: Schema.Boolean,
}) {}

/** The user's dictation preferences. */
export class DictationPreferences extends Context.Service<
  DictationPreferences,
  DictationSettings
>()("grokcast/DictationPreferences") {}

export interface Recording {
  /** Mono 16 kHz signed 16-bit little-endian PCM. */
  readonly audio: Uint8Array<ArrayBuffer>
  readonly seconds: number
}

/** One buffer with the bytes of all `chunks`, in order. */
export const joinChunks = (chunks: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> => {
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  chunks.reduce((offset, chunk) => {
    joined.set(chunk, offset)
    return offset + chunk.byteLength
  }, 0)
  return joined
}

/**
 * Record until `stop` completes or `MAX_DICTATION` passes. `onAudio` gets the
 * seconds recorded so far, the level of each chunk for a meter, and the chunk.
 */
export const recordSpeech = Effect.fn("recordSpeech")(function* (
  stop: Effect.Effect<void>,
  onAudio: (seconds: number, level: number, chunk: Uint8Array) => void,
) {
  const recorder = yield* Recorder
  const recorded = yield* recorder.record.pipe(
    Stream.interruptWhen(Effect.raceFirst(stop, Effect.sleep(MAX_DICTATION))),
    Stream.runFold(
      () => ({ chunks: Arr.empty<Uint8Array>(), bytes: 0 }),
      (total, chunk) => {
        const bytes = total.bytes + chunk.byteLength
        onAudio(durationOfBytes(bytes), levelDbfs(chunk), chunk)
        return { chunks: Arr.append(total.chunks, chunk), bytes }
      },
    ),
  )
  return {
    audio: joinChunks(recorded.chunks),
    seconds: durationOfBytes(recorded.bytes),
  } satisfies Recording
})

/** Transcribe a whole recording with the user's preferences, in one request. */
export const transcribeRecording = Effect.fn("transcribeRecording")(function* (
  recording: Recording,
) {
  const settings = yield* DictationPreferences
  const transcriber = yield* Transcriber
  return yield* transcriber.transcribe(recording.audio, {
    language: settings.language,
    formatNumbers: settings.formatNumbers,
  })
})

/** What `dictateSpeech` reports while it runs. */
export interface DictationProgress {
  /** Seconds recorded so far and the level of the last chunk, for a meter. */
  readonly audio: (seconds: number, level: number) => void
  /** Everything heard so far. */
  readonly text: (text: string) => void
  /** Live text stopped. The text comes after recording stops. */
  readonly liveStopped: () => void
  /** Recording stopped after `seconds`, and the text is being finished. */
  readonly finishing: (seconds: number) => void
}

/**
 * Record until `stop` completes and transcribe live while the user speaks. When live
 * transcription stops, or gives no text, the whole recording is sent in one request.
 * Non-empty text goes into the history when the user keeps one; a history that
 * cannot be saved does not fail this. None means no speech was heard.
 */
export const dictateSpeech = Effect.fn("dictateSpeech")(function* (
  stop: Effect.Effect<void>,
  progress: DictationProgress,
) {
  const settings = yield* DictationPreferences
  const live = yield* LiveTranscriber
  const audio = yield* Queue.unbounded<Uint8Array, Cause.Done>()
  const liveText = yield* Effect.forkChild(
    live.transcribe(Stream.fromQueue(audio), settings.language, progress.text).pipe(
      Effect.tapError(() => Effect.sync(progress.liveStopped)),
      Effect.option,
    ),
  )
  const recording = yield* recordSpeech(stop, (seconds, level, chunk) => {
    Queue.offerUnsafe(audio, chunk)
    progress.audio(seconds, level)
  }).pipe(Effect.ensuring(Queue.end(audio)))
  if (recording.seconds < MIN_DICTATION_SECONDS) return Option.none<Transcript>()
  progress.finishing(recording.seconds)

  const heard = yield* Fiber.join(liveText).pipe(
    Effect.timeoutOption(LIVE_FINISH_TIMEOUT),
    Effect.map((text) => Option.filter(Option.flatten(text), (words) => words !== "")),
  )
  const transcript = yield* Option.match(heard, {
    onSome: (text) => Effect.succeed(new Transcript({ text, seconds: recording.seconds })),
    onNone: () => transcribeRecording(recording),
  })
  if (transcript.text === "") return Option.none<Transcript>()
  if (settings.keepHistory) {
    yield* DictationHistory.use((history) => history.add(transcript.text, recording.seconds)).pipe(
      Effect.ignore,
    )
  }
  return Option.some(transcript)
})

/** The language to send, from a preference value where `auto` means detect it. */
export const languageFromPreference = (value: string): Option.Option<string> =>
  Option.filter(Option.some(value.trim()), (code) => code !== "" && code !== "auto")
