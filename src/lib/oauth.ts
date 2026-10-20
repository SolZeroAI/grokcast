// xAI OAuth for a Grok or X subscription. This module has no Raycast imports, so
// tests run it under plain Node.

/** The xAI OAuth issuer. Grok Build signs in here too. */
export const XAI_ISSUER = "https://auth.x.ai"

/**
 * Grok Build's public OAuth client. xAI has no third-party client registration
 * yet, so Hermes, OpenCode and others reuse this ID. Users can override it in the
 * extension preferences.
 */
export const DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"

/** `api:access` is what lets the token call `api.x.ai`. Without it, sign-in works and API calls fail. */
export const XAI_SCOPES = "openid profile email offline_access grok-cli:access api:access"

/** Sent with each authorization request so xAI can attribute traffic to this extension. */
export const REFERRER = "grok-voice"

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>

export interface OAuthEndpoints {
  deviceAuthorization: string
  token: string
  revocation: string | undefined
}

export interface TokenResponse {
  access_token: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
  scope?: string
  token_type?: string
}

export interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  /** The verification URL with the code already filled in, when the server sends one. */
  verificationUriComplete: string | undefined
  /** Seconds until the device code expires. */
  expiresIn: number
  /** Seconds to wait between token polls. */
  interval: number
}

/** An OAuth error response, or a response this module could not use. `code` is the OAuth `error` value when there is one. */
export class OAuthError extends Error {
  readonly code: string
  readonly status: number | undefined

  constructor(code: string, message: string, status?: number) {
    super(message)
    this.name = "OAuthError"
    this.code = code
    this.status = status
  }
}

/** True when `url` is HTTPS on `x.ai` or a subdomain. Discovery results are checked with this so a token is never sent elsewhere. */
export function isXaiUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (
    parsed.protocol === "https:" &&
    (parsed.hostname === "x.ai" || parsed.hostname.endsWith(".x.ai"))
  )
}

function requireXaiUrl(value: string | undefined, field: string): string {
  if (!value || !isXaiUrl(value)) {
    throw new OAuthError("invalid_discovery", `xAI sign-in returned an unexpected ${field}.`)
  }
  return value
}

type JsonObject = { readonly [key: string]: unknown }

async function readJson(response: Response): Promise<JsonObject> {
  const body: unknown = await response.json()
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new OAuthError(
      "invalid_response",
      "xAI sign-in returned an unexpected response.",
      response.status,
    )
  }
  return Object.fromEntries(Object.entries(body))
}

function str(body: JsonObject, key: string): string | undefined {
  const value = body[key]
  return typeof value === "string" && value !== "" ? value : undefined
}

