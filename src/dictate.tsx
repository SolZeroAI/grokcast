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
import * as Option from "effect/Option"
import { useEffect, useRef, useState } from "react"
import { DictationPreferences, dictateSpeech } from "./lib/dictation.ts"
import { GrokRuntime } from "./lib/grok.ts"
import { levelBar } from "./lib/recorder.ts"

type State = Data.TaggedEnum<{
  Starting: {}
  Recording: {
    readonly seconds: number
    readonly level: number
    /** Everything heard so far. */
    readonly text: string
    /** Live text stopped; the text comes after recording stops. */
    readonly liveStopped: boolean
  }
  Finishing: { readonly seconds: number; readonly text: string }
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
    Recording: ({ seconds, level, text, liveStopped }) => (
      <Detail
        isLoading
        markdown={[
          "# Listening",
          "",
          `\`${levelBar(level)}\` ${formatSeconds(seconds)}`,
          "",
          liveStopped
            ? "_Live text is not available. The text appears when you stop._"
            : text === ""
              ? "_Start speaking. The text appears here._"
              : quote(text),
          "",
          "Press **Return** to stop and transcribe. Press **Esc** to cancel.",
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
    Finishing: ({ seconds, text }) => (
      <Detail
        isLoading
        markdown={[
          "# Finishing",
          "",
          text === "" ? `${formatSeconds(seconds)} of audio` : quote(text),
        ].join("\n")}
      />
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
  // Audio and text arrive separately; each update shows both. The last words can
  // arrive after recording stops.
  const view = {
    seconds: 0,
    level: Number.NEGATIVE_INFINITY,
    text: "",
    liveStopped: false,
    finishing: false,
  }
  const show = () =>
    setState(
      view.finishing
        ? State.Finishing({ seconds: view.seconds, text: view.text })
        : State.Recording({ ...view }),
    )
  const transcript = yield* dictateSpeech(stopped, {
    audio: (seconds, level) => {
      view.seconds = seconds
      view.level = level
      show()
    },
    text: (text) => {
      view.text = text
      show()
    },
    liveStopped: () => {
      view.liveStopped = true
      show()
    },
    finishing: (seconds) => {
      view.seconds = seconds
      view.finishing = true
      show()
    },
  })
  if (Option.isNone(transcript)) {
    setState(State.NoSpeech())
    return
  }
  const text = transcript.value.text
  const delivered = yield* deliver(text, settings.afterDictation)
  setState(State.Done({ text, delivered }))
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
