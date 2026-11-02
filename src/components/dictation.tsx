// The dictation views Dictate and every text field share: record while xAI transcribes
// live, show the text as it comes, and hand the finished dictation back. Text fields
// get a "Dictate" action that opens this view and adds the text to the field.

import { Action, ActionPanel, Color, Detail, Icon, useNavigation, type Image, type Keyboard } from "@raycast/api"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as R from "effect/Record"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { appendDictation, clockOf, Dictation, dictateSpeech, recentText } from "../lib/dictation.ts"
import { GrokRuntime, type GrokLive } from "../lib/grok.ts"
import { levelBar } from "../lib/recorder.ts"
import { SignInAction } from "./launch.tsx"

export type DictationState = Data.TaggedEnum<{
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
  Heard: { readonly dictation: Dictation }
  NoSpeech: {}
  Failed: { readonly message: string; readonly signIn: boolean }
}>

export const DictationState = Data.taggedEnum<DictationState>()

/** The services `GrokRuntime` provides. */
type GrokServices = Layer.Success<typeof GrokLive>

/** Steps in the side panel's level meter. Fewer steps mean fewer redraws. */
const METER_STEPS = 8

/** Dictate into the text field. Not used by any of Raycast's common shortcuts. */
export const DICTATE_SHORTCUT: Keyboard.Shortcut = { modifiers: ["cmd", "shift"], key: "d" }

/**
 * Record and transcribe until `stop` is called. `heard` runs on the finished
 * dictation before the state becomes `Heard`. `again` starts a new recording.
 * Leaving the view stops the recording and sends nothing.
 */
export function useDictation(heard: (dictation: Dictation) => Effect.Effect<void, never, GrokServices>) {
  const [state, setState] = useState<DictationState>(DictationState.Starting())
  const [attempt, setAttempt] = useState(0)
  const stopRef = useRef<() => void>(() => {})
  const heardRef = useRef(heard)
  useEffect(() => {
    heardRef.current = heard
  })

  useEffect(() => {
    const fiber = GrokRuntime.runFork(
      listen(setState, (stopNow) => {
        stopRef.current = stopNow
      }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.sync(() => setState(DictationState.NoSpeech())),
            onSome: (dictation) =>
              heardRef
                .current(dictation)
                .pipe(Effect.andThen(Effect.sync(() => setState(DictationState.Heard({ dictation }))))),
          }),
        ),
        Effect.catchTags({
          RecorderError: (error) =>
            Effect.sync(() => setState(DictationState.Failed({ message: error.message, signIn: false }))),
          TranscriptionError: (error) =>
            Effect.sync(() =>
              setState(
                DictationState.Failed({
                  message: error.message,
                  signIn: error.reason === "signIn",
                }),
              ),
            ),
        }),
      ),
    )

    return () => {
      GrokRuntime.runFork(Fiber.interrupt(fiber))
    }
  }, [attempt])

  return {
    state,
    stop: () => stopRef.current(),
    again: () => {
      setState(DictationState.Starting())
      setAttempt((count) => count + 1)
    },
  }
}

/**
 * The dictation view for every state but `Heard`, which `heard` draws. `stopTitle`
 * names the primary action while recording. `actions` go after the actions of the
 * no-speech and failed states; `history` shows the Dictation History shortcut there.
 */
export function DictationDetail({
  state,
  stop,
  again,
  stopTitle,
  heard,
  actions,
  history = false,
}: {
  readonly state: DictationState
  readonly stop: () => void
  readonly again: () => void
  readonly stopTitle: string
  readonly heard: (dictation: Dictation) => ReactNode
  readonly actions?: ReactNode
  readonly history?: boolean
}) {
  return DictationState.$match(state, {
    Starting: () => <Detail isLoading markdown="" metadata={<Status label="Starting the microphone" />} />,
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
            <Action title={stopTitle} icon={Icon.Stop} onAction={stop} />
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
    Heard: ({ dictation }) => heard(dictation),
    NoSpeech: () => (
      <Detail
        markdown="Nothing was transcribed. Check that the right microphone is selected in System Settings › Sound, then try again."
        metadata={<Status label="No speech was heard" icon={Icon.MicrophoneDisabled} history={history} />}
        actions={
          <ActionPanel>
            <Action
              title="Dictate Again"
              icon={Icon.Microphone}
              shortcut={{ modifiers: ["cmd"], key: "r" }}
              onAction={again}
            />
            {actions}
          </ActionPanel>
        }
      />
    ),
    Failed: ({ message, signIn }) => (
      <Detail
        markdown={message}
        metadata={
          <Status label="Dictation did not finish" icon={{ source: Icon.ExclamationMark, tintColor: Color.Red }} />
        }
        actions={
          <ActionPanel>
            {signIn ? <SignInAction /> : null}
            <Action title="Try Again" icon={Icon.ArrowClockwise} onAction={again} />
          </ActionPanel>
        }
      />
    ),
  })
}

