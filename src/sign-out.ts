import { showHUD } from "@raycast/api"
import * as Effect from "effect/Effect"
import { GrokRuntime } from "./lib/grok.ts"
import { GrokSession } from "./lib/session.ts"

const signOut = GrokSession.use((session) => session.signOut).pipe(
  Effect.map((signedOut) => (signedOut ? "Signed out of Grok" : "Not signed in to Grok")),
  // signOut clears local tokens even when xAI does not confirm the revoke.
  Effect.catchTag("OAuthError", () => Effect.succeed("Signed out of Grok on this Mac")),
  Effect.catchTag("TokenStoreError", () => Effect.succeed("Could not sign out of Grok")),
  Effect.flatMap((message) => Effect.tryPromise(() => showHUD(message))),
)

export default async function SignOut() {
  await GrokRuntime.runPromise(signOut)
}
