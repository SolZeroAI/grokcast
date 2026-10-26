// Talk to Grok: a spoken conversation over xAI's realtime voice endpoint, as the
// signed-in user. The microphone streams to xAI, xAI decides when the user stopped
// speaking, and Grok's spoken reply plays through `AudioPlayer`. The xAI SDK only
// covers the endpoint's client secrets, so this talks to the WebSocket itself. No
// Raycast imports, so tests run it under plain Node with a fake WebSocket and player.

import * as Arr from "effect/Array"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as P from "effect/Predicate"
import * as Queue from "effect/Queue"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Base64 from "effect/encoding/Base64"
import * as HttpClient from "effect/http/HttpClient"
import * as Socket from "effect/socket/Socket"
import { toFrames } from "./live-transcriber.ts"
import {
  BYTES_PER_SAMPLE,
  durationOfBytes,
  joinChunks,
  levelDbfs,
  MAX_RECORDING,
  Recorder,
  SAMPLE_RATE,
} from "./recorder.ts"
import { GrokSession } from "./session.ts"
import { XaiFailureReason } from "./xai.ts"

/**
 * xAI's realtime voice endpoint. The token is sent only here. No `model` is set, so
 * xAI's default voice model and its upgrades apply.
 */
export const REALTIME_URL = "wss://api.x.ai/v1/realtime"

/** Grok's spoken reply comes back as mono 16-bit PCM at this rate. */
export const OUTPUT_SAMPLE_RATE = 24_000

/** A conversation ends on its own after this long. The recorder stops then too. */
export const MAX_CONVERSATION = MAX_RECORDING

/** How long to wait for the connection to open. */
const OPEN_TIMEOUT = Duration.seconds(10)

/**
 * Grok's reply plays in pieces of at least this much audio, so it starts before the
 * whole reply has arrived. Each piece is its own file, and a longer piece means
 * fewer gaps between files.
 */
export const SEGMENT_SECONDS = 2

const SEGMENT_BYTES = SEGMENT_SECONDS * OUTPUT_SAMPLE_RATE * BYTES_PER_SAMPLE

/** The conversation could not start or was cut off. `reason` picks what the UI offers. */
export class ConversationError extends Schema.TaggedError<ConversationError>()(
  "ConversationError",
  {
    reason: XaiFailureReason,
    message: Schema.String,
  },
) {}

/** Grok's reply could not be played. */
export class PlaybackError extends Schema.TaggedError<PlaybackError>()("PlaybackError", {
  message: Schema.String,
}) {}

/**
 * Plays one WAV file to the end. Interrupting the effect stops the audio. The
 * extension plays with macOS `afplay`.
 */
export class AudioPlayer extends Context.Service<
  AudioPlayer,
  {
    readonly play: (wav: Uint8Array<ArrayBuffer>) => Effect.Effect<void, PlaybackError>
  }
>()("grokcast/AudioPlayer") {}

/** The user's Talk to Grok preferences. None leaves the choice to xAI. */
export class TalkSettings extends Schema.Class<TalkSettings>("TalkSettings")({
  /** A built-in voice such as `eve`, or a custom voice ID. */
  voice: Schema.Option(Schema.String),
  /** The system prompt. */
  instructions: Schema.Option(Schema.String),
}) {}

export class TalkPreferences extends Context.Service<TalkPreferences, TalkSettings>()(
  "grokcast/TalkPreferences",
) {}

/** A WAV file of mono signed 16-bit little-endian `pcm` at `sampleRate`. */
export const wavOf = (pcm: Uint8Array, sampleRate: number): Uint8Array<ArrayBuffer> => {
  const header = new DataView(new ArrayBuffer(44))
  const ascii = (offset: number, text: string) =>
    Array.from(text).forEach((letter, index) =>
      header.setUint8(offset + index, letter.charCodeAt(0)),
    )
  ascii(0, "RIFF")
  header.setUint32(4, 36 + pcm.byteLength, true)
  ascii(8, "WAVE")
  ascii(12, "fmt ")
  header.setUint32(16, 16, true)
  header.setUint16(20, 1, true)
  header.setUint16(22, 1, true)
  header.setUint32(24, sampleRate, true)
  header.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true)
  header.setUint16(32, BYTES_PER_SAMPLE, true)
  header.setUint16(34, 8 * BYTES_PER_SAMPLE, true)
  ascii(36, "data")
  header.setUint32(40, pcm.byteLength, true)
  return joinChunks([new Uint8Array(header.buffer), pcm])
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/**
 * The first message: 16 kHz PCM in, 24 kHz PCM out, and xAI's voice activity
 * detection to end each turn. xAI reads `voice` at the top of the session, not
 * under `audio`. Unset choices are left out, so xAI's defaults apply.
 */
