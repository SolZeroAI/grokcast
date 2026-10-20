// The signed-in Grok session: keeps the access token fresh and signs requests to
// api.x.ai. No Raycast imports, so tests run it under plain Node.

import {
  OAuthError,
  refreshTokens,
  revokeToken,
  type FetchFn,
  type OAuthEndpoints,
  type TokenResponse,
} from "./oauth.ts"

/** Refresh this long before the access token expires. */
export const REFRESH_MARGIN_MS = 5 * 60_000

export interface StoredTokens {
  accessToken: string
  refreshToken: string | undefined
  idToken: string | undefined
  /** Unix time in milliseconds. */
  expiresAt: number
}

/** Where the tokens live. The extension uses Raycast's encrypted OAuth token store. */
export interface TokenStore {
  load(): Promise<StoredTokens | undefined>
  save(tokens: StoredTokens): Promise<void>
  clear(): Promise<void>
}

/** Thrown when there is no usable sign-in. The UI tells the user to run Sign in to Grok. */
export class NotSignedInError extends Error {
  constructor(message = "Not signed in to Grok. Run Sign in to Grok first.") {
    super(message)
    this.name = "NotSignedInError"
  }
}

/**
 * Convert a token response for storage. xAI rotates the refresh token on every
 * refresh, so a new one always replaces the old one. The old one is kept only when
 * the response has none.
 */
export function toStoredTokens(
  response: TokenResponse,
  now: number,
  previous?: StoredTokens,
): StoredTokens {
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? previous?.refreshToken,
    idToken: response.id_token ?? previous?.idToken,
    expiresAt: now + (response.expires_in ?? 0) * 1000,
  }
}

export function needsRefresh(tokens: StoredTokens, now: number): boolean {
  return tokens.expiresAt - REFRESH_MARGIN_MS <= now
}

export class GrokSession {
  private refreshing: Promise<StoredTokens> | undefined

  constructor(
    private readonly store: TokenStore,
    private readonly endpoints: () => Promise<OAuthEndpoints>,
    private readonly clientId: string,
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** A current access token, refreshed first when it is within five minutes of expiry. */
  async accessToken(): Promise<string> {
    const tokens = await this.store.load()
    if (!tokens) throw new NotSignedInError()
    if (!needsRefresh(tokens, this.now())) return tokens.accessToken
    return (await this.refresh(tokens.accessToken)).accessToken
  }

  /**
   * Refresh the tokens. Concurrent callers in this process share one refresh, because
   * a rotated refresh token can be spent only once. If another command already
   * refreshed (the stored access token is no longer `staleAccessToken` and is fresh),
   * that result is used instead of refreshing again.
   */
  refresh(staleAccessToken: string): Promise<StoredTokens> {
    this.refreshing ??= this.runRefresh(staleAccessToken).finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async runRefresh(staleAccessToken: string): Promise<StoredTokens> {
    const current = await this.store.load()
    if (!current) throw new NotSignedInError()
    if (current.accessToken !== staleAccessToken && !needsRefresh(current, this.now())) {
      return current
    }
    if (!current.refreshToken) {
      await this.store.clear()
      throw new NotSignedInError("The Grok sign-in expired. Run Sign in to Grok again.")
    }
    try {
      const response = await refreshTokens(
        this.fetchFn,
        await this.endpoints(),
        this.clientId,
        current.refreshToken,
      )
      const next = toStoredTokens(response, this.now(), current)
      await this.store.save(next)
      return next
    } catch (error) {
      if (!(error instanceof OAuthError) || error.code !== "invalid_grant") throw error
      // Another process may have spent this refresh token and saved a new one.
      const latest = await this.store.load()
      if (
        latest &&
        latest.refreshToken !== current.refreshToken &&
        !needsRefresh(latest, this.now())
      ) {
        return latest
      }
      await this.store.clear()
      throw new NotSignedInError("The Grok sign-in expired. Run Sign in to Grok again.")
    }
  }

  /**
   * A `fetch` for the xAI SDK. It sets the bearer token on each request, and on a 401
   * it refreshes once and retries. Pass it as `new SpaceXAI({ apiKey, fetch })`.
   */
  readonly fetch: FetchFn = async (input, init) => {
    const request = new Request(input, init)
    const retry = request.clone()
    const token = await this.accessToken()
    const response = await this.fetchFn(withBearer(request, token))
    if (response.status !== 401) return response
    await response.body?.cancel()
    const fresh = await this.refresh(token)
    return this.fetchFn(withBearer(retry, fresh.accessToken))
  }

  /** Revoke the refresh token at xAI, then clear local tokens. Local tokens are cleared even if the revoke fails. */
  async signOut(): Promise<boolean> {
    const tokens = await this.store.load()
    if (!tokens) return false
    try {
      await revokeToken(
        this.fetchFn,
        await this.endpoints(),
        this.clientId,
        tokens.refreshToken ?? tokens.accessToken,
      )
    } finally {
      await this.store.clear()
    }
    return true
  }
}

function withBearer(request: Request, token: string): Request {
  const headers = new Headers(request.headers)
  headers.set("authorization", `Bearer ${token}`)
  return new Request(request, { headers })
}
