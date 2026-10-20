import { showHUD } from "@raycast/api"
import { grokSession } from "./lib/grok.ts"

export default async function SignOut() {
  try {
    const signedOut = await grokSession().signOut()
    await showHUD(signedOut ? "Signed out of Grok" : "Not signed in to Grok")
  } catch {
    // signOut() clears local tokens even when xAI does not confirm the revoke.
    await showHUD("Signed out of Grok on this Mac")
  }
}