export const sessionUpdate = (settings: TalkSettings): string =>
  encodeJson({
    type: "session.update",
    session: {
      ...Option.match(settings.instructions, {
        onNone: () => ({}),
        onSome: (instructions) => ({ instructions }),
      }),
      ...Option.match(settings.voice, { onNone: () => ({}), onSome: (voice) => ({ voice }) }),
      turn_detection: { type: "server_vad" },
      audio: {
        input: { format: { type: "audio/pcm", rate: SAMPLE_RATE } },
        output: { format: { type: "audio/pcm", rate: OUTPUT_SAMPLE_RATE } },
      },
    },
  })

/** One frame of microphone audio. */
export const appendAudio = (frame: Uint8Array): string =>
  encodeJson({ type: "input_audio_buffer.append", audio: Base64.encode(frame) })

/** Stops the reply xAI is making. */
const CANCEL_RESPONSE = encodeJson({ type: "response.cancel" })

const AudioDelta = Schema.Struct({
  type: Schema.Literals(["response.output_audio.delta", "response.audio.delta"]),
  delta: Schema.Uint8ArrayFromBase64,
})

/** Grok's words as it speaks them. Text replies are shown the same way. */
const WordsDelta = Schema.Struct({
  type: Schema.Literals([
    "response.output_audio_transcript.delta",
    "response.audio_transcript.delta",
    "response.output_text.delta",
    "response.text.delta",
  ]),
  delta: Schema.String,
})

/** The user's words. xAI sends the whole turn each time, and can correct earlier words. */
const HeardYou = Schema.Struct({
  type: Schema.Literals([
    "conversation.item.input_audio_transcription.completed",
    "conversation.item.input_audio_transcription.updated",
  ]),
  transcript: Schema.String,
  item_id: Schema.OptionFromOptionalKey(Schema.String),
})

const SpeechStarted = Schema.Struct({
  type: Schema.Literal("input_audio_buffer.speech_started"),
  item_id: Schema.OptionFromOptionalKey(Schema.String),
})

const SpeechStopped = Schema.Struct({ type: Schema.Literal("input_audio_buffer.speech_stopped") })

const ResponseCreated = Schema.Struct({ type: Schema.Literal("response.created") })

const ResponseDone = Schema.Struct({ type: Schema.Literal("response.done") })

const ServerFailure = Schema.Struct({
  type: Schema.Literal("error"),
  error: Schema.OptionFromOptionalKey(
    Schema.Struct({ message: Schema.OptionFromOptionalKey(Schema.String) }),
  ),
  message: Schema.OptionFromOptionalKey(Schema.String),
})

const ServerEvent = Schema.Union([
  AudioDelta,
  WordsDelta,
  HeardYou,
  SpeechStarted,
  SpeechStopped,
  ResponseCreated,
  ResponseDone,
  ServerFailure,
])
type ServerEvent = typeof ServerEvent.Type

const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(ServerEvent))

/** A server frame as an event. Unknown events are skipped. */
export const eventOf = (frame: Uint8Array | string): Option.Option<ServerEvent> =>
  decodeEvent(P.isString(frame) ? frame : new TextDecoder().decode(frame))

const failureMessage = (failure: typeof ServerFailure.Type): string =>
  Option.getOrElse(
    Option.orElse(
      Option.flatMap(failure.error, (error) => error.message),
      () => failure.message,
    ),
    () => "xAI reported an error.",
  )

export const TalkSpeaker = Schema.Literals(["you", "grok"])
export type TalkSpeaker = typeof TalkSpeaker.Type

/** One turn of the conversation. */
export class Turn extends Schema.Class<Turn>("Turn")({
  speaker: TalkSpeaker,
  text: Schema.String,
  /** xAI's ID for the user's turn, so later words replace the earlier ones. */
  itemId: Schema.Option(Schema.String),
  /** Grok is still saying this turn. */
  open: Schema.Boolean,
}) {}

/** Everything said so far, oldest first. */
export class ConversationLog extends Schema.Class<ConversationLog>("ConversationLog")({
  turns: Schema.Array(Turn),
}) {
  static readonly empty = new ConversationLog({ turns: [] })
}

