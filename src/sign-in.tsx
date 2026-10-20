import { Action, ActionPanel, Clipboard, Detail, Icon, open, showToast, Toast } from "@raycast/api"
import { useEffect, useState } from "react"
import { clientId, grokSession, raycastTokenStore, xaiEndpoints } from "./lib/grok.ts"
import {
  emailFromIdToken,
  OAuthError,
  pollDeviceToken,
  requestDeviceCode,
  type DeviceCode,
} from "./lib/oauth.ts"
import { toStoredTokens } from "./lib/session.ts"

type State =
  | { step: "checking" }
  | { step: "waiting"; device: DeviceCode }
  | { step: "signed-in"; email: string | undefined }
  | { step: "failed"; message: string }

export default function SignIn() {
  const [state, setState] = useState<State>({ step: "checking" })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const abort = new AbortController()
    void run(abort.signal, attempt === 0, setState)
    return () => abort.abort()
  }, [attempt])

  const retry = () => setAttempt((count) => count + 1)

  switch (state.step) {
    case "checking":
      return <Detail isLoading markdown="Starting Grok sign-in…" />
    case "waiting": {
      const url = state.device.verificationUriComplete ?? state.device.verificationUri
      return (
        <Detail
          isLoading
          markdown={[
            "# Sign in to Grok",
            "",
            `Your code is **${state.device.userCode}**. It is on your clipboard.`,
            "",
            "Approve it in the browser window that just opened, then come back here. If no window opened, use **Open Browser** below.",
            "",
            "Grok Voice uses your Grok or X subscription. It does not need an xAI API key.",
          ].join("\n")}
          actions={
            <ActionPanel>
              <Action.OpenInBrowser title="Open Browser" url={url} />
              <Action.CopyToClipboard title="Copy Code" content={state.device.userCode} />
            </ActionPanel>
          }
        />
      )
    }
    case "signed-in":
      return (
        <Detail
          markdown={[
            "# Signed in to Grok",
            "",
            state.email ? `Signed in as **${state.email}**.` : "You are signed in.",
          ].join("\n")}
          actions={
            <ActionPanel>
              <Action
                title="Sign in Again"
                icon={Icon.ArrowClockwise}
                onAction={() => void signInAgain(retry)}
              />
            </ActionPanel>
          }
        />
      )
    case "failed":
      return (
        <Detail
          markdown={["# Sign-in did not finish", "", state.message].join("\n")}
          actions={
            <ActionPanel>
              <Action title="Try Again" icon={Icon.ArrowClockwise} onAction={retry} />
            </ActionPanel>
          }
        />
      )
  }
}

async function run(
  signal: AbortSignal,
  useExisting: boolean,
  setState: (state: State) => void,
): Promise<void> {
  try {
    const existing = useExisting ? await raycastTokenStore.load() : undefined
    if (existing) {
      setState({ step: "signed-in", email: emailFromIdToken(existing.idToken) })
      return
    }
    const endpoints = await xaiEndpoints()
    const device = await requestDeviceCode(fetch, endpoints, clientId())
    await Clipboard.copy(device.userCode)
    setState({ step: "waiting", device })
    await open(device.verificationUriComplete ?? device.verificationUri)
    const response = await pollDeviceToken(fetch, endpoints, clientId(), device, undefined, signal)
    const tokens = toStoredTokens(response, Date.now())
    await raycastTokenStore.save(tokens)
    setState({ step: "signed-in", email: emailFromIdToken(tokens.idToken) })
    await showToast({ style: Toast.Style.Success, title: "Signed in to Grok" })
  } catch (error) {
    if (signal.aborted) return
    setState({ step: "failed", message: describe(error) })
  }
}

async function signInAgain(retry: () => void): Promise<void> {
  await grokSession()
    .signOut()
    .catch(() => undefined)
  retry()
}

function describe(error: unknown): string {
  if (error instanceof OAuthError) {
    if (error.code === "access_denied") return "The sign-in was declined in the browser."
    if (error.code === "expired_token") return "The sign-in code expired before it was approved."
    return error.message
  }
  if (error instanceof Error) return error.message
  return String(error)
}
