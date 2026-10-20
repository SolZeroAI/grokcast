import assert from "node:assert/strict"
import { describe, it } from "node:test"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as TestClock from "effect/testing/TestClock"
import {
  DictationPreferences,
  DictationSettings,
  joinChunks,
  languageFromPreference,
  recordSpeech,
  transcribeSpeech,
} from "../src/lib/dictation.ts"
import { DictationHistory } from "../src/lib/history.ts"
import { Transcriber, Transcript, type TranscribeOptions } from "../src/lib/transcriber.ts"
import { chunk, FakeRecorder, fakeRecorderLayer } from "./fake-recorder.ts"

const settings = (keepHistory: boolean) =>
  new DictationSettings({
    language: Option.some("en"),
    formatNumbers: true,
    afterDictation: "paste",
    keepHistory,
  })

/** A transcriber that answers `text` and records what it was asked. */
const fakeTranscriber = (text: string) => {
  const calls: Array<{ bytes: number; options: TranscribeOptions }> = []
  const layer = Layer.succeed(
    Transcriber,
    Transcriber.of({
      transcribe: (audio, options) =>
        Effect.sync(() => {
          calls.push({ bytes: audio.byteLength, options })
          return new Transcript({ text, seconds: 1 })
        }),
    }),
  )
  return { calls, layer }
}

describe("joinChunks", () => {
  it("joins the chunks in order", () => {
    assert.deepEqual(
      joinChunks([new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3])]),
      new Uint8Array([1, 2, 3]),
    )
  })
})

describe("languageFromPreference", () => {
  it("treats auto and an empty value as detect automatically", () => {
    assert.deepEqual(languageFromPreference("en"), Option.some("en"))
    assert.deepEqual(languageFromPreference("auto"), Option.none())
    assert.deepEqual(languageFromPreference(" "), Option.none())
  })
})

describe("recordSpeech", () => {
  it("records until told to stop and returns the audio with its length", async () => {
    const recorder = new FakeRecorder().speak(chunk(1, 2), chunk(3, 4))
    const levels: Array<number> = []
    const recording = await Effect.runPromise(
      Effect.gen(function* () {
        const stop = yield* Deferred.make<void>()
        const heard = yield* Deferred.make<void>()
        const fiber = yield* Effect.forkChild(
          recordSpeech(Deferred.await(stop), (seconds) => {
            levels.push(seconds)
            if (levels.length === 2) Deferred.doneUnsafe(heard, Effect.void)
          }),
        )
        yield* Deferred.await(heard)
        yield* Deferred.succeed(stop, undefined)
        return yield* Fiber.join(fiber)
      }).pipe(
        Effect.provide(fakeRecorderLayer(recorder).pipe(Layer.provideMerge(TestClock.layer()))),
      ),
    )
    assert.deepEqual(recording.audio, chunk(1, 2, 3, 4))
    assert.equal(recording.seconds, 8 / 32_000)
    assert.deepEqual(levels, [4 / 32_000, 8 / 32_000])
    assert.equal(recorder.finished, true)
  })

  it("stops on its own after five minutes", async () => {
    const recorder = new FakeRecorder().speak(chunk(1))
    const recording = await Effect.runPromise(
      Effect.gen(function* () {
        const heard = yield* Deferred.make<void>()
        const fiber = yield* Effect.forkChild(
          recordSpeech(Effect.never, () => Deferred.doneUnsafe(heard, Effect.void)),
        )
        yield* Deferred.await(heard)
        yield* TestClock.adjust("5 minutes")
        return yield* Fiber.join(fiber)
      }).pipe(
        Effect.provide(fakeRecorderLayer(recorder).pipe(Layer.provideMerge(TestClock.layer()))),
      ),
    )
    assert.deepEqual(recording.audio, chunk(1))
    assert.equal(recorder.finished, true)
  })
})

describe("transcribeSpeech", () => {
  const run = (keepHistory: boolean, text: string) => {
    const transcriber = fakeTranscriber(text)
    const layer = Layer.mergeAll(
      transcriber.layer,
      Layer.succeed(DictationPreferences, settings(keepHistory)),
      DictationHistory.layer.pipe(Layer.provideMerge(KeyValueStore.layerMemory)),
    )
    const result = Effect.runPromise(
      transcribeSpeech({ audio: new Uint8Array(64), seconds: 2 }).pipe(
        Effect.flatMap((transcript) =>
          DictationHistory.use((history) => history.list).pipe(
            Effect.map((entries) => ({ transcript, entries })),
          ),
        ),
        Effect.provide(layer),
      ),
    )
    return { calls: transcriber.calls, result }
  }

  it("transcribes with the preferences and keeps the text in the history", async () => {
    const { calls, result } = run(true, "Hello there.")
    const { transcript, entries } = await result
    assert.equal(transcript.text, "Hello there.")
    assert.deepEqual(calls, [
      { bytes: 64, options: { language: Option.some("en"), formatNumbers: true } },
    ])
    assert.deepEqual(
      entries.map((entry) => [entry.text, entry.seconds]),
      [["Hello there.", 2]],
    )
  })

  it("keeps nothing when the history is off or nothing was said", async () => {
    assert.deepEqual((await run(false, "Hello there.").result).entries, [])
    assert.deepEqual((await run(true, "").result).entries, [])
  })
})
