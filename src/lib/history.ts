// Past dictations, newest first, kept in a key-value store on this Mac (Raycast's
// LocalStorage in the extension). Only text is kept, never audio.

import * as Arr from "effect/Array"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as KeyValueStore from "effect/persistence/KeyValueStore"

/** The history keeps this many dictations and drops older ones. */
export const MAX_HISTORY = 100

const KEY = "dictation-history"

export class HistoryEntry extends Schema.Class<HistoryEntry>("HistoryEntry")({
  id: Schema.String,
  text: Schema.String,
  /** Unix time in milliseconds. */
  createdAt: Schema.Finite,
  /** Length of the recording in seconds. */
  seconds: Schema.Finite,
}) {}

const Entries = Schema.Array(HistoryEntry)

const makeHistory = Effect.fn("DictationHistory.make")(function* () {
  const store = KeyValueStore.toSchemaStore(yield* KeyValueStore.KeyValueStore, Entries)
  const lock = yield* Semaphore.make(1)

  /** Unreadable history (an older format, or a damaged value) counts as empty. */
  const list = store.get(KEY).pipe(
    Effect.map(Option.getOrElse((): ReadonlyArray<HistoryEntry> => [])),
    Effect.catch(() => Effect.succeed<ReadonlyArray<HistoryEntry>>([])),
    Effect.withSpan("DictationHistory.list"),
  )

  const update = (f: (entries: ReadonlyArray<HistoryEntry>) => ReadonlyArray<HistoryEntry>) =>
    lock.withPermits(1)(Effect.flatMap(list, (entries) => store.set(KEY, f(entries))))

  const add = Effect.fn("DictationHistory.add")(function* (text: string, seconds: number) {
    const createdAt = yield* Clock.currentTimeMillis
    const entry = new HistoryEntry({ id: String(createdAt), text, createdAt, seconds })
    yield* update((entries) =>
      Arr.take(
        Arr.prepend(
          Arr.filter(entries, (old) => old.id !== entry.id),
          entry,
        ),
        MAX_HISTORY,
      ),
    )
    return entry
  })

  const remove = Effect.fn("DictationHistory.remove")(function* (id: string) {
    yield* update((entries) => Arr.filter(entries, (entry) => entry.id !== id))
  })

  const clear = store.remove(KEY).pipe(Effect.withSpan("DictationHistory.clear"))

  return DictationHistory.of({ list, add, remove, clear })
})

export class DictationHistory extends Context.Service<
  DictationHistory,
  {
    readonly list: Effect.Effect<ReadonlyArray<HistoryEntry>>
    readonly add: (
      text: string,
      seconds: number,
    ) => Effect.Effect<HistoryEntry, KeyValueStore.KeyValueStoreError | Schema.SchemaError>
    readonly remove: (
      id: string,
    ) => Effect.Effect<void, KeyValueStore.KeyValueStoreError | Schema.SchemaError>
    readonly clear: Effect.Effect<void, KeyValueStore.KeyValueStoreError>
  }
>()("grokcast/DictationHistory") {
  static readonly layer = Layer.effect(DictationHistory, makeHistory())
}
