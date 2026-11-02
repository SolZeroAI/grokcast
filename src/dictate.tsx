import {
  Action,
  ActionPanel,
  Clipboard,
  closeMainWindow,
  Color,
  Detail,
  Icon,
  showHUD,
  type Keyboard,
} from "@raycast/api"
import * as Effect from "effect/Effect"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import { useState } from "react"
import { DictationDetail, Status, useDictation } from "./components/dictation.tsx"
import { openCommand } from "./components/launch.tsx"
import { clockOf, countWords, detailRows, Dictation, DictationPreferences } from "./lib/dictation.ts"

type Delivered = "pasted" | "copied" | "notDelivered"

const DELIVERED_LABELS = {
  pasted: "Pasted",
  copied: "Copied to the clipboard",
  notDelivered: "Could not paste or copy the text",
} as const

const HISTORY_SHORTCUT: Keyboard.Shortcut = { modifiers: ["cmd"], key: "y" }

export default function Dictate() {
  const [delivered, setDelivered] = useState<Delivered>("copied")

  const { state, stop, again } = useDictation(
    Effect.fn("deliverDictation")(function* (dictation: Dictation) {
      const settings = yield* DictationPreferences
      const how = yield* deliver(dictation, settings.afterDictation)
      setDelivered(how)
    }),
  )

  const historyAction = (
    <Action
      title="Open Dictation History"
      icon={Icon.Clock}
      shortcut={HISTORY_SHORTCUT}
      onAction={() => void openCommand("dictation-history")}
    />
  )

  return (
    <DictationDetail
      state={state}
      stop={stop}
      again={again}
      stopTitle="Stop and Transcribe"
      history
      actions={historyAction}
      heard={(dictation) => (
        <Detail
          markdown={dictation.text}
          metadata={
            <Status
              label={DELIVERED_LABELS[delivered]}
              icon={
                delivered === "notDelivered"
                  ? { source: Icon.ExclamationMark, tintColor: Color.Red }
                  : { source: Icon.CheckCircle, tintColor: Color.Green }
              }
              history
            >
              {detailRows({
                ...dictation,
                readySeconds: Option.some(dictation.readySeconds),
                live: Option.some(dictation.live),
              }).map((row) => (
                <Detail.Metadata.Label key={row.title} title={row.title} text={row.text} />
              ))}
            </Status>
          }
          actions={
            <ActionPanel>
              <Action.Paste content={dictation.text} />
              <Action.CopyToClipboard content={dictation.text} />
              <Action
                title="Dictate Again"
                icon={Icon.Microphone}
                shortcut={{ modifiers: ["cmd"], key: "r" }}
                onAction={again}
              />
              {historyAction}
            </ActionPanel>
          }
        />
      )}
    />
  )
}

/**
 * Paste into the app that was in front before Raycast opened, or copy. A paste that
 * fails falls back to a copy, so the text is never lost. A HUD sums up the dictation.
 */
const deliver = (dictation: Dictation, afterDictation: "paste" | "copy") =>
  Match.value(afterDictation).pipe(
    Match.when("paste", () =>
      Effect.tryPromise(async () => {
        await closeMainWindow()
        await Clipboard.paste(dictation.text)
        await showHUD(`Pasted ${summaryOf(dictation)}`)
      }).pipe(
        Effect.as<Delivered>("pasted"),
        Effect.catch(() => copy(dictation)),
      ),
    ),
    Match.orElse(() => copy(dictation)),
  )

const copy = (dictation: Dictation) =>
  Effect.tryPromise(() => Clipboard.copy(dictation.text)).pipe(
    // The text is on the clipboard even when the HUD cannot show.
    Effect.andThen(Effect.tryPromise(() => showHUD(`Copied ${summaryOf(dictation)}`)).pipe(Effect.ignore)),
    Effect.as<Delivered>("copied"),
    // The text stays on screen, with Paste and Copy actions to try again.
    Effect.catch(() => Effect.succeed<Delivered>("notDelivered")),
  )

/** Such as `42 words from 0:12 of speech`. */
const summaryOf = (dictation: Dictation): string => {
  const words = countWords(dictation.text)

  return `${words} ${words === 1 ? "word" : "words"} from ${clockOf(dictation.seconds)} of speech`
}
