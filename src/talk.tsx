import {
  Action,
  ActionPanel,
  Color,
  Detail,
  Icon,
  launchCommand,
  LaunchType,
  type Image,
} from "@raycast/api"
import * as Arr from "effect/Array"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import { useEffect, useRef, useState, type ReactNode } from "react"
import {
  ConversationLog,
  Conversation,
  TalkPreferences,
  transcriptOf,
  type TalkPhase,
} from "./lib/conversation.ts"
import { clockOf, recentText } from "./lib/dictation.ts"
import { GrokRuntime } from "./lib/grok.ts"
import { levelBar } from "./lib/recorder.ts"

type State = Data.TaggedEnum<{
  Talking: {
    readonly phase: TalkPhase
    readonly seconds: number
    readonly level: number
    readonly log: ConversationLog
    readonly notice: Option.Option<string>
  }
  Ended: { readonly log: ConversationLog; readonly seconds: number }
  Failed: { readonly message: string; readonly signIn: boolean; readonly log: ConversationLog }
}>
const State = Data.taggedEnum<State>()

const starting = State.Talking({
  phase: "connecting",
  seconds: 0,
  level: Number.NEGATIVE_INFINITY,
  log: ConversationLog.empty,
  notice: Option.none(),
})

export default function Talk() {
  const [state, setState] = useState<State>(starting)
  const [attempt, setAttempt] = useState(0)
  const [voice, setVoice] = useState("xAI Default")
  const stopRef = useRef<() => void>(() => {})
  const interruptRef = useRef<() => void>(() => {})

  useEffect(() => {
    const fiber = GrokRuntime.runFork(
      talk(
        setState,
        setVoice,
        (stopNow) => {
          stopRef.current = stopNow
        },
        (interrupt) => {
          interruptRef.current = interrupt
        },
      ).pipe(
        // `talk` already shows the failure, with what was said before it.
        Effect.catchTag("ConversationError", () => Effect.void),
      ),
    )
    return () => {
      GrokRuntime.runFork(Fiber.interrupt(fiber))
    }
  }, [attempt])

  const again = () => {
    setState(starting)
    setAttempt((count) => count + 1)
  }

  const copyAction = (log: ConversationLog) =>
    transcriptOf(log) === "" ? null : (
      <Action.CopyToClipboard
        title="Copy Transcript"
        content={transcriptOf(log)}
        shortcut={{ modifiers: ["cmd"], key: "c" }}
      />
    )

  const againAction = (
    <Action
      title="Talk Again"
      icon={Icon.Microphone}
      shortcut={{ modifiers: ["cmd"], key: "r" }}
      onAction={again}
    />
  )

  return State.$match(state, {
    Talking: ({ phase, seconds, level, log, notice }) => (
      <Detail
        isLoading={phase === "connecting" || phase === "thinking"}
        markdown={markdownOf(log, phase)}
        metadata={
          <Status label={phaseLabel(phase)} icon={phaseIcon(phase)}>
            <Detail.Metadata.Label title="Voice" text={voice} />
            <Detail.Metadata.Label title="Level" text={levelBar(level, METER_STEPS)} />
            <Detail.Metadata.Label title="Length" text={clockOf(seconds)} />
            {Option.match(notice, {
              onNone: () => null,
              onSome: (message) => <Detail.Metadata.Label title="Note" text={message} />,
            })}
            <Detail.Metadata.Separator />
            <Detail.Metadata.Label title="Cancel" text="Esc" />
          </Status>
        }
        actions={
          <ActionPanel>
            <Action title="End Conversation" icon={Icon.Stop} onAction={() => stopRef.current()} />
            <Action
              title="Interrupt Grok"
              icon={Icon.SpeakerOff}
              shortcut={{ modifiers: ["cmd"], key: "." }}
              onAction={() => interruptRef.current()}
            />
            {copyAction(log)}
          </ActionPanel>
        }
      />
    ),
    Ended: ({ log, seconds }) => (
      <Detail
        markdown={transcriptMarkdown(log) || "_Nothing was said._"}
        metadata={
          <Status
            label="Conversation ended"
            icon={{ source: Icon.CheckCircle, tintColor: Color.Green }}
          >
            <Detail.Metadata.Label title="Voice" text={voice} />
            <Detail.Metadata.Label title="Length" text={clockOf(seconds)} />
            <Detail.Metadata.Label title="Turns" text={String(spokenTurns(log).length)} />
          </Status>
        }
        actions={
          <ActionPanel>
            {copyAction(log)}
            {againAction}
          </ActionPanel>
        }
      />
    ),
    Failed: ({ message, signIn, log }) => (
      <Detail
        markdown={[message, "", transcriptMarkdown(log)].join("\n")}
        metadata={
          <Status
            label="The conversation stopped"
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
                  void launchCommand({
                    name: "account",
                    type: LaunchType.UserInitiated,
                    context: { signIn: true },
                  })
                }
              />
            ) : null}
            <Action title="Try Again" icon={Icon.ArrowClockwise} onAction={again} />
            {copyAction(log)}
          </ActionPanel>
        }
      />
    ),
  })
}

