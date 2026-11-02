// What Grok did before it answered, in order: how long it thought, what it searched,
// which pages it read, and what code it ran. Built from the Responses API stream as it
// arrives, saved with the turn, and shown above the answer. No Raycast imports.

import type { OutputItem, ServerToolCall } from "@xai-official/sdk"
import * as Arr from "effect/Array"
import * as Bool from "effect/Boolean"
import * as Data from "effect/Data"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/** Grok reasoned. `text` is what xAI shared of it, and can be empty. */
export class Thought extends Schema.TaggedClass<Thought>()("Thought", {
  seconds: Schema.Finite,
  text: Schema.String,
}) {}

export const SearchTool = Schema.Literals(["web", "x"])

export type SearchTool = typeof SearchTool.Type

/** One or more searches in a row with the same tool, and the pages they found or opened. */
export class Search extends Schema.TaggedClass<Search>()("Search", {
  tool: SearchTool,
  queries: Schema.Array(Schema.String),
  pages: Schema.Array(Schema.String),
}) {}

/** Grok ran code with its code execution tool. */
export class RanCode extends Schema.TaggedClass<RanCode>()("RanCode", {
  code: Schema.String,
  output: Schema.String,
}) {}

/** Any other tool, in words for the user. */
export class UsedTool extends Schema.TaggedClass<UsedTool>()("UsedTool", {
  label: Schema.String,
}) {}

export const ChatStep = Schema.Union([Thought, Search, RanCode, UsedTool])

export type ChatStep = typeof ChatStep.Type

/** What Grok is doing now. `since` is Unix time in milliseconds. */
export type Activity = Data.TaggedEnum<{
  Thinking: { readonly since: number; readonly text: string }
  Working: { readonly label: string }
}>

export const Activity = Data.taggedEnum<Activity>()

/** The steps so far, and what Grok is doing now. */
export interface Trail {
  readonly steps: ReadonlyArray<ChatStep>
  readonly active: Option.Option<Activity>
}

export const emptyTrail: Trail = { steps: [], active: Option.none() }

/** Tool arguments xAI sends as JSON, such as `{"query": "…"}` or `{"url": "…"}`. */
const ToolInput = Schema.fromJsonString(
  Schema.Struct({
    query: Schema.optionalKey(Schema.String),
    url: Schema.optionalKey(Schema.String),
    code: Schema.optionalKey(Schema.String),
  }),
)

const decodeInput = Schema.decodeUnknownOption(ToolInput)

/** The trimmed text, or nothing when it is missing or blank. */
const nonEmpty = (text: Option.Option<string>): ReadonlyArray<string> =>
  Option.toArray(
    Option.filter(
      Option.map(text, (value) => value.trim()),
      (value) => value !== "",
    ),
  )

/** `value`, when it is set. */
const present = (value: string | null | undefined): ReadonlyArray<string> => nonEmpty(Option.fromNullishOr(value))

/** What a tool call is, before or after it runs. */
type CallKind = Data.TaggedEnum<{
  Search: { readonly tool: SearchTool; readonly queries: ReadonlyArray<string>; readonly pages: ReadonlyArray<string> }
  Code: { readonly code: string; readonly output: string }
  Other: { readonly label: string }
}>

const CallKind = Data.taggedEnum<CallKind>()

/** The arguments of a named tool call, or none when they are missing or not JSON. */
const argsOf = (input: Option.Option<string>): typeof ToolInput.Type =>
  Option.getOrElse(Option.flatMap(input, decodeInput), (): typeof ToolInput.Type => ({}))

const namedSearch = (tool: SearchTool, args: typeof ToolInput.Type): CallKind =>
  CallKind.Search({ tool, queries: present(args.query), pages: present(args.url) })

/** A named tool call: xAI sends X search, and on some models web search, as a custom tool. */
const namedCall = (name: string, args: typeof ToolInput.Type): CallKind =>
  Match.value(name).pipe(
    Match.when(
      (call) => call.startsWith("x_"),
      () => namedSearch("x", args),
    ),
    Match.when(
      (call) => call.startsWith("web_") || call.startsWith("browse"),
      () => namedSearch("web", args),
    ),
    Match.when(
      (call) => call.startsWith("code"),
      () => CallKind.Code({ code: args.code ?? "", output: "" }),
    ),
    Match.orElse((call) => CallKind.Other({ label: `Used ${call.replaceAll("_", " ")}` })),
  )

