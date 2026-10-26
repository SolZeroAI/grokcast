import assert from "node:assert/strict"
import { describe, it } from "node:test"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Base64 from "effect/encoding/Base64"
import * as TestClock from "effect/testing/TestClock"
import {
  AudioPlayer,
  Conversation,
  ConversationLog,
  grokDone,
  grokSaid,
  heardYou,
  REALTIME_URL,
  sessionUpdate,
  TalkSettings,
  transcriptOf,
  wavOf,
  youStarted,
  type TalkPhase,
} from "../src/lib/conversation.ts"
import { FRAME_BYTES } from "../src/lib/live-transcriber.ts"
import { StoredTokens } from "../src/lib/session.ts"
import { fakeRealtime, type RealtimeScript } from "./fake-realtime.ts"
import { chunk, FakeRecorder, fakeRecorderLayer } from "./fake-recorder.ts"
import { fakeFetch, memoryStore, NOW, testLayer, type MemoryStore } from "./support.ts"

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

const signedIn = () =>
  memoryStore(
    new StoredTokens({
      accessToken: Redacted.make("a1"),
      refreshToken: Option.some(Redacted.make("r1")),
      idToken: Option.none(),
      expiresAt: NOW + 3_600_000,
    }),
  )

const noChoices = new TalkSettings({ voice: Option.none(), instructions: Option.none() })

/** 100 ms of microphone audio, one frame. */
const SPEECH = new Uint8Array(FRAME_BYTES)

/** Grok's reply audio: four samples. */
const REPLY = chunk(10, 20, 30, 40)

/** One full exchange: the user speaks, Grok answers in words and audio, then xAI sends the user's words. */
const exchange: RealtimeScript = {
  onFirstAudio: [
    { type: "input_audio_buffer.speech_started", item_id: "u1" },
    { type: "input_audio_buffer.speech_stopped", item_id: "u1" },
    { type: "response.created", response: { id: "r1" } },
    { type: "response.output_audio_transcript.delta", delta: "Hi " },
    { type: "response.output_audio.delta", delta: Base64.encode(REPLY) },
    { type: "response.output_audio_transcript.delta", delta: "there." },
    { type: "some.future.event", value: 1 },
    { type: "response.done", response: { id: "r1" } },
    {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u1",
      transcript: " Hello, Grok. ",
    },
  ],
}

/** Run a conversation that ends once the player has played `plays` pieces, or when `stop` completes. */
const converse = (
  script: RealtimeScript,
  options: {
    readonly store?: MemoryStore
    readonly plays?: number
    readonly settings?: TalkSettings
    /** Interrupt Grok as soon as it says something, then end the conversation. */
    readonly interruptGrok?: boolean
  } = {},
) => {
  const xai = fakeRealtime(script)
  const played: Array<Uint8Array> = []
  const phases: Array<TalkPhase> = []
  const notices: Array<string> = []
  const recorder = new FakeRecorder().speak(SPEECH, SPEECH)
  const finished = Deferred.makeUnsafe<void>()
  const controls = { interrupt: () => {}, interrupted: false }
  const player = Layer.succeed(
    AudioPlayer,
    AudioPlayer.of({
      play: (wav) =>
        Effect.sync(() => {
          played.push(wav)
          if (played.length === (options.plays ?? 1)) Deferred.doneUnsafe(finished, Effect.void)
        }),
    }),
  )
  const result = Effect.runPromise(
    TestClock.setTime(NOW).pipe(
      Effect.andThen(
        Conversation.use((conversation) =>
          conversation.talk(
            Deferred.await(finished),
            options.settings ?? noChoices,
            {
              audio: () => {},
              phase: (phase) => phases.push(phase),
              log: (log) => {
                if (!options.interruptGrok || controls.interrupted) return
                if (!log.turns.some((turn) => turn.speaker === "grok")) return
                controls.interrupted = true
                controls.interrupt()
                setTimeout(() => Deferred.doneUnsafe(finished, Effect.void), 20)
              },
              notice: (message) => notices.push(message),
            },
            (given) => {
              controls.interrupt = given.interrupt
            },
          ),
        ),
      ),
      Effect.result,
      Effect.provide(
        Conversation.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(xai.layer, player, fakeRecorderLayer(recorder))),
          Layer.provideMerge(
            testLayer(
              fakeFetch(() => new Response(null, { status: 500 })),
              options.store ?? signedIn(),
            ),
          ),
        ),
      ),
    ),
  )
  return { sockets: xai.sockets, played, phases, notices, recorder, result }
}

describe("wavOf", () => {
  it("writes a 44-byte WAV header for mono 16-bit PCM", () => {
    const wav = wavOf(REPLY, 24_000)
    const view = new DataView(wav.buffer)
    const ascii = (offset: number) => new TextDecoder().decode(wav.slice(offset, offset + 4))
    assert.equal(wav.byteLength, 44 + REPLY.byteLength)
    assert.equal(ascii(0), "RIFF")
    assert.equal(ascii(8), "WAVE")
    assert.equal(ascii(36), "data")
    assert.equal(view.getUint32(4, true), 36 + REPLY.byteLength)
    assert.equal(view.getUint16(22, true), 1)
    assert.equal(view.getUint32(24, true), 24_000)
    assert.equal(view.getUint32(28, true), 48_000)
    assert.equal(view.getUint16(34, true), 16)
    assert.equal(view.getUint32(40, true), REPLY.byteLength)
    assert.deepEqual(wav.slice(44), REPLY)
  })
})

