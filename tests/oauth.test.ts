import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  DEFAULT_CLIENT_ID,
  discoverEndpoints,
  emailFromIdToken,
  isXaiUrl,
  OAuthError,
  pollDeviceToken,
  refreshTokens,
  requestDeviceCode,
  revokeToken,
  XAI_SCOPES,
  type DeviceCode,
} from "../src/lib/oauth.ts"
import { endpoints, fakeFetch, json } from "./support.ts"

const device: DeviceCode = {
  deviceCode: "device-123",
  userCode: "ABCD-EFGH",
  verificationUri: "https://accounts.x.ai/oauth2/device",
  verificationUriComplete: undefined,
  expiresIn: 1800,
  interval: 5,
}

describe("isXaiUrl", () => {
  it("accepts HTTPS on x.ai and its subdomains", () => {
    assert.equal(isXaiUrl("https://auth.x.ai/oauth2/token"), true)
    assert.equal(isXaiUrl("https://x.ai/"), true)
  })

  it("rejects other hosts, look-alikes, and plain HTTP", () => {
    assert.equal(isXaiUrl("http://auth.x.ai/oauth2/token"), false)
    assert.equal(isXaiUrl("https://auth.x.ai.example.com/token"), false)
    assert.equal(isXaiUrl("https://evilx.ai/token"), false)
    assert.equal(isXaiUrl("not a url"), false)
  })
})

describe("discoverEndpoints", () => {
  it("reads the endpoints from the OpenID configuration", async () => {
    const { fetch, requests } = fakeFetch(() =>
      json({
        device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
        token_endpoint: "https://auth.x.ai/oauth2/token",
        revocation_endpoint: "https://auth.x.ai/oauth2/revoke",
      }),
    )
    assert.deepEqual(await discoverEndpoints(fetch), endpoints)
    assert.equal(requests[0]?.url, "https://auth.x.ai/.well-known/openid-configuration")
  })

  it("refuses an endpoint outside x.ai, so a token is never sent there", async () => {
    const { fetch } = fakeFetch(() =>
      json({
        device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
        token_endpoint: "https://attacker.example.com/token",
      }),
    )
    await assert.rejects(discoverEndpoints(fetch), { code: "invalid_discovery" })
  })
})

describe("requestDeviceCode", () => {
  it("sends the client ID, the scopes, and the referrer", async () => {
    const { fetch, requests } = fakeFetch(() =>
      json({
        device_code: "device-123",
        user_code: "ABCD-EFGH",
        verification_uri: "https://accounts.x.ai/oauth2/device",
        expires_in: 1800,
        interval: 5,
      }),
    )
    const result = await requestDeviceCode(fetch, endpoints, DEFAULT_CLIENT_ID)
    assert.deepEqual(result, device)
    const form = new URLSearchParams(requests[0]?.body)
    assert.equal(form.get("client_id"), DEFAULT_CLIENT_ID)
    assert.equal(form.get("scope"), XAI_SCOPES)
    assert.equal(form.get("referrer"), "grok-voice")
  })

  it("returns the OAuth error code from a refused request", async () => {
    const { fetch } = fakeFetch(() => json({ error: "invalid_client" }, 401))
    await assert.rejects(requestDeviceCode(fetch, endpoints, "bad"), {
      code: "invalid_client",
      status: 401,
    })
  })
})