type WebSearchCall = Extract<ServerToolCall, { type: "web_search_call" }>

const pageSearch = (url: string): CallKind => CallKind.Search({ tool: "web", queries: [], pages: present(url) })

/** A web search, or a page Grok opened or searched. A call that has not run yet can arrive without an action. */
const webSearch = (call: WebSearchCall): CallKind =>
  Option.match(Option.fromNullishOr(call.action), {
    onNone: () => CallKind.Search({ tool: "web", queries: [], pages: [] }),
    onSome: (taken) =>
      Match.value(taken).pipe(
        Match.discriminatorsExhaustive("type")({
          search: (search) =>
            CallKind.Search({
              tool: "web",
              queries: present(search.query),
              pages: Arr.flatMap(search.sources ?? [], (source) => present(source.url)),
            }),
          open_page: (page) => pageSearch(page.url),
          find_in_page: (page) => pageSearch(page.url),
        }),
      ),
  })

type CodeCall = Extract<ServerToolCall, { type: "code_interpreter_call" }>

/** The logs a code run printed, one output after another. */
const logsOf = (call: CodeCall): string =>
  Arr.join(
    Arr.flatMap(call.outputs, (output) =>
      Match.value(output).pipe(
        Match.discriminatorsExhaustive("type")({
          logs: (logs) => [logs.logs],
          image: () => [],
        }),
      ),
    ),
    "\n",
  )

const kindOf = (call: ServerToolCall): CallKind =>
  Match.value(call).pipe(
    Match.when({ type: "web_search_call" }, webSearch),
    Match.when({ type: "x_search_call" }, (search) =>
      namedCall(`x_${search.name}`, argsOf(Option.some(search.arguments))),
    ),
    Match.when({ type: "custom_tool_call" }, (custom) =>
      namedCall(custom.name, argsOf(Option.fromNullishOr(custom.input))),
    ),
    Match.when({ type: "code_interpreter_call" }, (code) =>
      CallKind.Code({ code: code.code ?? "", output: logsOf(code) }),
    ),
    Match.when({ type: "file_search_call" }, () => CallKind.Other({ label: "Searched files" })),
    Match.when({ type: "mcp_call" }, () => CallKind.Other({ label: "Used a connected tool" })),
    Match.when({ type: "image_generation_call" }, () => CallKind.Other({ label: "Made an image" })),
    Match.orElse(() => CallKind.Other({ label: "Used a tool" })),
  )

const SERVER_TOOL_TYPES: ReadonlyArray<string> = [
  "web_search_call",
  "x_search_call",
  "custom_tool_call",
  "code_interpreter_call",
  "file_search_call",
  "mcp_call",
  "tool_search_call",
  "image_generation_call",
]

/** The item as a server tool call, when it is one. */
export const serverToolCall = (item: OutputItem): Option.Option<ServerToolCall> =>
  Option.map(
    Option.liftPredicate(item, (output) => SERVER_TOOL_TYPES.includes(output.type)),
    // SAFETY: `ServerToolCall` is the union of the output items with these `type`s, as the SDK's own `isServerToolCall` checks.
    (output) => output as ServerToolCall,
  )

const searchPlace = (tool: SearchTool): string =>
  Match.value(tool).pipe(
    Match.when("x", () => "X"),
    Match.when("web", () => "the web"),
    Match.exhaustive,
  )

/** What Grok is doing while a tool call runs, such as "Searching the web". */
export const runningLabel = (call: ServerToolCall): string =>
  CallKind.$match(kindOf(call), {
    Search: (search) => `Searching ${searchPlace(search.tool)}`,
    Code: () => "Running code",
    Other: () => "Using a tool",
  })

/** The thought in progress, if Grok is thinking. */
const thinkingOf = (trail: Trail) => Option.filter(trail.active, Activity.$is("Thinking"))

/** Thoughts in a row become one, and so do searches in a row with the same tool. */
const isThought = Schema.is(Thought)

const isSearch = Schema.is(Search)

