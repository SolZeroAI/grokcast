import assert from "node:assert/strict"
import { describe, it } from "node:test"
import * as Option from "effect/Option"
import {
  Activity,
  durationLabel,
  emptyTrail,
  faviconUrl,
  finishTool,
  RanCode,
  Search,
  settle,
  startTool,
  think,
  Thought,
  trailMarkdown,
  UsedTool,
} from "../src/lib/chat-steps.ts"

const webSearch = (query: string) =>
  ({ type: "web_search_call", id: query, action: { type: "search", query } }) as const

describe("chat steps", () => {
  it("times a thought from its start to the next step, and joins thoughts in a row", () => {
    const started = think(emptyTrail, "", 1_000)
    const more = think(started, "Hmm.", 2_000)
    assert.deepEqual(more.active, Option.some(Activity.Thinking({ since: 1_000, text: "Hmm." })))
    const searching = startTool(more, webSearch("a"), 5_500)
    assert.deepEqual(searching.steps, [new Thought({ seconds: 4.5, text: "Hmm." })])
    assert.deepEqual(searching.active, Option.some(Activity.Working({ label: "Searching the web" })))
    const searched = finishTool(searching, webSearch("a"), 6_000)
    const again = settle(think(think(searched, "One.", 7_000), "", 8_000), 9_000)
    const twice = settle(think(again, "Two.", 9_000), 10_000)
    assert.deepEqual(twice.steps, [
      new Thought({ seconds: 4.5, text: "Hmm." }),
      new Search({ tool: "web", queries: ["a"], pages: [] }),
      new Thought({ seconds: 3, text: "One.\n\nTwo." }),
    ])
    assert.equal(Option.isNone(twice.active), true)
  })

  it("keeps code it ran with the output, and names other tools", () => {
    const trail = finishTool(
      finishTool(
        emptyTrail,
        {
          type: "code_interpreter_call",
          id: "c",
          code: "print(1)",
          outputs: [{ type: "logs", logs: "1" }],
        },
        0,
      ),
      { type: "mcp_call", id: "m", name: "x", server_label: "s", arguments: "{}", output: "" },
      0,
    )

    assert.deepEqual(trail.steps, [
      new RanCode({ code: "print(1)", output: "1" }),
      new UsedTool({ label: "Used a connected tool" }),
    ])
  })

  it("reads web search calls that come as custom tools, with bad input left out", () => {
    const browse = finishTool(
      emptyTrail,
      {
        type: "custom_tool_call",
        id: "b",
        call_id: "b",
        name: "browse_page",
        input: '{"url":"https://example.com/a"}',
      },
      0,
    )

    const broken = finishTool(
      browse,
      { type: "custom_tool_call", id: "w", call_id: "w", name: "web_search", input: "{not json" },
      0,
    )

    assert.deepEqual(broken.steps, [new Search({ tool: "web", queries: [], pages: ["https://example.com/a"] })])
  })

  it("rounds durations for people", () => {
    assert.equal(durationLabel(0.2), "1 s")
    assert.equal(durationLabel(4.4), "4 s")
    assert.equal(durationLabel(60), "1 min")
    assert.equal(durationLabel(125), "2 min 5 s")
  })

  it("shows the trail with site icons, at most six, and what Grok is doing now", () => {
    const pages = [1, 2, 3, 4, 5, 6, 7].map((n) => `https://site${n}.example/page`)

    const markdown = trailMarkdown(
      [new Search({ tool: "x", queries: ["a_b"], pages })],
      Option.some(Activity.Thinking({ since: 1_000, text: "" })),
      4_000,
    )

    const [search, now] = markdown.split("\n>\n")
    assert.match(search ?? "", /^> \*\*Searched X\*\* for “a\\_b” · !\[site1\.example\]/)
    assert.equal((search?.match(/!\[/g) ?? []).length, 6)
    assert.match(search ?? "", / \+1 7 pages$/)
    assert.equal(now, "> _Thinking for 3 s…_")
    assert.equal(trailMarkdown([]), "")
  })

  it("asks for a favicon by domain only, and only for web pages", () => {
    assert.deepEqual(
      faviconUrl("https://news.example.com/a?secret=1"),
      Option.some("https://www.google.com/s2/favicons?sz=64&domain=news.example.com"),
    )
    assert.deepEqual(faviconUrl("file:///etc/hosts"), Option.none())
    assert.deepEqual(faviconUrl("not a url"), Option.none())
  })
})
