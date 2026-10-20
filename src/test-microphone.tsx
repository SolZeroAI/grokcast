import { Action, ActionPanel, Detail, Icon } from "@raycast/api"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Match from "effect/Match"
import * as Stream from "effect/Stream"
import { useEffect, useRef, useState } from "react"
import { GrokRuntime } from "./lib/grok.ts"
import { durationOfBytes, levelDbfs, Recorder } from "./lib/recorder.ts"

/** The test stops on its own after this long. */
const MAX_DURATION = Duration.seconds(5)

/** A peak below this level means only silence came through. */
const SILENCE_DBFS = -50

type State = Data.TaggedEnum<{
  Starting: {}
  Recording: { readonly seconds: number; readonly level: number }
  Done: { readonly seconds: number; readonly peak: number }
  Failed: { readonly message: string }
}>
const State = Data.taggedEnum<State>()

export default function TestMicrophone() {
  const [state, setState] = useState<State>(State.Starting())
  const [attempt, setAttempt] = useState(0)
  const stopRef = useRef<() => void>(() => {})

  useEffect(() => {
    const fiber = GrokRuntime.runFork(
      testMicrophone(setState, (stopNow) => {
        stopRef.current = stopNow
      }).pipe(
        Effect.catchTag("RecorderError", (error) =>
          Effect.sync(() => setState(State.Failed({ message: error.message }))),
        ),
      ),
    )
    return () => {
      GrokRuntime.runFork(Fiber.interrupt(fiber))
    }
  }, [attempt])

  const again = () => {
    setState(State.Starting())
    setAttempt((count) => count + 1)
  }

  return State.$match(state, {
    Starting: () => <Detail isLoading markdown="Starting the microphone…" />,
    Recording: ({ seconds, level }) => (
      <Detail
        isLoading
        markdown={[
          "# Listening",
          "",
          "Say a few words. The test stops after 5 seconds.",
          "",
          `\`${meter(level)}\` ${seconds.toFixed(1)} s`,
        ].join("\n")}
        actions={
          <ActionPanel>
            <Action title="Stop" icon={Icon.Stop} onAction={() => stopRef.current()} />
          </ActionPanel>
        }
      />
    ),
    Done: ({ seconds, peak }) => (
      <Detail
        markdown={[
          peak > SILENCE_DBFS ? "# The microphone works" : "# Only silence came through",
          "",
          `Recorded ${seconds.toFixed(1)} s. The loudest moment was ${formatDb(peak)}.`,
          ...(peak > SILENCE_DBFS
            ? []
            : ["", "Check the input device in System Settings > Sound > Input, then try again."]),
        ].join("\n")}
        actions={
          <ActionPanel>
            <Action title="Test Again" icon={Icon.ArrowClockwise} onAction={again} />
          </ActionPanel>
        }
      />
    ),
    Failed: ({ message }) => (
      <Detail
        markdown={["# The microphone is not available", "", message].join("\n")}
        actions={
          <ActionPanel>
            <Action title="Try Again" icon={Icon.ArrowClockwise} onAction={again} />
          </ActionPanel>
        }
      />
    ),
  })
}

const testMicrophone = Effect.fn("testMicrophone")(function* (
  setState: (state: State) => void,
  onStop: (stop: () => void) => void,
) {
  const recorder = yield* Recorder
  const stopped = Effect.callback<void>((resume) => {
    onStop(() => resume(Effect.void))
  })
  const totals = yield* recorder.record.pipe(
    Stream.interruptWhen(Effect.raceFirst(Effect.sleep(MAX_DURATION), stopped)),
    Stream.runFold(
      () => ({ bytes: 0, peak: Number.NEGATIVE_INFINITY }),
      (total, chunk) => {
        const level = levelDbfs(chunk)
        const next = { bytes: total.bytes + chunk.byteLength, peak: Math.max(total.peak, level) }
        setState(State.Recording({ seconds: durationOfBytes(next.bytes), level }))
        return next
      },
    ),
  )
  setState(State.Done({ seconds: durationOfBytes(totals.bytes), peak: totals.peak }))
})

/** A 20-step bar for a level between -60 dBFS and 0 dBFS. */
const meter = (level: number): string => {
  const filled = Math.round(Math.min(1, Math.max(0, (level + 60) / 60)) * 20)
  return "█".repeat(filled) + "░".repeat(20 - filled)
}

const formatDb = (level: number): string =>
  Match.value(Number.isFinite(level)).pipe(
    Match.when(true, () => `${level.toFixed(0)} dBFS`),
    Match.orElse(() => "silence"),
  )
