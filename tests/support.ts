import type { FetchFn, OAuthEndpoints } from "../src/lib/oauth.ts"
import type { StoredTokens, TokenStore } from "../src/lib/session.ts"

export const endpoints: OAuthEndpoints = {
  deviceAuthorization: "https://auth.x.ai/oauth2/device/code",
  token: "https://auth.x.ai/oauth2/token",
  revocation: "https://auth.x.ai/oauth2/revoke",
}

export interface Recorded {
  url: string
  method: string
  headers: Headers
  body: string
}

/** A fake `fetch` that records each request and answers from `respond`. */
export function fakeFetch(respond: (request: Recorded, index: number) => Response): {
  fetch: FetchFn
  requests: Recorded[]
} {
  const requests: Recorded[] = []
  const fetchFn: FetchFn = async (input, init) => {
    const request = new Request(input, init)
    const recorded = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: await request.text(),
    }
    requests.push(recorded)
    return respond(recorded, requests.length - 1)
  }
  return { fetch: fetchFn, requests }
}

export function json(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

export function memoryStore(
  initial?: StoredTokens,
): TokenStore & { current: StoredTokens | undefined } {
  const store = {
    current: initial,
    async load() {
      return store.current
    },
    async save(tokens: StoredTokens) {
      store.current = tokens
    },
    async clear() {
      store.current = undefined
    },
  }
  return store
}
