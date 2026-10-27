// Chat with Grok as the signed-in user: stream an answer with the xAI Responses API,
// with Grok's own web search, X search, and code execution when the user turns them
// on. No Raycast imports, so tests run it under plain Node with a fake `fetch`.

import type { CreateParams, InputItem, ServerToolCall, Tool } from "@xai-official/sdk"
import { codeExecution, webSearch, xSearch } from "@xai-official/sdk/tools"
import * as Arr from "effect/Array"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { callXai, describeXaiError, XaiClient, XaiFailureReason } from "./xai.ts"

/** How long Grok may go without sending anything while it answers. Reasoning can be quiet for a while. */
const IDLE_TIMEOUT = Duration.minutes(3)

/** Grok's own tools, which xAI runs. */
export const ChatTool = Schema.Literals(["webSearch", "xSearch", "codeExecution"])
export type ChatTool = typeof ChatTool.Type

export const ReasoningEffort = Schema.Literals(["low", "medium", "high"])
export type ReasoningEffort = typeof ReasoningEffort.Type

export class ChatSettings extends Schema.Class<ChatSettings>("ChatSettings")({
  /** A model ID such as `grok-4.7`. None leaves it to xAI, so its default and upgrades apply. */
  model: Schema.Option(Schema.String),
  /** None leaves it to the model. */
  reasoningEffort: Schema.Option(ReasoningEffort),
  /** Instructions sent with every question, such as "Answer briefly". */
  instructions: Schema.Option(Schema.String),
  tools: Schema.Array(ChatTool),
}) {}

/** The user's chat preferences. */
export class ChatPreferences extends Context.Service<ChatPreferences, ChatSettings>()(
  "grokcast/ChatPreferences",
) {}

export class Citation extends Schema.Class<Citation>("Citation")({
  url: Schema.String,
  title: Schema.Option(Schema.String),
}) {}

/** One question and Grok's answer. */
export class ChatTurn extends Schema.Class<ChatTurn>("ChatTurn")({
  id: Schema.String,
  prompt: Schema.String,
  answer: Schema.String,
  /** Unix time in milliseconds, when the question was sent. */
  createdAt: Schema.Finite,
  /** The model that answered, as xAI reported it. */
  model: Schema.OptionFromOptionalKey(Schema.String),
  /** Seconds from the question until the answer was complete. */
  seconds: Schema.Finite,
  /** The web pages and posts the answer cites. */
  citations: Schema.Array(Citation),
  /** What Grok's tools did, such as "Searched the web", once each. */
  toolsUsed: Schema.Array(Schema.String),
  /** False when the answer stopped early, such as at the output limit. */
  complete: Schema.Boolean,
}) {}

/** Chat failed. `reason` picks what the UI offers, `message` is for the user. */
export class ChatError extends Schema.TaggedError<ChatError>()("ChatError", {
  reason: XaiFailureReason,
  message: Schema.String,
}) {}

/** What `ask` reports while Grok answers. */
export interface ChatProgress {
  /** Grok is reasoning before it answers. */
  readonly thinking: () => void
  /** One of Grok's tools ran, such as "Searched the web". */
  readonly tool: (label: string) => void
  /** The whole answer so far. */
  readonly text: (answer: string) => void
}

/** What `ask` needs besides the question. */
export interface AskContext {
  /** Groups a conversation's requests for xAI's prompt cache. */
  readonly conversationId: string
  /** The earlier turns, oldest first. */
  readonly history: ReadonlyArray<ChatTurn>
}

/**
 * The input for a new question: earlier turns as plain user and assistant messages,
 * then the question. Only the visible text is kept between turns, so a saved
 * conversation continues the same way it began.
 */
export const inputOf = (history: ReadonlyArray<ChatTurn>, prompt: string): Array<InputItem> => [
  ...Arr.flatMap(history, turnInput),
  { role: "user", content: prompt },
]

const turnInput = (turn: ChatTurn): Array<InputItem> => [
  { role: "user", content: turn.prompt },
  { role: "assistant", content: turn.answer },
]

export const toolsOf = (tools: ReadonlyArray<ChatTool>): Array<Tool> =>
  Arr.map(Arr.dedupe(tools), (tool) =>
    Match.value(tool).pipe(
      Match.when("webSearch", () => webSearch()),
      Match.when("xSearch", () => xSearch()),
      Match.when("codeExecution", () => codeExecution()),
      Match.exhaustive,
    ),
  )

const searchLabel = (name: string): string =>
  Match.value(name).pipe(
    Match.when(
      (search) => search.startsWith("x_"),
      () => "Searched X",
    ),
    Match.when(
      (search) => search.startsWith("web_") || search.startsWith("browse"),
      () => "Searched the web",
    ),
    Match.orElse((search) => `Used ${search.replaceAll("_", " ")}`),
  )

/** What a finished server tool call did, in words for the user. */
export const toolLabel = (call: ServerToolCall): string =>
  Match.value(call).pipe(
    Match.when({ type: "web_search_call" }, () => "Searched the web"),
    Match.when({ type: "x_search_call" }, () => "Searched X"),
    Match.when({ type: "custom_tool_call" }, (custom) => searchLabel(custom.name)),
    Match.when({ type: "code_interpreter_call" }, () => "Ran code"),
    Match.when({ type: "file_search_call" }, () => "Searched files"),
    Match.when({ type: "mcp_call" }, () => "Used a connected tool"),
    Match.when({ type: "image_generation_call" }, () => "Made an image"),
    Match.orElse(() => "Used a tool"),
  )

