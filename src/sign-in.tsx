import { Action, ActionPanel, Clipboard, Detail, Icon, open, showToast, Toast } from "@raycast/api"
import * as Clock from "effect/Clock"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import { useEffect, useState } from "react"
import { GrokRuntime } from "./lib/grok.ts"
import {
  ClientId,
  emailFromIdToken,
  pollDeviceToken,
  requestDeviceCode,
  XaiEndpoints,
  type DeviceCode,
} from "./lib/oauth.ts"
import { GrokSession, TokenStore, toStoredTokens } from "./lib/session.ts"

type State = Data.TaggedEnum<{
  Checking: {}
  Waiting: { readonly device: DeviceCode }
  SignedIn: { readonly email: Option.Option<string> }
  Failed: { readonly message: string }
}>
const State = Data.taggedEnum<State>()

export default function SignIn() {
  const [state, setState] = useState<State>(State.Checking())
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const fiber = GrokRuntime.runFork(
      signIn(attempt === 0, setState).pipe(
        Effect.catch((error) =>
          Effect.sync(() => setState(State.Failed({ message: describe(error) }))),
        ),
      ),
    )
    return () => {
      GrokRuntime.runFork(Fiber.interrupt(fiber))
    }
  }, [attempt])

  const retry = () => setAttempt((count) => count + 1)

  const signInAgain = () =>
    GrokRuntime.runFork(
      GrokSession.use((session) => session.signOut).pipe(
        Effect.ignore,
        Effect.andThen(Effect.sync(retry)),
      ),
    )

  return State.$match(state, {
    Checking: () => <Detail isLoading markdown="Starting Grok sign-in…" />,
    Waiting: ({ device }) => (
      <Detail
        isLoading
        markdown={[
          "# Sign in to Grok",
          "",
          `Your code is **${device.userCode}**. It is on your clipboard.`,
          "",
          "Approve it in the browser window that just opened, then come back here. If no window opened, use **Open Browser** below.",
          "",
          "Grok uses your Grok or X subscription. It does not need an xAI API key.",
        ].join("\n")}
        actions={
          <ActionPanel>
            <Action.OpenInBrowser title="Open Browser" url={device.browserUrl} />
            <Action.CopyToClipboard title="Copy Code" content={device.userCode} />
          </ActionPanel>
        }
      />
    ),
    SignedIn: ({ email }) => (
      <Detail
        markdown={[
          "# Signed in to Grok",
          "",
          Option.match(email, {
            onNone: () => "You are signed in.",
            onSome: (address) => `Signed in as **${address}**.`,
          }),
        ].join("\n")}
        actions={
          <ActionPanel>
            <Action title="Sign in Again" icon={Icon.ArrowClockwise} onAction={signInAgain} />
          </ActionPanel>
        }
      />
    ),
    Failed: ({ message }) => (
      <Detail
        markdown={["# Sign-in did not finish", "", message].join("\n")}
        actions={
          <ActionPanel>
            <Action title="Try Again" icon={Icon.ArrowClockwise} onAction={retry} />
          </ActionPanel>
        }
      />
    ),
  })
}

const signIn = Effect.fn("signIn")(function* (
  useExisting: boolean,
  setState: (state: State) => void,
) {
  const store = yield* TokenStore
  const existing = useExisting ? yield* store.load : Option.none()
  if (Option.isSome(existing)) {
    setState(State.SignedIn({ email: emailFromIdToken(existing.value.idToken) }))
    return
  }
  const endpoints = yield* XaiEndpoints.use((xai) => xai.get)
  const clientId = yield* ClientId
  const device = yield* requestDeviceCode(endpoints, clientId)
  yield* Effect.tryPromise(() => Clipboard.copy(device.userCode))
  setState(State.Waiting({ device }))
  yield* Effect.tryPromise(() => open(device.browserUrl))
  const response = yield* pollDeviceToken(endpoints, clientId, device)
  const tokens = toStoredTokens(response, yield* Clock.currentTimeMillis, Option.none())
  yield* store.save(tokens)
  setState(State.SignedIn({ email: emailFromIdToken(tokens.idToken) }))
  yield* Effect.tryPromise(() =>
    showToast({ style: Toast.Style.Success, title: "Signed in to Grok" }),
  )
})

const describe = (error: Effect.Error<ReturnType<typeof signIn>>) =>
  Match.value(error).pipe(
    Match.tag("OAuthError", (oauth) =>
      Match.value(oauth.code).pipe(
        Match.when("access_denied", () => "The sign-in was declined in the browser."),
        Match.when("expired_token", () => "The sign-in code expired before it was approved."),
        Match.orElse(() => oauth.message),
      ),
    ),
    Match.orElse((other) => other.message),
  )
