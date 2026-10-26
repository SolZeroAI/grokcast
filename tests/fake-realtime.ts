import * as Arr from "effect/Array"
import * as Layer from "effect/Layer"
import * as P from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Socket from "effect/socket/Socket"

type Listener = (event: Socket.WebSocketEvent) => void
type EventType = "open" | "message" | "error" | "close"

/** A server event, as xAI sends it. */
export interface RealtimeEvent {
  readonly type: string
  readonly [field: string]: JsonValue
}

/** A value a JSON event can hold. */
export type JsonValue =
  | string
  | number
  | boolean
  | ReadonlyArray<JsonValue>
  | { readonly [field: string]: JsonValue }

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const decodeEvent = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ type: Schema.String })),
)

/** What the fake xAI does in a conversation. */
export interface RealtimeScript {
  /** Refuse the connection before it opens. */
  readonly refuse?: boolean
  /** Sent after the first audio frame. */
  readonly onFirstAudio?: ReadonlyArray<RealtimeEvent>
  /** Drop the connection (1006) after the first audio frame. */
  readonly dropOnAudio?: boolean
}

/** A stand-in for a WebSocket to xAI's realtime voice endpoint. */
export class FakeRealtimeSocket implements Socket.WebSocketLike {
  readyState = 0
  /** Text frames received, in order. */
  readonly texts: Array<string> = []
  private audioFrames = 0
  private readonly listeners: Array<{ type: EventType; listener: Listener; once: boolean }> = []

  constructor(
    readonly url: string,
    readonly headers: Readonly<Record<string, string>>,
    private readonly script: RealtimeScript,
  ) {
    setImmediate(() => {
      if (script.refuse) {
        this.emit("error", { type: "error" })
        this.drop()
        return
      }
      this.readyState = 1
      this.emit("open", { type: "open" })
      this.sendAll([{ type: "conversation.created", conversation: { id: "c1" } }])
    })
  }

  /** The `type` of each text frame received. */
  get types(): ReadonlyArray<string> {
    return this.texts.map((text) => decodeEvent(text).type)
  }

  addEventListener(type: EventType, listener: Listener, options?: { readonly once?: boolean }) {
    this.listeners.push({ type, listener, once: options?.once === true })
  }

  removeEventListener(type: EventType, listener: Listener) {
    const index = this.listeners.findIndex(
      (entry) => entry.type === type && entry.listener === listener,
    )
    if (index >= 0) this.listeners.splice(index, 1)
  }

  close(code = 1000) {
    if (this.readyState >= 2) return
    this.readyState = 3
    this.emit("close", { type: "close", code })
  }

  send(data: string | Uint8Array) {
    if (this.readyState !== 1 || !P.isString(data)) return
    this.texts.push(data)
    if (decodeEvent(data).type !== "input_audio_buffer.append") return
    this.audioFrames += 1
    if (this.audioFrames !== 1) return
    setImmediate(() => {
      if (this.script.dropOnAudio) {
        this.drop()
        return
      }
      this.sendAll(this.script.onFirstAudio ?? [])
    })
  }

  private sendAll(events: ReadonlyArray<RealtimeEvent>) {
    events.forEach((event) => {
      if (this.readyState !== 1) return
      this.emit("message", { type: "message", data: encodeEvent(event) })
    })
  }

  private drop() {
    this.readyState = 3
    this.emit("close", { type: "close", code: 1006 })
  }

  private emit(type: EventType, event: Socket.WebSocketEvent) {
    this.listeners
      .filter((entry) => entry.type === type)
      .forEach((entry) => {
        if (entry.once) this.removeEventListener(type, entry.listener)
        entry.listener(event)
      })
  }
}

/** A fake xAI realtime endpoint. Each connection follows `script`. */
export const fakeRealtime = (script: RealtimeScript = {}) => {
  const sockets: Array<FakeRealtimeSocket> = []
  const layer = Layer.succeed(
    Socket.WebSocketConstructor,
    Socket.WebSocketConstructor.of((url, options) => {
      const headers =
        P.isString(options) || Arr.isArray(options) || P.isUndefined(options)
          ? {}
          : (options.headers ?? {})
      const socket = new FakeRealtimeSocket(url, headers, script)
      sockets.push(socket)
      return socket
    }),
  )
  return { sockets, layer }
}