describe("pollDeviceToken", () => {
  it("waits while authorization is pending, backs off on slow_down, then returns the tokens", async () => {
    const waits: number[] = []
    const { fetch, requests } = fakeFetch((_request, index) => {
      if (index === 0) return json({ error: "authorization_pending" }, 400)
      if (index === 1) return json({ error: "slow_down" }, 400)
      return json({ access_token: "access", refresh_token: "refresh", expires_in: 21600 })
    })
    const tokens = await pollDeviceToken(fetch, endpoints, "client", device, async (ms) => {
      waits.push(ms)
    })
    assert.deepEqual(waits, [5000, 5000, 10000])
    assert.equal(tokens.access_token, "access")
    assert.equal(tokens.refresh_token, "refresh")
    assert.equal(tokens.expires_in, 21600)
    const form = new URLSearchParams(requests[2]?.body)
    assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code")
    assert.equal(form.get("device_code"), "device-123")
  })

  it("stops when the user declines", async () => {
    const { fetch } = fakeFetch(() => json({ error: "access_denied" }, 400))
    await assert.rejects(
      pollDeviceToken(fetch, endpoints, "client", device, async () => {}),
      { code: "access_denied" },
    )
  })

  it("stops when the code's lifetime has passed", async () => {
    let clock = 0
    const { fetch } = fakeFetch(() => json({ error: "authorization_pending" }, 400))
    await assert.rejects(
      pollDeviceToken(
        fetch,
        endpoints,
        "client",
        { ...device, expiresIn: 10 },
        async (ms) => {
          clock += ms
        },
        undefined,
        () => clock,
      ),
      { code: "expired_token" },
    )
  })

  it("stops when the signal aborts", async () => {
    const abort = new AbortController()
    abort.abort(new Error("closed"))
    const { fetch } = fakeFetch(() => json({ error: "authorization_pending" }, 400))
    await assert.rejects(
      pollDeviceToken(fetch, endpoints, "client", device, undefined, abort.signal),
      /closed/,
    )
  })
})

describe("refreshTokens", () => {
  it("sends a refresh_token grant", async () => {
    const { fetch, requests } = fakeFetch(() =>
      json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 21600 }),
    )
    const tokens = await refreshTokens(fetch, endpoints, "client", "old-refresh")
    assert.equal(tokens.refresh_token, "new-refresh")
    const form = new URLSearchParams(requests[0]?.body)
    assert.equal(form.get("grant_type"), "refresh_token")
    assert.equal(form.get("refresh_token"), "old-refresh")
  })

  it("reports invalid_grant for a spent refresh token", async () => {
    const { fetch } = fakeFetch(() => json({ error: "invalid_grant" }, 400))
    const error = await refreshTokens(fetch, endpoints, "client", "spent").catch(
      (caught: unknown) => caught,
    )
    assert.ok(error instanceof OAuthError)
    assert.equal(error.code, "invalid_grant")
  })

  it("rejects a response with no access token", async () => {
    const { fetch } = fakeFetch(() => json({ token_type: "Bearer" }))
    await assert.rejects(refreshTokens(fetch, endpoints, "client", "refresh"), {
      code: "invalid_token_response",
    })
  })
})

describe("revokeToken", () => {
  it("posts the token to the revocation endpoint", async () => {
    const { fetch, requests } = fakeFetch(() => new Response(null, { status: 200 }))
    await revokeToken(fetch, endpoints, "client", "refresh")
    assert.equal(requests[0]?.url, endpoints.revocation)
    assert.equal(new URLSearchParams(requests[0]?.body).get("token"), "refresh")
  })

  it("does nothing when the server has no revocation endpoint", async () => {
    const { fetch, requests } = fakeFetch(() => new Response(null, { status: 200 }))
    await revokeToken(fetch, { ...endpoints, revocation: undefined }, "client", "refresh")
    assert.equal(requests.length, 0)
  })
})

describe("emailFromIdToken", () => {
  it("reads the email claim", () => {
    const payload = Buffer.from(JSON.stringify({ email: "me@example.com" })).toString("base64url")
    assert.equal(emailFromIdToken(`header.${payload}.signature`), "me@example.com")
  })

  it("returns undefined for a missing or malformed token", () => {
    assert.equal(emailFromIdToken(undefined), undefined)
    assert.equal(emailFromIdToken("not-a-jwt"), undefined)
    assert.equal(emailFromIdToken("a.%%%.c"), undefined)
  })
})