const sameItem = (itemId: Option.Option<string>) => (turn: Turn) =>
  turn.speaker === "you" &&
  Option.exists(itemId, (id) => Option.exists(turn.itemId, (other) => other === id))

/** The user started a turn. It holds its place before Grok's reply, and its words come later. */
export const youStarted = (log: ConversationLog, itemId: Option.Option<string>): ConversationLog =>
  Option.isNone(itemId) || Arr.some(log.turns, sameItem(itemId))
    ? log
    : new ConversationLog({
        turns: Arr.append(log.turns, new Turn({ speaker: "you", text: "", itemId, open: false })),
      })

/** The user's words for a turn. They replace what xAI heard before for the same turn. */
export const heardYou = (
  log: ConversationLog,
  itemId: Option.Option<string>,
  text: string,
): ConversationLog =>
  Option.match(Arr.findFirstIndex(log.turns, sameItem(itemId)), {
    onSome: (index) =>
      new ConversationLog({
        turns: Arr.map(log.turns, (turn, at) =>
          at === index ? new Turn({ ...turn, text: text.trim() }) : turn,
        ),
      }),
    onNone: () =>
      new ConversationLog({
        turns: Arr.append(
          log.turns,
          new Turn({ speaker: "you", text: text.trim(), itemId, open: false }),
        ),
      }),
  })

/** More of Grok's words. They go on the turn Grok is still saying, or start a new one. */
export const grokSaid = (log: ConversationLog, words: string): ConversationLog =>
  Option.match(
    Arr.findLastIndex(log.turns, (turn) => turn.speaker === "grok" && turn.open),
    {
      onSome: (index) =>
        new ConversationLog({
          turns: Arr.map(log.turns, (turn, at) =>
            at === index ? new Turn({ ...turn, text: turn.text + words }) : turn,
          ),
        }),
      onNone: () =>
        new ConversationLog({
          turns: Arr.append(
            log.turns,
            new Turn({ speaker: "grok", text: words, itemId: Option.none(), open: true }),
          ),
        }),
    },
  )

/** Grok finished its reply. */
export const grokDone = (log: ConversationLog): ConversationLog =>
  new ConversationLog({
    turns: Arr.map(log.turns, (turn) => (turn.open ? new Turn({ ...turn, open: false }) : turn)),
  })

/** Turns with words, as `You: …` and `Grok: …` paragraphs, for the clipboard. */
export const transcriptOf = (log: ConversationLog): string =>
  Arr.filter(log.turns, (turn) => turn.text.trim() !== "")
    .map((turn) => `${turn.speaker === "you" ? "You" : "Grok"}: ${turn.text.trim()}`)
    .join("\n\n")

/** What the conversation is doing now. */
export const TalkPhase = Schema.Literals(["connecting", "listening", "thinking", "speaking"])
export type TalkPhase = typeof TalkPhase.Type

/** What `talk` reports while it runs. */
export interface TalkProgress {
  /** Seconds since the microphone started, and the level of the last chunk, for a meter. */
  readonly audio: (seconds: number, level: number) => void
  readonly phase: (phase: TalkPhase) => void
  readonly log: (log: ConversationLog) => void
  /** Something went wrong that does not end the conversation, such as a reply that could not play. */
  readonly notice: (message: string) => void
}

/** Ways to steer a running conversation. */
export interface TalkControls {
  /** Stop Grok speaking now. The conversation goes on. */
  readonly interrupt: () => void
}

/** A piece of Grok's reply to play. `round` drops pieces of a reply that was interrupted. */
interface Segment {
  readonly round: number
  readonly pcm: Uint8Array
}

const failed = (message: string) => new ConversationError({ reason: "failed", message })

