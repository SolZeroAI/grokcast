import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  GrokSession,
  NotSignedInError,
  REFRESH_MARGIN_MS,
  toStoredTokens,
  type StoredTokens,
} from "../src/lib/session.ts"
import { endpoints, fakeFetch, json, memoryStore } from "./support.ts"

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

function tokens(accessToken: string, refreshToken: string, expiresAt: number): StoredTokens {
  return { accessToken, refreshToken, idToken: undefined, expiresAt }
}

function session(
  store: ReturnType<typeof memoryStore>,
  fetchFn: ReturnType<typeof fakeFetch>["fetch"],
) {
  return new GrokSession(
    store,
    async () => endpoints,
    "client",
    fetchFn,
    () => NOW,
  )
}

describe("toStoredTokens", () => {
  it("stores the rotated refresh token", () => {
    const stored = toStoredTokens(
      { access_token: "a2", refresh_token: "r2", expires_in: 21600 },
      NOW,
      tokens("a1", "r1", NOW),
    )
    assert.deepEqual(stored, tokens("a2", "r2", NOW + 21600 * 1000))
  })

  it("keeps the previous refresh token when the response has none", () => {
    const stored = toStoredTokens(
      { access_token: "a2", expires_in: 60 },
      NOW,
      tokens("a1", "r1", NOW),
    )
    assert.equal(stored.refreshToken, "r1")
  })
})

describe("GrokSession.accessToken", () => {
  it("returns the stored token while it is fresh", async () => {
    const store = memoryStore(tokens("a1", "r1", NOW + HOUR))
    const { fetch, requests } = fakeFetch(() => json({}))
    assert.equal(await session(store, fetch).accessToken(), "a1")
    assert.equal(requests.length, 0)
  })

  it("refreshes within five minutes of expiry and saves the rotated tokens", async () => {
    const store = memoryStore(tokens("a1", "r1", NOW + REFRESH_MARGIN_MS - 1))
    const { fetch } = fakeFetch(() =>
      json({ access_token: "a2", refresh_token: "r2", expires_in: 21600 }),
    )
    assert.equal(await session(store, fetch).accessToken(), "a2")
    assert.deepEqual(store.current, tokens("a2", "r2", NOW + 21600 * 1000))
  })

  it("throws NotSignedInError with no stored tokens", async () => {
    const { fetch } = fakeFetch(() => json({}))
    await assert.rejects(session(memoryStore(), fetch).accessToken(), NotSignedInError)
  })

  it("shares one refresh between concurrent callers", async () => {
    const store = memoryStore(tokens("a1", "r1", NOW))
    const { fetch, requests } = fakeFetch(() =>
      json({ access_token: "a2", refresh_token: "r2", expires_in: 21600 }),
    )
    const grok = session(store, fetch)
    const results = await Promise.all([grok.accessToken(), grok.accessToken(), grok.accessToken()])
    assert.deepEqual(results, ["a2", "a2", "a2"])
    assert.equal(requests.length, 1)
  })

  it("uses tokens another command already refreshed when its own refresh token was spent", async () => {
    const store = memoryStore(tokens("a1", "r1", NOW))
    const { fetch } = fakeFetch(() => {
      // Another process refreshed first and saved r2, so r1 is now spent.
      store.current = tokens("a2", "r2", NOW + 6 * HOUR)
      return json({ error: "invalid_grant" }, 400)
    })
    assert.equal(await session(store, fetch).accessToken(), "a2")
  })

  it("clears the sign-in when the refresh token is rejected", async () => {
    const store = memoryStore(tokens("a1", "r1", NOW))
    const { fetch } = fakeFetch(() => json({ error: "invalid_grant" }, 400))
    await assert.rejects(session(store, fetch).accessToken(), NotSignedInError)
    assert.equal(store.current, undefined)
  })

  it("keeps the sign-in on a network or server error", async () => {
    const store = memoryStore(tokens("a1", "r1", NOW))
    const { fetch } = fakeFetch(() => json({ error: "server_error" }, 503))
    await assert.rejects(session(store, fetch).accessToken(), { code: "server_error" })
    assert.equal(store.current?.refreshToken, "r1")
  })
})

describe("GrokSession.fetch", () => {
  it("sets the bearer token and keeps the request", async () => {
    const store = memoryStore(tokens("a1", "r1", NOW + HOUR))
    const { fetch, requests } = fakeFetch(() => json({ text: "hello" }))
    const response = await session(store, fetch).fetch("https://api.x.ai/v1/stt", {
      method: "POST",
      headers: { "x-test": "yes" },
      body: "audio",
    })
    assert.equal(response.status, 200)
    assert.equal(requests[0]?.headers.get("authorization"), "Bearer a1")
    assert.equal(requests[0]?.headers.get("x-test"), "yes")
    assert.equal(requests[0]?.body, "audio")
  })

  it("accepts a Request, as the xAI SDK passes one", async () => {
    const store = memoryStore(tokens("a1", "r1", NOW + HOUR))
    const { fetch, requests } = fakeFetch(() => json({}))
    await session(store, fetch).fetch(
      new Request("https://api.x.ai/v1/tts", { method: "POST", body: "{}" }),
    )
    assert.equal(requests[0]?.method, "POST")
    assert.equal(requests[0]?.headers.get("authorization"), "Bearer a1")
  })

  it("refreshes once on a 401 and retries with the same body", async () => {
    const store = memoryStore(tokens("a1", "r1", NOW + HOUR))
    const { fetch, requests } = fakeFetch((request) => {
      if (request.url.endsWith("/oauth2/token")) {
        return json({ access_token: "a2", refresh_token: "r2", expires_in: 21600 })
      }
      return request.headers.get("authorization") === "Bearer a2"
        ? json({ ok: true })
        : json({ error: "unauthorized" }, 401)
    })
    const response = await session(store, fetch).fetch("https://api.x.ai/v1/stt", {
      method: "POST",
      body: "audio",
    })
    assert.equal(response.status, 200)
    assert.deepEqual(
      requests.map((request) => request.url),
      ["https://api.x.ai/v1/stt", endpoints.token, "https://api.x.ai/v1/stt"],
    )
    assert.equal(requests[2]?.body, "audio")
  })
})

describe("GrokSession.signOut", () => {
  it("revokes the refresh token and clears local tokens", async () => {
    const store = memoryStore(tokens("a1", "r1", NOW + HOUR))
    const { fetch, requests } = fakeFetch(() => new Response(null, { status: 200 }))
    assert.equal(await session(store, fetch).signOut(), true)
    assert.equal(new URLSearchParams(requests[0]?.body).get("token"), "r1")
    assert.equal(store.current, undefined)
  })

  it("clears local tokens even when the revoke fails", async () => {
    const store = memoryStore(tokens("a1", "r1", NOW + HOUR))
    const { fetch } = fakeFetch(() => json({ error: "server_error" }, 500))
    await assert.rejects(session(store, fetch).signOut())
    assert.equal(store.current, undefined)
  })

  it("returns false when nobody is signed in", async () => {
    const { fetch } = fakeFetch(() => json({}))
    assert.equal(await session(memoryStore(), fetch).signOut(), false)
  })
})
