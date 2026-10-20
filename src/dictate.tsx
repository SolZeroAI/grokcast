import {
  Action,
  ActionPanel,
  Clipboard,
  closeMainWindow,
  Color,
  Detail,
  Icon,
  launchCommand,
  LaunchType,
  showHUD,
  type Image,
} from "@raycast/api"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { clockOf, DictationPreferences, dictateSpeech, recentText } from "./lib/dictation.ts"
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
  Done: {
    readonly text: string
    readonly seconds: number
    readonly delivered: "pasted" | "copied"
  }
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
    Starting: () => (
      <Detail isLoading markdown="" metadata={<Status label="Starting the microphone" />} />
    ),
    Recording: ({ seconds, level, text, liveStopped }) => (
      <Detail
        isLoading
        markdown={
          liveStopped
            ? "_Live text is not available. The text appears when you stop._"
            : text === ""
              ? "_Start speaking. The text appears here._"
              : recentText(text)
        }
        metadata={
          <Status label="Listening" icon={{ source: Icon.Microphone, tintColor: Color.Red }}>
            <Detail.Metadata.Label title="Level" text={levelBar(level, METER_STEPS)} />
            <Detail.Metadata.Label title="Length" text={clockOf(seconds)} />
            <Detail.Metadata.Separator />
            <Detail.Metadata.Label title="Cancel" text="Esc" />
          </Status>
        }
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
        markdown={recentText(text)}
        metadata={
          <Status label="Finishing" icon={Icon.Hourglass}>
            <Detail.Metadata.Label title="Length" text={clockOf(seconds)} />
          </Status>
        }
      />
    ),
    Done: ({ text, seconds, delivered }) => (
      <Detail
        markdown={text}
        metadata={
          <Status
            label={delivered === "pasted" ? "Pasted" : "Copied to the clipboard"}
            icon={{ source: Icon.CheckCircle, tintColor: Color.Green }}
          >
            <Detail.Metadata.Label title="Length" text={clockOf(seconds)} />
          </Status>
        }
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
        markdown="Nothing was transcribed. Check the microphone with **Test Microphone**, then try again."
        metadata={<Status label="No speech was heard" icon={Icon.MicrophoneDisabled} />}
        actions={<ActionPanel>{againAction}</ActionPanel>}
      />
    ),
    Failed: ({ message, signIn }) => (
      <Detail
        markdown={message}
        metadata={
          <Status
            label="Dictation did not finish"
            icon={{ source: Icon.ExclamationMark, tintColor: Color.Red }}
          />
        }
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

/** Steps in the side panel's level meter. Fewer steps mean fewer redraws. */
const METER_STEPS = 8

/** The side panel: the status first, then `children`. Every state uses it, so the layout stays put. */
function Status({
  label,
  icon = Icon.Microphone,
  children,
}: {
  readonly label: string
  readonly icon?: Image.ImageLike
  readonly children?: ReactNode
}) {
  return (
    <Detail.Metadata>
      <Detail.Metadata.Label title="Status" text={label} icon={icon} />
      {children}
    </Detail.Metadata>
  )
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
  // Render only when something visible changed. Audio chunks arrive many times a
  // second, and Tinycast redraws more slowly than Raycast.
  const shown = { key: "" }
  const show = () => {
    const key = [
      view.finishing
        ? "finishing"
        : `${levelBar(view.level, METER_STEPS)} ${clockOf(view.seconds)}`,
      view.text,
      view.liveStopped,
    ].join("|")
    if (key === shown.key) return
    shown.key = key
    setState(
      view.finishing
        ? State.Finishing({ seconds: view.seconds, text: view.text })
        : State.Recording({ ...view }),
    )
  }
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
  const { text, seconds } = transcript.value
  const delivered = yield* deliver(text, settings.afterDictation)
  setState(State.Done({ text, seconds, delivered }))
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
