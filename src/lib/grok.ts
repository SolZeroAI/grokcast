// Raycast wiring for the Grok session: tokens in Raycast's encrypted OAuth store,
// the client ID from preferences.

import { getPreferenceValues, OAuth } from "@raycast/api"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { ClientId, DEFAULT_CLIENT_ID, XaiEndpoints } from "./oauth.ts"
import { GrokSession, StoredTokens, TokenStore, TokenStoreError } from "./session.ts"

// Only the token store is used. Sign-in runs the device-code flow in `sign-in.tsx`,
// not `authorize()`, so the redirect method is never exercised.
const client = new OAuth.PKCEClient({
  redirectMethod: OAuth.RedirectMethod.Web,
  providerName: "Grok",
  providerIcon: "extension-icon.png",
  description: "Sign in with your Grok or X subscription.",
})

const storeCall = <A>(message: string, call: () => Promise<A>) =>
  Effect.tryPromise({ try: call, catch: (cause) => new TokenStoreError({ message, cause }) })

const fromRaycast = (tokens: OAuth.TokenSet): Option.Option<StoredTokens> =>
  Option.map(
    Option.liftPredicate(tokens.accessToken, (token) => token !== ""),
    (accessToken) =>
      new StoredTokens({
        accessToken: Redacted.make(accessToken),
        refreshToken: Option.map(Option.fromNullishOr(tokens.refreshToken), Redacted.make),
        idToken: Option.map(Option.fromNullishOr(tokens.idToken), Redacted.make),
        expiresAt: tokens.updatedAt.getTime() + (tokens.expiresIn ?? 0) * 1000,
      }),
  )

const unredact = (token: Option.Option<Redacted.Redacted<string>>) =>
  Option.getOrUndefined(Option.map(token, Redacted.value))

export const RaycastTokenStore = Layer.succeed(
  TokenStore,
  TokenStore.of({
    load: storeCall("Could not read the Grok sign-in.", () => client.getTokens()).pipe(
      Effect.map((tokens) => Option.flatMap(Option.fromNullishOr(tokens), fromRaycast)),
    ),
    save: (tokens) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        storeCall("Could not save the Grok sign-in.", () =>
          client.setTokens({
            access_token: Redacted.value(tokens.accessToken),
            refresh_token: unredact(tokens.refreshToken),
            id_token: unredact(tokens.idToken),
            expires_in: Math.max(0, Math.round((tokens.expiresAt - now) / 1000)),
          }),
        ),
      ),
    clear: storeCall("Could not remove the Grok sign-in.", () => client.removeTokens()),
  }),
)

const Preferences = Schema.Struct({ clientId: Schema.OptionFromOptionalKey(Schema.String) })

export const RaycastClientId = Layer.sync(ClientId, () =>
  Schema.decodeUnknownOption(Preferences)(getPreferenceValues()).pipe(
    Option.flatMap((preferences) => preferences.clientId),
    Option.map((clientId) => clientId.trim()),
    Option.filter((clientId) => clientId !== ""),
    Option.getOrElse(() => DEFAULT_CLIENT_ID),
  ),
)

/** Everything a command needs to talk to xAI as the signed-in user. */
export const GrokLive = GrokSession.layer.pipe(
  Layer.provideMerge(XaiEndpoints.layer),
  Layer.provideMerge(Layer.mergeAll(RaycastTokenStore, RaycastClientId)),
  Layer.provideMerge(FetchHttpClient.layer),
)

/** Runs command programs with `GrokLive`. Each command builds it once. */
export const GrokRuntime = ManagedRuntime.make(GrokLive)