const makeConversation = Effect.fn("Conversation.make")(function* () {
  const session = yield* GrokSession
  const http = yield* HttpClient.HttpClient
  const webSocket = yield* Socket.WebSocketConstructor
  const recorder = yield* Recorder
  const player = yield* AudioPlayer

  const talk = Effect.fn("Conversation.talk")(
    function* (
      stop: Effect.Effect<void>,
      settings: TalkSettings,
      progress: TalkProgress,
      onControls: (controls: TalkControls) => void,
    ) {
      progress.phase("connecting")
      yield* recorder.ensureAccess.pipe(Effect.mapError((error) => failed(error.message)))
      const token = yield* session.accessToken.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.mapError((error) =>
          Match.value(error).pipe(
            Match.tag(
              "NotSignedInError",
              (notSignedIn) =>
                new ConversationError({ reason: "signIn", message: notSignedIn.message }),
            ),
            Match.orElse((other) => failed(other.message)),
          ),
        ),
      )
      const socket = yield* Socket.makeWebSocket(REALTIME_URL, {
        headers: { authorization: `Bearer ${Redacted.value(token)}` },
        openTimeout: OPEN_TIMEOUT,
      })
      const reader = yield* socket.reader
      const writer = yield* socket.writer
      yield* writer.write(sessionUpdate(settings))

      const log = yield* Ref.make(ConversationLog.empty)
      const phase = yield* Ref.make<TalkPhase>("listening")
      /** A reply is arriving. */
      const responding = yield* Ref.make(false)
      /** Audio of the reply in progress that has not gone to the player yet. */
      const pending = yield* Ref.make(Arr.empty<Uint8Array>())
      /** Pieces of replies waiting to play, and how many have not finished playing. */
      const segments = yield* Queue.unbounded<Segment>()
      const unplayed = yield* Ref.make(0)
      /** Goes up on each interruption, so older pieces are dropped. */
      const round = yield* Ref.make(0)
      const playing = yield* Ref.make(Option.none<Fiber.Fiber<void>>())
      const interrupts = yield* Queue.unbounded<void>()

      const setPhase = (next: TalkPhase) =>
        Ref.getAndSet(phase, next).pipe(
          Effect.flatMap((previous) =>
            previous === next ? Effect.void : Effect.sync(() => progress.phase(next)),
          ),
        )
      const updateLog = (change: (current: ConversationLog) => ConversationLog) =>
        Ref.updateAndGet(log, change).pipe(
          Effect.flatMap((current) => Effect.sync(() => progress.log(current))),
        )

      /** Grok is speaking, or about to, so the microphone is not sent. That keeps Grok from hearing itself. */
      const grokHasTheFloor = Effect.map(
        Effect.all([Ref.get(responding), Ref.get(unplayed)]),
        ([replying, waiting]) => replying || waiting > 0,
      )

      /** Back to listening once the reply has arrived and every piece has played. */
      const settle = Effect.flatMap(grokHasTheFloor, (busy) =>
        busy ? Effect.void : setPhase("listening"),
      )

      const queuePending = Effect.gen(function* () {
        const chunks = yield* Ref.getAndSet(pending, [])
        if (chunks.length === 0) return
        yield* Ref.update(unplayed, (count) => count + 1)
        yield* Queue.offer(segments, { round: yield* Ref.get(round), pcm: joinChunks(chunks) })
      }).pipe(Effect.withSpan("Conversation.queuePending"))

      const playOne = (segment: Segment) =>
        Effect.gen(function* () {
          if (segment.round === (yield* Ref.get(round))) {
            yield* setPhase("speaking")
            const fiber = yield* Effect.forkChild(
              player
                .play(wavOf(segment.pcm, OUTPUT_SAMPLE_RATE))
                .pipe(
                  Effect.catchTag("PlaybackError", (error) =>
                    Effect.sync(() => progress.notice(error.message)),
                  ),
                ),
            )
            yield* Ref.set(playing, Option.some(fiber))
            yield* Fiber.await(fiber)
            yield* Ref.set(playing, Option.none())
          }
          yield* Ref.update(unplayed, (count) => Math.max(0, count - 1))
          yield* settle
        })

      /** Stop the reply: drop what has not played, stop what is playing, and tell xAI. */
      const interrupt = Effect.gen(function* () {
        yield* Ref.update(round, (count) => count + 1)
        yield* Ref.set(pending, [])
        const fiber = yield* Ref.getAndSet(playing, Option.none())
        yield* Option.match(fiber, { onNone: () => Effect.void, onSome: Fiber.interrupt })
        if (yield* Ref.getAndSet(responding, false)) yield* writer.write(CANCEL_RESPONSE)
        yield* updateLog(grokDone)
        yield* settle
      }).pipe(Effect.withSpan("Conversation.interrupt"))

      const handle = (event: ServerEvent) =>
        Match.value(event).pipe(
          Match.when({ type: "response.output_audio.delta" }, (audio) => addAudio(audio.delta)),
          Match.when({ type: "response.audio.delta" }, (audio) => addAudio(audio.delta)),
          Match.when({ type: "response.output_audio_transcript.delta" }, (words) =>
            addWords(words.delta),
          ),
          Match.when({ type: "response.audio_transcript.delta" }, (words) => addWords(words.delta)),
          Match.when({ type: "response.output_text.delta" }, (words) => addWords(words.delta)),
          Match.when({ type: "response.text.delta" }, (words) => addWords(words.delta)),
          Match.when({ type: "conversation.item.input_audio_transcription.completed" }, (heard) =>
            updateLog((current) => heardYou(current, heard.item_id, heard.transcript)),
          ),
          Match.when({ type: "conversation.item.input_audio_transcription.updated" }, (heard) =>
            updateLog((current) => heardYou(current, heard.item_id, heard.transcript)),
          ),
          Match.when({ type: "input_audio_buffer.speech_started" }, (started) =>
            updateLog((current) => youStarted(current, started.item_id)),
          ),
          Match.when({ type: "input_audio_buffer.speech_stopped" }, () => setPhase("thinking")),
          Match.when({ type: "response.created" }, () => Ref.set(responding, true)),
          Match.when({ type: "response.done" }, () =>
            Ref.set(responding, false).pipe(
              Effect.andThen(queuePending),
              Effect.andThen(updateLog(grokDone)),
              Effect.andThen(settle),
            ),
          ),
          Match.when({ type: "error" }, (failure) =>
            Effect.sync(() => progress.notice(failureMessage(failure))),
          ),
          Match.exhaustive,
        )

      const addAudio = (pcm: Uint8Array) =>
        Effect.gen(function* () {
          yield* Ref.set(responding, true)
          const chunks = yield* Ref.updateAndGet(pending, (current) => Arr.append(current, pcm))
          const bytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
          if (bytes >= SEGMENT_BYTES) yield* queuePending
        })

      const addWords = (words: string) =>
        Ref.set(responding, true).pipe(
          Effect.andThen(updateLog((current) => grokSaid(current, words))),
        )

      // The microphone runs for the whole conversation. Its audio is dropped while Grok speaks.
      const recorded = yield* Ref.make(0)
      const microphone = recorder.record.pipe(
        Stream.tap((chunk) =>
          Ref.updateAndGet(recorded, (bytes) => bytes + chunk.byteLength).pipe(
            Effect.flatMap((bytes) =>
              Effect.sync(() => progress.audio(durationOfBytes(bytes), levelDbfs(chunk))),
            ),
          ),
        ),
        Stream.filterEffect(() => Effect.map(grokHasTheFloor, (busy) => !busy)),
        toFrames,
        Stream.runForEach((frame) => writer.write(appendAudio(frame))),
        Effect.mapError((error) =>
          P.isTagged(error, "RecorderError")
            ? failed(error.message)
            : failed("The connection to Grok was lost."),
        ),
      )

      const replies = Stream.fromPull(Effect.succeed(reader.pull)).pipe(
        Stream.map((frame) => Arr.fromOption(eventOf(frame))),
        Stream.flattenIterable,
        Stream.runForEach(handle),
        Effect.andThen(Effect.fail(failed("Grok ended the conversation."))),
        Effect.catchTag("SocketError", () =>
          Effect.fail(failed("The connection to Grok was lost.")),
        ),
      )

      const playback = Stream.fromQueue(segments).pipe(Stream.runForEach(playOne))
      const controls = Stream.fromQueue(interrupts).pipe(Stream.runForEach(() => interrupt))

      onControls({ interrupt: () => Queue.offerUnsafe(interrupts, undefined) })
      progress.phase("listening")

      // The conversation ends when the user stops it or time runs out. A failure on
      // any side ends it sooner.
      yield* Effect.raceFirst(
        Effect.raceFirst(stop, Effect.sleep(MAX_CONVERSATION)),
        Effect.all([microphone, replies, playback, controls], { concurrency: "unbounded" }),
      )
      return yield* Ref.get(log)
    },
    Effect.scoped,
    Effect.catchTag("SocketError", () =>
      Effect.fail(failed("Could not connect to Grok voice. Check your internet connection.")),
    ),
    Effect.provideService(Socket.WebSocketConstructor, webSocket),
  )

  return Conversation.of({ talk })
})

export class Conversation extends Context.Service<
  Conversation,
  {
    /**
     * Talk with Grok until `stop` completes or `MAX_CONVERSATION` passes. `onControls`
     * gets the controls once the conversation starts. Succeeds with what was said.
     */
    readonly talk: (
      stop: Effect.Effect<void>,
      settings: TalkSettings,
      progress: TalkProgress,
      onControls: (controls: TalkControls) => void,
    ) => Effect.Effect<ConversationLog, ConversationError>
  }
>()("grokcast/Conversation") {
  static readonly layer = Layer.effect(Conversation, makeConversation())
}
