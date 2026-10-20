// Dictation: record until told to stop, then transcribe with xAI and keep the text
// in the history. No Raycast imports, so tests run it under plain Node.

import * as Arr from "effect/Array"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { DictationHistory } from "./history.ts"
import { durationOfBytes, levelDbfs, Recorder } from "./recorder.ts"
import { Transcriber } from "./transcriber.ts"

/** Recording stops on its own after this long and is transcribed. */
export const MAX_DICTATION = Duration.minutes(5)

/** A recording shorter than this is not sent to xAI. */
export const MIN_DICTATION_SECONDS = 0.3

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
 * seconds recorded so far and the level of each chunk, for a meter.
 */
export const recordSpeech = Effect.fn("recordSpeech")(function* (
  stop: Effect.Effect<void>,
  onAudio: (seconds: number, level: number) => void,
) {
  const recorder = yield* Recorder
  const recorded = yield* recorder.record.pipe(
    Stream.interruptWhen(Effect.raceFirst(stop, Effect.sleep(MAX_DICTATION))),
    Stream.runFold(
      () => ({ chunks: Arr.empty<Uint8Array>(), bytes: 0 }),
      (total, chunk) => {
        const bytes = total.bytes + chunk.byteLength
        onAudio(durationOfBytes(bytes), levelDbfs(chunk))
        return { chunks: Arr.append(total.chunks, chunk), bytes }
      },
    ),
  )
  return {
    audio: joinChunks(recorded.chunks),
    seconds: durationOfBytes(recorded.bytes),
  } satisfies Recording
})

/**
 * Transcribe a recording with the user's preferences. Non-empty text goes into the
 * history when the user keeps one; a history that cannot be saved does not fail this.
 */
export const transcribeSpeech = Effect.fn("transcribeSpeech")(function* (recording: Recording) {
  const settings = yield* DictationPreferences
  const transcriber = yield* Transcriber
  const transcript = yield* transcriber.transcribe(recording.audio, {
    language: settings.language,
    formatNumbers: settings.formatNumbers,
  })
  if (settings.keepHistory && transcript.text !== "") {
    yield* DictationHistory.use((history) => history.add(transcript.text, recording.seconds)).pipe(
      Effect.ignore,
    )
  }
  return transcript
})

/** The language to send, from a preference value where `auto` means detect it. */
export const languageFromPreference = (value: string): Option.Option<string> =>
  Option.filter(Option.some(value.trim()), (code) => code !== "" && code !== "auto")