function num(body: JsonObject, key: string): number | undefined {
  const value = body[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export async function discoverEndpoints(
  fetchFn: FetchFn,
  issuer = XAI_ISSUER,
): Promise<OAuthEndpoints> {
  const response = await fetchFn(`${issuer}/.well-known/openid-configuration`, {
    headers: { accept: "application/json" },
  })
  if (!response.ok) {
    throw new OAuthError(
      "discovery_failed",
      `Could not reach xAI sign-in (HTTP ${response.status}).`,
      response.status,
    )
  }
  const body = await readJson(response)
  const revocation = str(body, "revocation_endpoint")
  return {
    deviceAuthorization: requireXaiUrl(
      str(body, "device_authorization_endpoint") ?? `${issuer}/oauth2/device/code`,
      "device authorization endpoint",
    ),
    token: requireXaiUrl(str(body, "token_endpoint"), "token endpoint"),
    revocation: revocation ? requireXaiUrl(revocation, "revocation endpoint") : undefined,
  }
}

async function postForm(
  fetchFn: FetchFn,
  url: string,
  form: Record<string, string>,
): Promise<Response> {
  return fetchFn(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
  })
}

async function errorFrom(response: Response, fallback: string): Promise<OAuthError> {
  let code = "http_error"
  let description: string | undefined
  try {
    const body = await readJson(response)
    code = str(body, "error") ?? code
    description = str(body, "error_description")
  } catch {
    // The body was not JSON. The status code is enough.
  }
  return new OAuthError(
    code,
    description ?? `${fallback} (HTTP ${response.status}).`,
    response.status,
  )
}

async function readTokenResponse(response: Response): Promise<TokenResponse> {
  const body = await readJson(response)
  const accessToken = str(body, "access_token")
  if (!accessToken) {
    throw new OAuthError("invalid_token_response", "xAI sign-in returned no access token.")
  }
  return {
    access_token: accessToken,
    refresh_token: str(body, "refresh_token"),
    id_token: str(body, "id_token"),
    expires_in: num(body, "expires_in"),
    scope: str(body, "scope"),
    token_type: str(body, "token_type"),
  }
}

export async function requestDeviceCode(
  fetchFn: FetchFn,
  endpoints: OAuthEndpoints,
  clientId: string,
): Promise<DeviceCode> {
  const response = await postForm(fetchFn, endpoints.deviceAuthorization, {
    client_id: clientId,
    scope: XAI_SCOPES,
    referrer: REFERRER,
  })
  if (!response.ok) throw await errorFrom(response, "Could not start xAI sign-in")
  const body = await readJson(response)
  const deviceCode = str(body, "device_code")
  const userCode = str(body, "user_code")
  const verificationUri = str(body, "verification_uri")
  const verificationUriComplete = str(body, "verification_uri_complete")
  if (!deviceCode || !userCode || !verificationUri) {
    throw new OAuthError("invalid_device_code", "xAI sign-in returned an incomplete device code.")
  }
  return {
    deviceCode,
    userCode,
    verificationUri: requireXaiUrl(verificationUri, "verification URL"),
    verificationUriComplete: verificationUriComplete
      ? requireXaiUrl(verificationUriComplete, "verification URL")
      : undefined,
    expiresIn: num(body, "expires_in") ?? 900,
    interval: num(body, "interval") ?? 5,
  }
}

export const defaultSleep: SleepFn = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })

/**
 * Poll the token endpoint until the user approves the device code in the browser.
 * Follows RFC 8628: wait `interval` seconds, add 5 seconds on `slow_down`, and stop on
 * `access_denied`, `expired_token`, or when the code's lifetime has passed.
 */
export async function pollDeviceToken(
  fetchFn: FetchFn,
  endpoints: OAuthEndpoints,
  clientId: string,
  device: DeviceCode,
  sleep: SleepFn = defaultSleep,
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<TokenResponse> {
  const deadline = now() + device.expiresIn * 1000
  let interval = device.interval
  while (now() < deadline) {
    await sleep(interval * 1000, signal)
    const response = await postForm(fetchFn, endpoints.token, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.deviceCode,
      client_id: clientId,
    })
    if (response.ok) return readTokenResponse(response)
    const error = await errorFrom(response, "xAI sign-in failed")
    if (error.code === "authorization_pending") continue
    if (error.code === "slow_down") {
      interval += 5
      continue
    }
    throw error
  }
  throw new OAuthError("expired_token", "The sign-in code expired. Start sign-in again.")
}

export async function refreshTokens(
  fetchFn: FetchFn,
  endpoints: OAuthEndpoints,
  clientId: string,
  refreshToken: string,
): Promise<TokenResponse> {
  const response = await postForm(fetchFn, endpoints.token, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  })
  if (!response.ok) throw await errorFrom(response, "Could not refresh the Grok sign-in")
  return readTokenResponse(response)
}

/** Revoke a token. Resolves when the server accepts it. Callers treat a failure as non-fatal and clear local tokens anyway. */
export async function revokeToken(
  fetchFn: FetchFn,
  endpoints: OAuthEndpoints,
  clientId: string,
  token: string,
): Promise<void> {
  if (!endpoints.revocation) return
  const response = await postForm(fetchFn, endpoints.revocation, {
    token,
    client_id: clientId,
  })
  if (!response.ok) throw await errorFrom(response, "Could not revoke the Grok sign-in")
}

/** The `email` claim from an ID token, for display only. The token is not verified. */
export function emailFromIdToken(idToken: string | undefined): string | undefined {
  const payload = idToken?.split(".")[1]
  if (!payload) return undefined
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    if (claims === null || typeof claims !== "object" || !("email" in claims)) return undefined
    return typeof claims.email === "string" ? claims.email : undefined
  } catch {
    return undefined
  }
}