/** A conversation's title: the first line of its first question, cut at a word. */
export const titleOf = (prompt: string, max = 60): string => {
  const line = Option.getOrElse(Arr.head(prompt.trim().split("\n")), () => "").trim()
  if (line.length <= max) return line
  const cut = line.slice(0, max)
  const space = cut.lastIndexOf(" ")
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** The request body. The model is left out unless the user picked one. */
export const requestOf = (
  settings: ChatSettings,
  context: AskContext,
  prompt: string,
): CreateParams => {
  const body = {
    input: inputOf(context.history, prompt),
    prompt_cache_key: `grokcast-chat:${context.conversationId}`,
    ...Option.match(settings.instructions, {
      onNone: () => ({}),
      onSome: (instructions) => ({ instructions }),
    }),
    ...Option.match(settings.reasoningEffort, {
      onNone: () => ({}),
      onSome: (effort) => ({ reasoning: { effort } }),
    }),
    ...Arr.match(toolsOf(settings.tools), {
      onEmpty: () => ({}),
      onNonEmpty: (tools) => ({ tools }),
    }),
    ...Option.match(settings.model, { onNone: () => ({}), onSome: (model) => ({ model }) }),
  }
  // SAFETY: the SDK's type requires `model`, but the API's `ModelRequest.model` is
  // optional and xAI uses its default model without it. The project keeps the model
  // unset so xAI's default and its upgrades apply.
  return body as CreateParams
}

const makeChat = Effect.fn("Chat.make")(function* () {
  const xai = yield* XaiClient

  const ask = Effect.fn("Chat.ask")(function* (
    prompt: string,
    context: AskContext,
    settings: ChatSettings,
    progress: ChatProgress,
  ) {
    const client = yield* xai.client.pipe(
      Effect.mapError((error) => new ChatError({ reason: "failed", message: error.message })),
    )
    const startedAt = yield* Clock.currentTimeMillis
    const seen = { answer: "", citations: Arr.empty<Citation>(), tools: Arr.empty<string>() }
    const response = yield* callXai(async (signal) => {
      const stream = await client.responses.create(
        { ...requestOf(settings, context, prompt), stream: true },
        // A 429 here is usually the plan's usage limit, so say so at once instead of waiting.
        { signal, maxRetries: 0, idleTimeout: Duration.toMillis(IDLE_TIMEOUT) },
      )
      return stream
        .on("reasoning", () => progress.thinking())
        .on("text", (delta) => {
          seen.answer += delta
          progress.text(seen.answer)
        })
        .on("server_tool_call", (call) => {
          const label = toolLabel(call)
          if (!seen.tools.includes(label)) seen.tools = Arr.append(seen.tools, label)
          progress.tool(label)
        })
        .on("citation", (citation) => {
          if (seen.citations.some((known) => known.url === citation.url)) return
          seen.citations = Arr.append(
            seen.citations,
            new Citation({
              url: citation.url,
              title: Option.filter(Option.fromNullishOr(citation.title), (title) => title !== ""),
            }),
          )
        })
        .done()
    }).pipe(
      Effect.mapError((error) => {
        const failure = describeXaiError(error, {
          feature: "chat",
          failed: "Grok could not answer",
        })
        return new ChatError({ reason: failure.reason, message: failure.message })
      }),
    )
    const finishedAt = yield* Clock.currentTimeMillis
    const answer = response.toText().trim()
    return new ChatTurn({
      id: String(startedAt),
      prompt,
      answer: answer === "" ? seen.answer.trim() : answer,
      createdAt: startedAt,
      model: Option.filter(Option.fromNullishOr(response.model), (model) => model !== ""),
      seconds: (finishedAt - startedAt) / 1000,
      citations: seen.citations,
      toolsUsed: seen.tools,
      complete: response.status === "completed",
    })
  })

  return Chat.of({ ask })
})

export class Chat extends Context.Service<
  Chat,
  {
    /** Ask Grok `prompt` after the turns in `context`, and stream the answer to `progress`. */
    readonly ask: (
      prompt: string,
      context: AskContext,
      settings: ChatSettings,
      progress: ChatProgress,
    ) => Effect.Effect<ChatTurn, ChatError>
  }
>()("grokcast/Chat") {
  static readonly layer = Layer.effect(Chat, makeChat())
}

/** A citation as a Markdown link, named by its title or its site. */
const sourceLink = (citation: Citation): string => {
  const name = Option.getOrElse(citation.title, () =>
    Option.getOrElse(
      Option.map(Option.liftThrowable(() => new URL(citation.url))(), (url) =>
        url.hostname.replace(/^www\./, ""),
      ),
      () => citation.url,
    ),
  )
  return `[${name.replaceAll("[", "(").replaceAll("]", ")")}](${citation.url})`
}

/** Such as `grok-4.7 · 3.2 s · Searched the web`. */
export const footerOf = (turn: ChatTurn): string =>
  Arr.join(
    [
      ...Option.toArray(turn.model),
      `${turn.seconds.toFixed(1)} s`,
      ...turn.toolsUsed,
      ...(turn.complete ? [] : ["The answer stopped early"]),
    ],
    " · ",
  )

/** A turn for the detail pane: the question, the answer, its sources, and a footer. */
export const turnMarkdown = (turn: ChatTurn): string =>
  Arr.join(
    [
      `**${turn.prompt.trim()}**`,
      turn.answer === "" ? "_Grok gave no answer._" : turn.answer,
      ...Arr.match(turn.citations, {
        onEmpty: () => [],
        onNonEmpty: (citations) => [
          `**Sources**\n\n${Arr.join(
            Arr.map(citations, (citation, index) => `${index + 1}. ${sourceLink(citation)}`),
            "\n",
          )}`,
        ],
      }),
      `_${footerOf(turn)}_`,
    ],
    "\n\n",
  )
