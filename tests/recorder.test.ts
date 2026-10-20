import assert from "node:assert/strict"
import { describe, it } from "node:test"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import {
  durationOfBytes,
  exitFromCode,
  levelDbfs,
  MicrophonePermission,
  Recorder,
  RecorderExit,
  RecorderLauncher,
  type MicrophoneAccess,
  type RecorderEvents,
  type RecorderProcess,
} from "../src/lib/recorder.ts"

/** A stand-in for the Swift recorder process. */
class FakeRecorder {
  finished = false
  killed = false
  private readonly script: Array<(events: RecorderEvents) => void> = []

  /** `exitOnFinish` is false for a recorder that hangs when told to stop. */
  constructor(private readonly exitOnFinish = true) {}

  /** Queue audio chunks to send once the recorder starts. */
  speak(...chunks: ReadonlyArray<Uint8Array>) {
    this.script.push((events) => chunks.forEach(events.audio))
    return this
  }

  /** Queue an exit to report once the recorder starts. */
  exitWith(exit: RecorderExit) {
    this.script.push((events) => events.exit(exit))
    return this
  }

  /** Called by the fake launcher. The script plays on a later tick, like a real process. */
  start(events: RecorderEvents): RecorderProcess {
    setImmediate(() => this.script.forEach((step) => step(events)))
    return {
      finish: () => {
        this.finished = true
        if (this.exitOnFinish) setImmediate(() => events.exit(RecorderExit.Finished()))
      },
      kill: () => {
        this.killed = true
        events.exit(RecorderExit.Failed({ message: "killed" }))
      },
    }
  }
}

interface Setup {
  readonly access?: MicrophoneAccess
  readonly grant?: boolean
  readonly recorder?: FakeRecorder
}

function setup({ access = "authorized", grant = true, recorder = new FakeRecorder() }: Setup) {
  const started: Array<ReadonlyArray<string>> = []
  const calls = { requested: 0, started }
  const layer = Recorder.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(
          MicrophonePermission,
          MicrophonePermission.of({
            status: Effect.succeed(access),
            request: Effect.sync(() => {
              calls.requested += 1
              return grant
            }),
          }),
        ),
        Layer.succeed(
          RecorderLauncher,
          RecorderLauncher.of({
            start: (args, events) => {
              started.push(args)
              return recorder.start(events)
            },
          }),
        ),
      ),
    ),
    Layer.provideMerge(TestClock.layer()),
  )
  const run = <A, E>(program: Effect.Effect<A, E, Recorder | TestClock.TestClock>) =>
    Effect.runPromise(Effect.provide(program, layer))
  return { calls, recorder, run }
}

const record = Recorder.use((recorder) => Effect.succeed(recorder.record))
const collect = (take: number) =>
  Effect.flatMap(record, (audio) => Stream.runCollect(Stream.take(audio, take)))

const chunk = (...samples: ReadonlyArray<number>) => {
  const view = new DataView(new ArrayBuffer(samples.length * 2))
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true))
  return new Uint8Array(view.buffer)
}

describe("Recorder.record", () => {
  it("starts the recorder at 16 kHz with a time limit, streams its audio, and stops it when done", async () => {
    const audio = [chunk(1, 2), chunk(3, 4), chunk(5, 6)]
    const { calls, recorder, run } = setup({ recorder: new FakeRecorder().speak(...audio) })
    const collected = await run(collect(2))
    assert.deepEqual(collected, audio.slice(0, 2))
    assert.deepEqual(calls.started, [["record", "16000", "600"]])
    assert.equal(recorder.finished, true)
    assert.equal(recorder.killed, false)
  })

  it("ends the stream when the recorder exits normally", async () => {
    const recorder = new FakeRecorder().speak(chunk(1)).exitWith(RecorderExit.Finished())
    const { run } = setup({ recorder })
    assert.deepEqual(await run(collect(10)), [chunk(1)])
  })

  it("asks for access the first time and records when the user allows it", async () => {
    const { calls, run } = setup({
      access: "notDetermined",
      recorder: new FakeRecorder().speak(chunk(1)),
    })
    await run(collect(1))
    assert.equal(calls.requested, 1)
    assert.equal(calls.started.length, 1)
  })

  it("fails with a clear message when the user declines the prompt", async () => {
    const { calls, run } = setup({ access: "notDetermined", grant: false })
    const error = await run(Effect.flip(collect(1)))
    assert.equal(error.reason, "denied")
    assert.match(error.message, /Privacy & Security > Microphone/)
    assert.equal(calls.started.length, 0)
  })

  it("fails without starting the recorder when access is off", async () => {
    const { calls, run } = setup({ access: "denied" })
    const error = await run(Effect.flip(collect(1)))
    assert.equal(error.reason, "denied")
    assert.equal(calls.requested, 0)
    assert.equal(calls.started.length, 0)
  })

  it("reports what the recorder printed when it fails", async () => {
    const recorder = new FakeRecorder().exitWith(
      exitFromCode(Option.some(1), "No microphone is available.\n"),
    )
    const { run } = setup({ recorder })
    const error = await run(Effect.flip(collect(1)))
    assert.equal(error.reason, "failed")
    assert.equal(error.message, "No microphone is available.")
  })

  it("kills the recorder when it does not exit after it is told to stop", async () => {
    const recorder = new FakeRecorder(false).speak(chunk(1))
    const { run } = setup({ recorder })
    await run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(collect(1))
        yield* Effect.sleep("10 millis").pipe(TestClock.withLive)
        assert.equal(recorder.finished, true)
        assert.equal(recorder.killed, false)
        yield* TestClock.adjust("2 seconds")
        yield* Fiber.join(fiber)
      }),
    )
    assert.equal(recorder.killed, true)
  })
})

describe("exitFromCode", () => {
  it("treats code 0 as finished and anything else as failed", () => {
    assert.deepEqual(exitFromCode(Option.some(0), ""), RecorderExit.Finished())
    assert.deepEqual(
      exitFromCode(Option.none(), ""),
      RecorderExit.Failed({ message: "The microphone recorder stopped." }),
    )
  })
})

describe("levelDbfs", () => {
  it("is about 0 dBFS at full scale and about -6 dBFS at half scale", () => {
    assert.ok(Math.abs(levelDbfs(chunk(32767, -32768, 32767, -32768))) < 0.01)
    assert.ok(Math.abs(levelDbfs(chunk(16384, -16384)) + 6.02) < 0.01)
  })

  it("is -Infinity for silence and for an empty chunk", () => {
    assert.equal(levelDbfs(chunk(0, 0, 0)), Number.NEGATIVE_INFINITY)
    assert.equal(levelDbfs(new Uint8Array(0)), Number.NEGATIVE_INFINITY)
  })
})

describe("durationOfBytes", () => {
  it("counts 32,000 bytes as one second of 16 kHz 16-bit mono audio", () => {
    assert.equal(durationOfBytes(32_000), 1)
  })
})
