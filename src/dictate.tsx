import {
  Action,
  ActionPanel,
  Clipboard,
  closeMainWindow,
  Detail,
  Icon,
  launchCommand,
  LaunchType,
  showHUD,
} from "@raycast/api"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Match from "effect/Match"
import { useEffect, useRef, useState } from "react"
import {
  DictationPreferences,
  MIN_DICTATION_SECONDS,
  recordSpeech,
  transcribeSpeech,
} from "./lib/dictation.ts"
import { GrokRuntime } from "./lib/grok.ts"
import { levelBar } from "./lib/recorder.ts"

type State = Data.TaggedEnum<{
  Starting: {}
  Recording: { readonly seconds: number; readonly level: number }
  Transcribing: { readonly seconds: number }
  Done: { readonly text: string; readonly delivered: "pasted" | "copied" }
  NoSpeech: {}
  Failed: { readonly message: string; readonly signIn: boolean }
}>
const State = Data.taggedEnum<State>()

export default function Dictate() {
  const [state, setState] = useState<State>(State.Starting())
  const [attempt, setAttempt] = useState(0)
  const stopRef = useRef<() => void>(() => {})

  useEffect(() => {
    const fiber = GrokRuntime.runFork(
      dictate(setState, (stopNow) => {
        stopRef.current = stopNow
      }).pipe(
        Effect.catchTags({
          RecorderError: (error) =>
            Effect.sync(() => setState(State.Failed({ message: error.message, signIn: false }))),
          TranscriptionError: (error) =>
            Effect.sync(() =>
              setState(State.Failed({ message: error.message, signIn: error.reason === "signIn" })),
            ),
        }),
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

  const againAction = (
    <Action
      title="Dictate Again"
      icon={Icon.Microphone}
      shortcut={{ modifiers: ["cmd"], key: "r" }}
      onAction={again}
    />
  )

  return State.$match(state, {
    Starting: () => <Detail isLoading markdown="Starting the microphone…" />,
    Recording: ({ seconds, level }) => (
      <Detail
        isLoading
        markdown={[
          "# Listening",
          "",
          "Speak, then press **Return** to transcribe. Press **Esc** to cancel.",
          "",
          `\`${levelBar(level)}\` ${formatSeconds(seconds)}`,
        ].join("\n")}
        actions={
          <ActionPanel>
            <Action
              title="Stop and Transcribe"
              icon={Icon.Stop}
              onAction={() => stopRef.current()}
            />
          </ActionPanel>
        }
      />
    ),
    Transcribing: ({ seconds }) => (
      <Detail isLoading markdown={`# Transcribing\n\n${formatSeconds(seconds)} of audio`} />
    ),
    Done: ({ text, delivered }) => (
      <Detail
        markdown={[
          delivered === "pasted" ? "# Pasted" : "# Copied to the clipboard",
          "",
          quote(text),
        ].join("\n")}
        actions={
          <ActionPanel>
            <Action.Paste content={text} />
            <Action.CopyToClipboard content={text} />
            {againAction}
          </ActionPanel>
        }
      />
    ),
    NoSpeech: () => (
      <Detail
        markdown={[
          "# No speech was heard",
          "",
          "Nothing was transcribed. Check the microphone with **Test Microphone**, then try again.",
        ].join("\n")}
        actions={<ActionPanel>{againAction}</ActionPanel>}
      />
    ),
    Failed: ({ message, signIn }) => (
      <Detail
        markdown={["# Dictation did not finish", "", message].join("\n")}
        actions={
          <ActionPanel>
            {signIn ? (
              <Action
                title="Sign in to Grok"
                icon={Icon.Person}
                onAction={() =>
                  void launchCommand({ name: "sign-in", type: LaunchType.UserInitiated })
                }
              />
            ) : null}
            <Action title="Try Again" icon={Icon.ArrowClockwise} onAction={again} />
          </ActionPanel>
        }
      />
    ),
  })
}

const dictate = Effect.fn("dictate")(function* (
  setState: (state: State) => void,
  onStop: (stop: () => void) => void,
) {
  const settings = yield* DictationPreferences
  const stopped = Effect.callback<void>((resume) => {
    onStop(() => resume(Effect.void))
  })
  const recording = yield* recordSpeech(stopped, (seconds, level) =>
    setState(State.Recording({ seconds, level })),
  )
  if (recording.seconds < MIN_DICTATION_SECONDS) {
    setState(State.NoSpeech())
    return
  }
  setState(State.Transcribing({ seconds: recording.seconds }))
  const transcript = yield* transcribeSpeech(recording)
  if (transcript.text === "") {
    setState(State.NoSpeech())
    return
  }
  const delivered = yield* deliver(transcript.text, settings.afterDictation)
  setState(State.Done({ text: transcript.text, delivered }))
})

/**
 * Paste into the app that was in front before Raycast opened, or copy. A paste that
 * fails falls back to a copy, so the text is never lost.
 */
const deliver = (text: string, afterDictation: "paste" | "copy") =>
  Match.value(afterDictation).pipe(
    Match.when("paste", () =>
      Effect.tryPromise(async () => {
        await closeMainWindow()
        await Clipboard.paste(text)
      }).pipe(
        Effect.as("pasted" as const),
        Effect.catch(() => copy(text)),
      ),
    ),
    Match.orElse(() => copy(text)),
  )

const copy = (text: string) =>
  Effect.tryPromise(async () => {
    await Clipboard.copy(text)
    await showHUD("Copied the dictation")
  }).pipe(Effect.ignore, Effect.as("copied" as const))

const formatSeconds = (seconds: number): string =>
  seconds < 60
    ? `${seconds.toFixed(1)} s`
    : `${Math.floor(seconds / 60)} min ${Math.floor(seconds % 60)} s`

/** The text as a Markdown block quote. */
const quote = (text: string): string =>
  text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")
