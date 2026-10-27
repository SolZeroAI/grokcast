import assert from "node:assert/strict"
import { describe, it } from "node:test"
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import {
  Chat,
  ChatSettings,
  ChatTurn,
  Citation,
  inputOf,
  titleOf,
  toolLabel,
  turnMarkdown,
  type ChatProgress,
} from "../src/lib/chat.ts"
import { StoredTokens } from "../src/lib/session.ts"
import {
  fakeFetch,
  json,
  memoryStore,
  NOW,
  testLayer,
  type FakeFetch,
  type MemoryStore,
} from "./support.ts"

const signedIn = () =>
  memoryStore(
    new StoredTokens({
      accessToken: Redacted.make("a1"),
      refreshToken: Option.some(Redacted.make("r1")),
      idToken: Option.none(),
      expiresAt: NOW + 3_600_000,
    }),
  )

const defaults = new ChatSettings({
  model: Option.none(),
  reasoningEffort: Option.none(),
  instructions: Option.none(),
  tools: ["webSearch", "xSearch"],
})

const turn = (prompt: string, answer: string) =>
  new ChatTurn({
    id: prompt,
    prompt,
    answer,
    createdAt: NOW,
    model: Option.some("grok-4.7"),
    seconds: 1.25,
    citations: [],
    toolsUsed: [],
    complete: true,
  })

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** A server-sent event stream with `events` as JSON data lines. */
const sse = (events: ReadonlyArray<object>): Response =>
  new Response(events.map((event) => `data: ${encodeJson(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })

const message = {
  type: "message",
  id: "msg_1",
  role: "assistant",
  status: "completed",
  content: [
    {
      type: "output_text",
      text: "Hello there.",
      annotations: [
        { type: "url_citation", url: "https://www.example.com/a", title: "Example" },
        { type: "url_citation", url: "https://news.example.org/b" },
        { type: "url_citation", url: "https://www.example.com/a", title: "Example" },
      ],
    },
  ],
}

const answerStream = () =>
  sse([
    { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
    { type: "response.reasoning_summary_text.delta", delta: "Hmm" },
    {
      type: "response.output_item.done",
      item: { type: "web_search_call", id: "ws_1", status: "completed" },
    },
    {
      type: "response.output_item.done",
      item: {
        type: "custom_tool_call",
        id: "x_1",
        call_id: "x_1",
        name: "x_keyword_search",
        input: "{}",
      },
    },
    { type: "response.output_text.delta", delta: "Hello " },
    { type: "response.output_text.delta", delta: "there." },
    { type: "response.output_item.done", item: message },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        model: "grok-4.7",
        output: [message],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ])

interface Progress extends ChatProgress {
  readonly texts: Array<string>
  readonly tools: Array<string>
  readonly thoughts: Array<true>
}

const progress = (): Progress => {
  const texts: Array<string> = []
  const tools: Array<string> = []
  const thoughts: Array<true> = []
  return {
    texts,
    tools,
    thoughts,
    thinking: () => thoughts.push(true),
    tool: (label) => tools.push(label),
    text: (answer) => texts.push(answer),
  }
}

const provide = <A, E>(program: Effect.Effect<A, E, Chat>, fetch: FakeFetch, store: MemoryStore) =>
  Effect.runPromise(
    TestClock.setTime(NOW).pipe(
      Effect.andThen(program),
      Effect.provide(Chat.layer.pipe(Layer.provideMerge(testLayer(fetch, store)))),
    ),
  )

const ask = (
  fetch: FakeFetch,
  options: {
    readonly store?: MemoryStore
    readonly settings?: ChatSettings
    readonly history?: ReadonlyArray<ChatTurn>
    readonly progress?: Progress
  } = {},
) =>
  provide(
    Chat.use((chat) =>
      chat.ask(
        "Say hello",
        { conversationId: "c1", history: options.history ?? [] },
        options.settings ?? defaults,
        options.progress ?? progress(),
      ),
    ),
    fetch,
    options.store ?? signedIn(),
  )

const askError = (fetch: FakeFetch, store: MemoryStore = signedIn()) =>
  provide(
    Effect.flip(
      Chat.use((chat) =>
        chat.ask("Say hello", { conversationId: "c1", history: [] }, defaults, progress()),
      ),
    ),
    fetch,
    store,
  )

const Body = Schema.fromJsonString(
  Schema.Struct({
    model: Schema.optionalKey(Schema.String),
    stream: Schema.Boolean,
    store: Schema.Boolean,
    prompt_cache_key: Schema.String,
    instructions: Schema.optionalKey(Schema.String),
    reasoning: Schema.optionalKey(Schema.Struct({ effort: Schema.String })),
    tools: Schema.optionalKey(Schema.Array(Schema.Struct({ type: Schema.String }))),
    input: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.String })),
  }),
)

/** The JSON body of the first request. */
const bodyOf = (fetch: FakeFetch) =>
  Schema.decodeUnknownSync(Body)(
    Arr.get(fetch.requests, 0).pipe(
      Option.map((request) => request.body),
      Option.getOrElse(() => ""),
    ),
  )

describe("Chat.ask", () => {
  it("streams the answer from the Responses API with the signed-in user's token", async () => {
    const fetch = fakeFetch(answerStream)
    const seen = progress()
    const answered = await ask(fetch, { progress: seen })
    assert.equal(answered.answer, "Hello there.")
    assert.equal(answered.prompt, "Say hello")
    assert.deepEqual(answered.model, Option.some("grok-4.7"))
    assert.equal(answered.complete, true)
    assert.deepEqual(seen.texts, ["Hello ", "Hello there."])
    assert.deepEqual(seen.tools, ["Searched the web", "Searched X"])
    assert.equal(seen.thoughts.length, 1)
    assert.deepEqual(answered.toolsUsed, ["Searched the web", "Searched X"])
    assert.deepEqual(
      answered.citations.map((citation) => citation.url),
      ["https://www.example.com/a", "https://news.example.org/b"],
    )
    const [request] = fetch.requests
    assert.equal(request?.url, "https://api.x.ai/v1/responses")
    assert.equal(request?.method, "POST")
    assert.equal(request?.headers.get("authorization"), "Bearer a1")
  })

  it("leaves the model to xAI and sends Grok's tools, unstored, with a cache key per conversation", async () => {
    const fetch = fakeFetch(answerStream)
    await ask(fetch)
    const body = bodyOf(fetch)
    assert.equal(body.model, undefined)
    assert.equal(body.reasoning, undefined)
    assert.equal(body.instructions, undefined)
    assert.equal(body.stream, true)
    assert.equal(body.store, false)
    assert.equal(body.prompt_cache_key, "grokcast-chat:c1")
    assert.deepEqual(
      body.tools?.map((tool) => tool.type),
      ["web_search", "x_search"],
    )
  })

  it("sends the model, reasoning effort, and instructions the user set, and no tools when all are off", async () => {
    const fetch = fakeFetch(answerStream)
    await ask(fetch, {
      settings: new ChatSettings({
        model: Option.some("grok-4.7"),
        reasoningEffort: Option.some("low"),
        instructions: Option.some("Answer briefly."),
        tools: [],
      }),
    })
    const body = bodyOf(fetch)
    assert.equal(body.model, "grok-4.7")
    assert.deepEqual(body.reasoning, { effort: "low" })
    assert.equal(body.instructions, "Answer briefly.")
    assert.equal(body.tools, undefined)
  })

  it("sends earlier turns as plain messages before the question", async () => {
    const fetch = fakeFetch(answerStream)
    await ask(fetch, { history: [turn("Hi", "Hello!")] })
    assert.deepEqual(bodyOf(fetch).input, [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "Say hello" },
    ])
  })

  it("asks the user to sign in when nobody is signed in, without calling xAI", async () => {
    const fetch = fakeFetch(answerStream)
    const error = await askError(fetch, memoryStore())
    assert.equal(error.reason, "signIn")
    assert.equal(fetch.requests.length, 0)
  })

  it("explains a 403 as the plan, and a 429 as the usage limit without retrying", async () => {
    const plan = await askError(fakeFetch(() => json({ error: "forbidden" }, 403)))
    assert.equal(plan.reason, "plan")
    assert.match(plan.message, /chat/)
    const limited = fakeFetch(() => json({ error: "rate limited" }, 429))
    const limit = await askError(limited)
    assert.equal(limit.reason, "usageLimit")
    assert.equal(limited.requests.length, 1)
  })

  it("reports a stream that ends before the answer completes", async () => {
    const error = await askError(
      fakeFetch(() =>
        sse([
          {
            type: "response.created",
            response: { id: "resp_1", status: "in_progress", output: [] },
          },
          { type: "response.output_text.delta", delta: "Hel" },
        ]),
      ),
    )
    assert.equal(error.reason, "failed")
  })
})

describe("chat helpers", () => {
  it("builds the input from earlier turns", () => {
    assert.deepEqual(inputOf([], "Hi"), [{ role: "user", content: "Hi" }])
  })

  it("titles a conversation with the first line of its first question, cut at a word", () => {
    assert.equal(titleOf("  What is Grok?\nMore detail"), "What is Grok?")
    assert.equal(
      titleOf("one two three four five six seven eight nine ten eleven twelve thirteen"),
      "one two three four five six seven eight nine ten eleven…",
    )
  })

  it("names what a server tool did", () => {
    assert.equal(
      toolLabel({ type: "web_search_call", id: "1", action: { type: "search", query: "grok" } }),
      "Searched the web",
    )
    assert.equal(toolLabel({ type: "code_interpreter_call", id: "1", outputs: [] }), "Ran code")
  })

  it("shows the question, the answer, numbered sources, and a footer", () => {
    const answered = new ChatTurn({
      ...turn("Hi", "Hello!"),
      citations: [
        new Citation({ url: "https://www.example.com/a", title: Option.none() }),
        new Citation({ url: "https://b.example.org", title: Option.some("B [news]") }),
      ],
      toolsUsed: ["Searched the web"],
      complete: false,
    })
    assert.equal(
      turnMarkdown(answered),
      [
        "**Hi**",
        "Hello!",
        "**Sources**\n\n1. [example.com](https://www.example.com/a)\n2. [B (news)](https://b.example.org)",
        "_grok-4.7 · 1.3 s · Searched the web · The answer stopped early_",
      ].join("\n\n"),
    )
  })
})