describe("sessionUpdate", () => {
  it("asks for 16 kHz PCM in, 24 kHz PCM out, and server turn detection, leaving unset choices to xAI", () => {
    assert.deepEqual(decodeJson(sessionUpdate(noChoices)), {
      type: "session.update",
      session: {
        turn_detection: { type: "server_vad" },
        audio: {
          input: { format: { type: "audio/pcm", rate: 16_000 } },
          output: { format: { type: "audio/pcm", rate: 24_000 } },
        },
      },
    })
  })

  it("puts the voice and instructions at the top of the session", () => {
    const update = decodeJson(
      sessionUpdate(
        new TalkSettings({ voice: Option.some("ara"), instructions: Option.some("Be brief.") }),
      ),
    )
    assert.ok(
      Schema.is(
        Schema.Struct({
          session: Schema.Struct({
            voice: Schema.Literal("ara"),
            instructions: Schema.Literal("Be brief."),
          }),
        }),
      )(update),
    )
  })
})

describe("ConversationLog", () => {
  it("keeps the user's turn before Grok's reply when the user's words arrive later", () => {
    const log = [
      (current: ConversationLog) => youStarted(current, Option.some("u1")),
      (current: ConversationLog) => grokSaid(current, "Hi "),
      (current: ConversationLog) => grokSaid(current, "there."),
      grokDone,
      (current: ConversationLog) => heardYou(current, Option.some("u1"), " Hello. "),
      (current: ConversationLog) => grokSaid(current, "Next."),
    ].reduce((current, step) => step(current), ConversationLog.empty)
    assert.equal(transcriptOf(log), "You: Hello.\n\nGrok: Hi there.\n\nGrok: Next.")
  })

  it("replaces earlier words for the same turn, and adds a turn without an ID", () => {
    const log = [
      (current: ConversationLog) => heardYou(current, Option.some("u1"), "Hel"),
      (current: ConversationLog) => heardYou(current, Option.some("u1"), "Hello"),
      (current: ConversationLog) => heardYou(current, Option.none(), "Again"),
    ].reduce((current, step) => step(current), ConversationLog.empty)
    assert.equal(transcriptOf(log), "You: Hello\n\nYou: Again")
  })
})

describe("Conversation.talk", () => {
  it("streams the microphone to xAI's realtime endpoint and plays Grok's reply", async () => {
    const talk = converse(exchange)
    const result = await talk.result
    assert.ok(Result.isSuccess(result), "the conversation failed")
    assert.equal(transcriptOf(result.success), "You: Hello, Grok.\n\nGrok: Hi there.")

    const socket = talk.sockets[0]
    assert.ok(socket)
    assert.equal(socket.url, REALTIME_URL)
    assert.equal(new URL(socket.url).searchParams.has("model"), false)
    assert.equal(socket.headers.authorization, "Bearer a1")
    assert.equal(socket.types[0], "session.update")
    assert.equal(socket.types[1], "input_audio_buffer.append")

    assert.equal(talk.played.length, 1)
    const wav = talk.played[0]
    assert.ok(wav)
    assert.deepEqual(wav.slice(44), REPLY)
    assert.ok(talk.phases.includes("thinking"))
    assert.ok(talk.phases.includes("speaking"))
    assert.ok(talk.recorder.finished, "the microphone kept recording")
  })

  it("stops Grok's reply on Interrupt, drops its audio, and tells xAI", async () => {
    const talk = converse(
      {
        onFirstAudio: [
          { type: "response.created", response: { id: "r1" } },
          { type: "response.output_audio_transcript.delta", delta: "A long answer" },
          { type: "response.output_audio.delta", delta: Base64.encode(REPLY) },
        ],
      },
      { interruptGrok: true },
    )
    const result = await talk.result
    assert.ok(Result.isSuccess(result))
    assert.equal(talk.played.length, 0)
    assert.ok(talk.sockets[0]?.types.includes("response.cancel"))
  })

  it("shows xAI's errors without ending the conversation", async () => {
    const talk = converse({
      onFirstAudio: [
        { type: "error", error: { message: "No response to cancel." } },
        ...(exchange.onFirstAudio ?? []),
      ],
    })
    const result = await talk.result
    assert.ok(Result.isSuccess(result))
    assert.deepEqual(talk.notices, ["No response to cancel."])
  })

  it("asks the user to sign in when nobody is signed in, without connecting", async () => {
    const talk = converse(exchange, { store: memoryStore() })
    const result = await talk.result
    assert.ok(Result.isFailure(result))
    assert.equal(result.failure.reason, "signIn")
    assert.equal(talk.sockets.length, 0)
  })

  it("fails when the connection is refused", async () => {
    const result = await converse({ refuse: true }).result
    assert.ok(Result.isFailure(result))
    assert.equal(result.failure._tag, "ConversationError")
    assert.equal(result.failure.reason, "failed")
  })

  it("fails when xAI drops the connection mid-conversation", async () => {
    const talk = converse({ dropOnAudio: true })
    const result = await talk.result
    assert.ok(Result.isFailure(result))
    assert.match(result.failure.message, /lost/)
    assert.ok(talk.recorder.finished, "the microphone kept recording")
  })
})