const mergeSteps = (first: ChatStep, second: ChatStep): Option.Option<ChatStep> =>
  Match.value(first).pipe(
    Match.tag("Thought", (earlier) =>
      Option.map(
        Option.liftPredicate(second, isThought),
        (later): ChatStep =>
          new Thought({
            seconds: earlier.seconds + later.seconds,
            text: Arr.join([...present(earlier.text), ...present(later.text)], "\n\n"),
          }),
      ),
    ),
    Match.tag("Search", (earlier) =>
      Option.map(
        Option.filter(Option.liftPredicate(second, isSearch), (later) => later.tool === earlier.tool),
        (later): ChatStep =>
          new Search({
            tool: earlier.tool,
            queries: Arr.dedupe([...earlier.queries, ...later.queries]),
            pages: Arr.dedupe([...earlier.pages, ...later.pages]),
          }),
      ),
    ),
    Match.orElse(() => Option.none()),
  )

const appendStep = (steps: ReadonlyArray<ChatStep>, step: ChatStep): ReadonlyArray<ChatStep> =>
  Option.match(
    Option.flatMap(Arr.last(steps), (last) => mergeSteps(last, step)),
    {
      onNone: () => Arr.append(steps, step),
      onSome: (both) => Arr.append(Arr.dropRight(steps, 1), both),
    },
  )

/** The steps with the thought in progress, if any, closed at `now`. */
const closedSteps = (trail: Trail, now: number): ReadonlyArray<ChatStep> =>
  Option.match(thinkingOf(trail), {
    onNone: () => trail.steps,
    onSome: (thinking) =>
      appendStep(
        trail.steps,
        new Thought({ seconds: Math.max(0, (now - thinking.since) / 1000), text: thinking.text }),
      ),
  })

/** Close the thought in progress, if any, at `now`, and stop any other activity. */
export const finishThinking = (trail: Trail, now: number): Trail => ({
  steps: closedSteps(trail, now),
  active: Option.none(),
})

/** Thinking that started at `now` with `delta`, or the thought in progress with `delta` added. */
const thinkingWith = (trail: Trail, delta: string, now: number): Activity =>
  Option.match(thinkingOf(trail), {
    onNone: () => Activity.Thinking({ since: now, text: delta }),
    onSome: (thinking) => Activity.Thinking({ since: thinking.since, text: thinking.text + delta }),
  })

/** Grok started reasoning, or sent more of its reasoning. */
export const think = (trail: Trail, delta: string, now: number): Trail => ({
  steps: trail.steps,
  active: Option.some(thinkingWith(trail, delta, now)),
})

/** A tool call started. */
export const startTool = (trail: Trail, call: ServerToolCall, now: number): Trail => ({
  steps: finishThinking(trail, now).steps,
  active: Option.some(Activity.Working({ label: runningLabel(call) })),
})

const stepOf = (call: ServerToolCall): ChatStep =>
  CallKind.$match(kindOf(call), {
    Search: (search): ChatStep => new Search({ tool: search.tool, queries: search.queries, pages: search.pages }),
    Code: (code): ChatStep => new RanCode({ code: code.code, output: code.output }),
    Other: (other): ChatStep => new UsedTool({ label: other.label }),
  })

/** A tool call finished. */
export const finishTool = (trail: Trail, call: ServerToolCall, now: number): Trail => ({
  steps: appendStep(finishThinking(trail, now).steps, stepOf(call)),
  active: Option.none(),
})

/** Grok started writing the answer, or the response ended. The same trail when nothing was in progress. */
export const settle = (trail: Trail, now: number): Trail =>
  Option.match(trail.active, { onNone: () => trail, onSome: () => finishThinking(trail, now) })

/** Such as "1 min 5 s", for at least a minute. */
const minutesLabel = (whole: number): string =>
  Bool.match(whole % 60 === 0, {
    onTrue: () => `${Math.floor(whole / 60)} min`,
    onFalse: () => `${Math.floor(whole / 60)} min ${whole % 60} s`,
  })

/** Such as "4 s" or "1 min 5 s". Under a second rounds up, so a thought never reads "0 s". */
export const durationLabel = (seconds: number): string =>
  Option.match(
    Option.liftPredicate(Math.max(1, Math.round(seconds)), (whole) => whole >= 60),
    {
      onNone: () => `${Math.max(1, Math.round(seconds))} s`,
      onSome: minutesLabel,
    },
  )

/** A step's title, such as "Thought for 4 s" or "Searched the web". */
export const stepTitle = (step: ChatStep): string =>
  Match.value(step).pipe(
    Match.tagsExhaustive({
      Thought: (thought) => `Thought for ${durationLabel(thought.seconds)}`,
      Search: (search) => `Searched ${searchPlace(search.tool)}`,
      RanCode: () => "Ran code",
      UsedTool: (tool) => tool.label,
    }),
  )