/** Steps in the side panel's level meter. Fewer steps mean fewer redraws. */
const METER_STEPS = 8

/** While talking, show at most this many of the latest turns. */
const SHOWN_TURNS = 6

const phaseLabel = (phase: TalkPhase) =>
  Match.value(phase).pipe(
    Match.when("connecting", () => "Connecting"),
    Match.when("listening", () => "Listening"),
    Match.when("thinking", () => "Thinking"),
    Match.when("speaking", () => "Grok is speaking"),
    Match.exhaustive,
  )

const phaseIcon = (phase: TalkPhase): Image.ImageLike =>
  Match.value(phase).pipe(
    Match.when("connecting", () => Icon.Globe),
    Match.when("listening", () => ({ source: Icon.Microphone, tintColor: Color.Red })),
    Match.when("thinking", () => Icon.Hourglass),
    Match.when("speaking", () => ({ source: Icon.SpeakerOn, tintColor: Color.Blue })),
    Match.exhaustive,
  )

const spokenTurns = (log: ConversationLog) =>
  Arr.filter(log.turns, (turn) => turn.text.trim() !== "")

/** Each turn as a paragraph with the speaker in bold. */
const turnsMarkdown = (log: ConversationLog, shorten: boolean) =>
  spokenTurns(log)
    .map(
      (turn) =>
        `**${turn.speaker === "you" ? "You" : "Grok"}:** ${shorten ? recentText(turn.text.trim()) : turn.text.trim()}`,
    )
    .join("\n\n")

const transcriptMarkdown = (log: ConversationLog) => turnsMarkdown(log, false)

/** The latest turns, kept short so each redraw stays small. */
const markdownOf = (log: ConversationLog, phase: TalkPhase) => {
  const recent = new ConversationLog({ turns: Arr.takeRight(spokenTurns(log), SHOWN_TURNS) })
  return recent.turns.length > 0
    ? turnsMarkdown(recent, true)
    : phase === "connecting"
      ? "_Connecting to Grok…_"
      : "_Start speaking. Grok answers when you pause._"
}

/** The side panel: the status first, then `children`. Every state uses it, so the layout stays put. */
function Status({
  label,
  icon,
  children,
}: {
  readonly label: string
  readonly icon: Image.ImageLike
  readonly children?: ReactNode
}) {
  return (
    <Detail.Metadata>
      <Detail.Metadata.Label title="Status" text={label} icon={icon} />
      {children}
    </Detail.Metadata>
  )
}

/** What the conversation shows. Audio, phase, and words arrive separately; each update shows all of them. */
interface TalkView {
  phase: TalkPhase
  seconds: number
  level: number
  log: ConversationLog
  notice: Option.Option<string>
}

const talk = Effect.fn("talk")(function* (
  setState: (state: State) => void,
  setVoice: (voice: string) => void,
  onStop: (stop: () => void) => void,
  onInterrupt: (interrupt: () => void) => void,
) {
  const settings = yield* TalkPreferences
  setVoice(
    Option.match(settings.voice, {
      onNone: () => "xAI Default",
      onSome: (id) => id.charAt(0).toUpperCase() + id.slice(1),
    }),
  )
  const stopped = Effect.callback<void>((resume) => {
    onStop(() => resume(Effect.void))
  })
  const view: TalkView = {
    phase: "connecting",
    seconds: 0,
    level: Number.NEGATIVE_INFINITY,
    log: ConversationLog.empty,
    notice: Option.none<string>(),
  }
  // Render only when something visible changed. Audio chunks arrive many times a
  // second, and Tinycast redraws more slowly than Raycast.
  const shown = { key: "" }
  const show = () => {
    const key = [
      view.phase,
      levelBar(view.level, METER_STEPS),
      clockOf(view.seconds),
      markdownOf(view.log, view.phase),
      Option.getOrElse(view.notice, () => ""),
    ].join("|")
    if (key === shown.key) return
    shown.key = key
    setState(State.Talking({ ...view }))
  }
  const log = yield* Conversation.use((conversation) =>
    conversation.talk(
      stopped,
      settings,
      {
        audio: (seconds, level) => {
          view.seconds = seconds
          view.level = level
          show()
        },
        phase: (phase) => {
          view.phase = phase
          show()
        },
        log: (next) => {
          view.log = next
          show()
        },
        notice: (message) => {
          view.notice = Option.some(message)
          show()
        },
      },
      (controls) => onInterrupt(controls.interrupt),
    ),
  ).pipe(
    Effect.tapError((error) =>
      Effect.sync(() =>
        setState(
          State.Failed({
            message: error.message,
            signIn: error.reason === "signIn",
            log: view.log,
          }),
        ),
      ),
    ),
  )
  setState(State.Ended({ log, seconds: view.seconds }))
})