/**
 * The side panel: the status first, then `children`, then the history shortcut when
 * `history` is set. Every state uses it, so the layout stays put.
 */
export function Status({
  label,
  icon = Icon.Microphone,
  history = false,
  children,
}: {
  readonly label: string
  readonly icon?: Image.ImageLike
  readonly history?: boolean
  readonly children?: ReactNode
}) {
  return (
    <Detail.Metadata>
      <Detail.Metadata.Label title="Status" text={label} icon={icon} />
      {children}
      {history ? <Detail.Metadata.Separator /> : null}
      {history ? <Detail.Metadata.Label title="Dictation History" text="⌘ Y" /> : null}
    </Detail.Metadata>
  )
}

/** Record until told to stop, and show each visible change through `show`. */
const listen = Effect.fn("listen")(function* (
  show: (state: DictationState) => void,
  onStop: (stop: () => void) => void,
) {
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

  const update = () => {
    const key = [
      view.finishing ? "finishing" : `${levelBar(view.level, METER_STEPS)} ${clockOf(view.seconds)}`,
      view.text,
      view.liveStopped,
    ].join("|")

    if (key === shown.key) return
    shown.key = key
    show(
      view.finishing
        ? DictationState.Finishing({ seconds: view.seconds, text: view.text })
        : DictationState.Recording({ ...view }),
    )
  }

  return yield* dictateSpeech(stopped, {
    audio: (seconds, level) => {
      view.seconds = seconds
      view.level = level
      update()
    },
    text: (text) => {
      view.text = text
      update()
    },
    liveStopped: () => {
      view.liveStopped = true
      update()
    },
    finishing: (seconds) => {
      view.seconds = seconds
      view.finishing = true
      update()
    },
  })
})

/**
 * Dictate, then hand the text to `onText` and go back to the form. Esc goes back
 * without changing the field.
 */
function DictateIntoField({ field, onText }: { readonly field: string; readonly onText: (text: string) => void }) {
  const { pop } = useNavigation()

  const { state, stop, again } = useDictation((dictation) =>
    Effect.sync(() => {
      onText(dictation.text)
      pop()
    }),
  )

  return (
    <DictationDetail
      state={state}
      stop={stop}
      again={again}
      stopTitle={`Stop and Add to ${field}`}
      heard={(dictation) => <Detail markdown={dictation.text} />}
    />
  )
}

/** Opens dictation for one text field, then adds what was said to it. */
export function DictateAction({ field, onText }: { readonly field: string; readonly onText: (text: string) => void }) {
  return (
    <Action.Push
      title={`Dictate ${field}`}
      icon={Icon.Microphone}
      shortcut={DICTATE_SHORTCUT}
      target={<DictateIntoField field={field} onText={onText} />}
    />
  )
}

/**
 * Controlled text fields that dictation can fill. `fields` maps each field's ID to
 * its title and starting text. `field(id)` gives the props for that text field. The
 * returned `action` dictates into the text field that last had focus, or into `main`
 * before any did.
 */
export function useDictatedFields<const Id extends string>(
  fields: {
    readonly [K in Id]: {
      readonly title: string
      readonly initial?: string
      /** Runs after each change, typed or dictated, such as to clear the field's error. */
      readonly onChange?: (value: string) => void
    }
  },
  main: NoInfer<Id>,
) {
  const [values, setValues] = useState<{ readonly [K in Id]: string }>(() =>
    R.map(fields, (field) => field.initial ?? ""),
  )

  const [target, setTarget] = useState<Id>(main)

  const set = (id: Id, value: string) => {
    setValues((current) => ({ ...current, [id]: value }))
    fields[id].onChange?.(value)
  }

  const field = (id: Id) => ({
    id,
    value: values[id],
    onChange: (value: string) => set(id, value),
    onFocus: () => setTarget(id),
  })

  const action = (
    <DictateAction field={fields[target].title} onText={(text) => set(target, appendDictation(values[target], text))} />
  )

  return { values, field, action }
}