/** What Grok is doing now, such as "Thinking for 3 s" or "Searching the web". */
export const activityTitle = (activity: Activity, now: number): string =>
  Activity.$match(activity, {
    Thinking: (thinking) => `Thinking for ${durationLabel((now - thinking.since) / 1000)}`,
    Working: (working) => working.label,
  })

/** The site of `url` without `www.`, or the URL itself when it does not parse. */
export const siteOf = (url: string): string =>
  Option.getOrElse(
    Option.map(Option.liftThrowable(() => new URL(url))(), (parsed) => parsed.hostname.replace(/^www\./, "")),
    () => url,
  )

/**
 * The site's icon, from the same Google service that Raycast's `getFavicon` uses.
 * Only the site's domain is sent, never the page.
 */
export const faviconUrl = (url: string, size = 64): Option.Option<string> =>
  Option.map(
    Option.filter(Option.liftThrowable(() => new URL(url))(), (parsed) =>
      ["http:", "https:"].includes(parsed.protocol),
    ),
    (parsed) => `https://www.google.com/s2/favicons?sz=${size}&domain=${encodeURIComponent(parsed.hostname)}`,
  )

/** A favicon small enough to sit in a line of text, or nothing for a URL that is not a web page. */
export const faviconMarkdown = (url: string): string =>
  Option.match(faviconUrl(url, 32), {
    onNone: () => "",
    onSome: (icon) => `![${escapeLabel(siteOf(url))}](${icon}&raycast-width=14&raycast-height=14)`,
  })

/** Text that is safe inside a Markdown link label. */
export const escapeLabel = (text: string): string => text.replaceAll("[", "(").replaceAll("]", ")")

/** How many site icons a search shows before "+N". */
const FAVICONS_SHOWN = 6

/** Such as "1 page" or "3 pages". */
export const pagesLabel = (count: number): string =>
  Bool.match(count === 1, { onTrue: () => "1 page", onFalse: () => `${count} pages` })

const quoted = (queries: ReadonlyArray<string>): string =>
  Arr.join(
    Arr.map(queries, (query) => `“${query.replaceAll("*", "\\*").replaceAll("_", "\\_")}”`),
    ", ",
  )

/** The site icons of a search's pages, one per site, then "+N" for the rest. */
const siteIcons = (pages: ReadonlyArray<string>): string =>
  Arr.join(
    [
      ...Arr.map(
        Arr.take(
          Arr.dedupeWith(pages, (first, second) => siteOf(first) === siteOf(second)),
          FAVICONS_SHOWN,
        ),
        faviconMarkdown,
      ),
      ...Option.toArray(
        Option.map(
          Option.liftPredicate(
            Arr.dedupeWith(pages, (first, second) => siteOf(first) === siteOf(second)).length - FAVICONS_SHOWN,
            (more) => more > 0,
          ),
          (more) => `+${more}`,
        ),
      ),
    ],
    " ",
  )

const searchLine = (search: Search): string =>
  Arr.join(
    [
      `**${stepTitle(search)}**`,
      ...Arr.map(Arr.filter([search.queries], Arr.isReadonlyArrayNonEmpty), (queries) => `for ${quoted(queries)}`),
      ...Arr.map(
        Arr.filter([search.pages], Arr.isReadonlyArrayNonEmpty),
        (pages) => `· ${siteIcons(pages)} ${pagesLabel(pages.length)}`,
      ),
    ],
    " ",
  )

/** One line for a step in the trail above the answer. */
const stepLine = (step: ChatStep): string =>
  Match.value(step).pipe(
    Match.tag("Search", searchLine),
    Match.orElse((other) => `**${stepTitle(other)}**`),
  )

/**
 * The steps as a quote above the answer, in order, with what Grok is doing now last.
 * Empty when there is nothing to show.
 */
export const trailMarkdown = (
  steps: ReadonlyArray<ChatStep>,
  active: Option.Option<Activity> = Option.none(),
  now = 0,
): string =>
  Arr.join(
    Arr.map(
      [
        ...Arr.map(steps, stepLine),
        ...Option.toArray(Option.map(active, (current) => `_${activityTitle(current, now)}…_`)),
      ],
      (line) => `> ${line}`,
    ),
    "\n>\n",
  )
