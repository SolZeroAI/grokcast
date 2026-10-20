// Raycast wiring for the Grok session: tokens in Raycast's encrypted OAuth store,
// the client ID from preferences.

import { getPreferenceValues, OAuth } from "@raycast/api"
import { DEFAULT_CLIENT_ID, discoverEndpoints, type OAuthEndpoints } from "./oauth.ts"
import { GrokSession, type StoredTokens, type TokenStore } from "./session.ts"

// Only the token store is used. Sign-in runs the device-code flow in `sign-in.tsx`,
// not `authorize()`, so the redirect method is never exercised.
const client = new OAuth.PKCEClient({
  redirectMethod: OAuth.RedirectMethod.Web,
  providerName: "Grok",
  providerIcon: "extension-icon.png",
  description: "Sign in with your Grok or X subscription.",
})

export const raycastTokenStore: TokenStore = {
  async load() {
    const tokens = await client.getTokens()
    if (!tokens?.accessToken) return undefined
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      expiresAt: tokens.updatedAt.getTime() + (tokens.expiresIn ?? 0) * 1000,
    }
  },
  async save(tokens: StoredTokens) {
    await client.setTokens({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      id_token: tokens.idToken,
      expires_in: Math.max(0, Math.round((tokens.expiresAt - Date.now()) / 1000)),
    })
  },
  async clear() {
    await client.removeTokens()
  },
}

export function clientId(): string {
  const { clientId } = getPreferenceValues<{ clientId?: string }>()
  return clientId?.trim() || DEFAULT_CLIENT_ID
}

let endpoints: Promise<OAuthEndpoints> | undefined

/** Discovery runs once per command. A failed discovery is retried on the next call. */
export function xaiEndpoints(): Promise<OAuthEndpoints> {
  endpoints ??= discoverEndpoints(fetch).catch((error: unknown) => {
    endpoints = undefined
    throw error
  })
  return endpoints
}

export function grokSession(): GrokSession {
  return new GrokSession(raycastTokenStore, xaiEndpoints, clientId())
}
