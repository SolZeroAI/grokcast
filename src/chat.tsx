import {
  Action,
  ActionPanel,
  Alert,
  confirmAlert,
  Icon,
  Keyboard,
  launchCommand,
  LaunchType,
  List,
  showToast,
  Toast,
} from "@raycast/api"
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import { useEffect, useRef, useState } from "react"
import { Chat, ChatPreferences, turnMarkdown, type ChatTurn } from "./lib/chat.ts"
import {
  ChatConversations,
  newConversation,
  withTurn,
  type Conversation,
} from "./lib/conversations.ts"
import { GrokRuntime } from "./lib/grok.ts"

export default function GrokChat() {
  return <ChatView initial={Option.none()} nested={false} />
}

/** The question being answered, and what Grok has sent so far. */
interface Pending {
  readonly prompt: string
  readonly status: string
  readonly answer: string
}

/** A question that got no answer. */
interface Failure {
  readonly prompt: string
  readonly message: string
  readonly signIn: boolean
}

/**
 * Redraw at most this often while an answer streams. Tinycast sends the whole view
 * on every update, so fewer updates keep it smooth.
 */
const STREAM_REDRAW_MS = 150

const SHOW_CONVERSATIONS: Keyboard.Shortcut = { modifiers: ["cmd"], key: "y" }

const signIn = () =>
  void launchCommand({ name: "account", type: LaunchType.UserInitiated, context: { signIn: true } })

const failureToast = (title: string) =>
  Effect.tryPromise(() => showToast({ style: Toast.Style.Failure, title })).pipe(Effect.ignore)

function ChatView({
  initial,
  nested,
}: {
  readonly initial: Option.Option<Conversation>
  /** Opened from Conversations, which is one step back. */
  readonly nested: boolean
}) {
  const [conversation, setConversation] = useState(initial)
  const [pending, setPending] = useState<Option.Option<Pending>>(Option.none())
  const [failure, setFailure] = useState<Option.Option<Failure>>(Option.none())
  const [searchText, setSearchText] = useState("")
  const [selected, setSelected] = useState<Option.Option<string>>(Option.none())
  const fiber = useRef<Option.Option<Fiber.Fiber<void>>>(Option.none())

  // Stop an answer in progress when the command closes.
  useEffect(
    () => () => {
      Option.map(fiber.current, (running) => GrokRuntime.runFork(Fiber.interrupt(running)))
    },
    [],
  )

  const turns = Option.match(conversation, {
    onNone: (): ReadonlyArray<ChatTurn> => [],
    onSome: (current) => current.turns,
  })

  const ask = (text: string) => {
    const prompt = text.trim()
    if (prompt === "" || Option.isSome(pending)) return
    setSearchText("")
    setFailure(Option.none())
    setSelected(Option.some("pending"))
    const view = { prompt, status: "Waiting for Grok", answer: "", timer: false, done: false }
    const show = () => {
      if (!view.done) setPending(Option.some({ prompt, status: view.status, answer: view.answer }))
    }
    // Draw the newest text a moment later, once, however many pieces arrive meanwhile.
    const showSoon = () => {
      if (view.timer) return
      view.timer = true
      setTimeout(() => {
        view.timer = false
        show()
      }, STREAM_REDRAW_MS)
    }
    show()
    const program = Effect.gen(function* () {
      const settings = yield* ChatPreferences
      const chat = yield* Chat
      const saved = yield* ChatConversations
      const base = yield* Option.match(conversation, {
        onNone: () => newConversation,
        onSome: Effect.succeed,
      })
      const turn = yield* chat.ask(
        prompt,
        { conversationId: base.id, history: base.turns },
        settings,
        {
          thinking: () => {
            if (view.answer !== "" || view.status === "Thinking") return
            view.status = "Thinking"
            showSoon()
          },
          tool: (label) => {
            view.status = label
            showSoon()
          },
          text: (answer) => {
            view.status = "Answering"
            view.answer = answer
            showSoon()
          },
        },
      )
      const next = withTurn(base, turn)
      setConversation(Option.some(next))
      setSelected(Option.some(turn.id))
      yield* saved
        .save(next)
        .pipe(Effect.catch(() => failureToast("Could not save the conversation")))
    }).pipe(
      Effect.catchTag("ChatError", (error) =>
        Effect.sync(() => {
          setFailure(
            Option.some({ prompt, message: error.message, signIn: error.reason === "signIn" }),
          )
          setSelected(Option.some("failure"))
        }),
      ),
      // Stopped by the user: give the question back to edit or send again.
      Effect.onInterrupt(() => Effect.sync(() => setSearchText(prompt))),
      Effect.ensuring(
        Effect.sync(() => {
          view.done = true
          fiber.current = Option.none()
          setPending(Option.none())
        }),
      ),
    )
    fiber.current = Option.some(GrokRuntime.runFork(program))
  }

  const stop = () => {
    Option.map(fiber.current, (running) => GrokRuntime.runFork(Fiber.interrupt(running)))
  }

  const startNew = () => {
    stop()
    setConversation(Option.none())
    setFailure(Option.none())
    setSelected(Option.none())
  }

  const deleteConversation = async () => {
    if (Option.isNone(conversation)) return
    const current = conversation.value
    const confirmed = await confirmAlert({
      title: "Delete this conversation?",
      message: "This removes it from this Mac.",
      primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive },
    })
    if (!confirmed) return
    GrokRuntime.runFork(
      ChatConversations.use((saved) => saved.remove(current.id)).pipe(
        Effect.andThen(Effect.sync(startNew)),
        Effect.catch(() => failureToast("Could not delete the conversation")),
      ),
    )
  }

  const asking = Option.isSome(pending)
  const askAction =
    searchText.trim() !== "" && !asking ? (
      <Action title="Ask Grok" icon={Icon.SpeechBubble} onAction={() => ask(searchText)} />
    ) : null

  const commonActions = (
    <>
      <ActionPanel.Section>
        <Action
          title="New Conversation"
          icon={Icon.PlusCircle}
          shortcut={Keyboard.Shortcut.Common.New}
          onAction={startNew}
        />
        {nested ? null : (
          <Action.Push
            title="Show Conversations"
            icon={Icon.List}
            shortcut={SHOW_CONVERSATIONS}
            target={<ConversationsView />}
          />
        )}
      </ActionPanel.Section>
      {Option.isSome(conversation) ? (
        <ActionPanel.Section>
          <Action
            title="Delete Conversation"
            icon={Icon.Trash}
            style={Action.Style.Destructive}
            shortcut={Keyboard.Shortcut.Common.Remove}
            onAction={deleteConversation}
          />
        </ActionPanel.Section>
      ) : null}
    </>
  )

  return (
    <List
      isLoading={asking}
      isShowingDetail={turns.length > 0 || asking || Option.isSome(failure)}
      filtering={false}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder={turns.length > 0 ? "Ask a follow-up…" : "Ask Grok…"}
      navigationTitle={Option.match(conversation, {
        onNone: () => "Grok Chat",
        onSome: (current) => current.title,
      })}
      selectedItemId={Option.getOrUndefined(selected)}
      onSelectionChange={(id) => setSelected(Option.fromNullishOr(id))}
    >
      <List.EmptyView
        icon={Icon.SpeechBubble}
        title="Ask Grok anything"
        description="Type a question and press Return. Grok can search the web and X, and you can turn its tools on or off in the command preferences."
        actions={
          <ActionPanel>
            {askAction}
            {commonActions}
          </ActionPanel>
        }
      />
      {Option.match(pending, {
        onNone: () => null,
        onSome: (current) => (
          <List.Item
            id="pending"
            title={current.prompt}
            icon={Icon.Hourglass}
            detail={
              <List.Item.Detail
                markdown={`**${current.prompt}**\n\n${
                  current.answer === "" ? `_${current.status}…_` : current.answer
                }`}
              />
            }
            actions={
              <ActionPanel>
                <Action
                  title="Stop Answering"
                  icon={Icon.Stop}
                  shortcut={{ modifiers: ["cmd"], key: "." }}
                  onAction={stop}
                />
              </ActionPanel>
            }
          />
        ),
      })}
      {Option.match(failure, {
        onNone: () => null,
        onSome: (current) => (
          <List.Item
            id="failure"
            title={current.prompt}
            icon={Icon.ExclamationMark}
            detail={<List.Item.Detail markdown={`**${current.prompt}**\n\n${current.message}`} />}
            actions={
              <ActionPanel>
                {askAction}
                {current.signIn ? (
                  <Action title="Sign in to Grok" icon={Icon.Person} onAction={signIn} />
                ) : null}
                <Action
                  title="Try Again"
                  icon={Icon.ArrowClockwise}
                  shortcut={Keyboard.Shortcut.Common.Refresh}
                  onAction={() => ask(current.prompt)}
                />
                {commonActions}
              </ActionPanel>
            }
          />
        ),
      })}
      {Arr.reverse(turns).map((turn) => (
        <List.Item
          key={turn.id}
          id={turn.id}
          title={turn.prompt}
          icon={Icon.SpeechBubble}
          detail={<List.Item.Detail markdown={turnMarkdown(turn)} />}
          actions={
            <ActionPanel>
              {askAction}
              <Action.CopyToClipboard title="Copy Answer" content={turn.answer} />
              <Action.Paste title="Paste Answer" content={turn.answer} />
              <Action.CopyToClipboard
                title="Copy Question"
                content={turn.prompt}
                shortcut={Keyboard.Shortcut.Common.CopyName}
              />
              {Arr.match(turn.citations, {
                onEmpty: () => null,
                onNonEmpty: (citations) => (
                  <ActionPanel.Submenu
                    title="Open Source"
                    icon={Icon.Globe}
                    shortcut={Keyboard.Shortcut.Common.Open}
                  >
                    {citations.map((citation) => (
                      <Action.OpenInBrowser
                        key={citation.url}
                        title={Option.getOrElse(citation.title, () => citation.url)}
                        url={citation.url}
                      />
                    ))}
                  </ActionPanel.Submenu>
                ),
              })}
              {commonActions}
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })

function ConversationsView() {
  const [conversations, setConversations] = useState<Option.Option<ReadonlyArray<Conversation>>>(
    Option.none(),
  )

  const reload = () =>
    GrokRuntime.runFork(
      ChatConversations.use((saved) => saved.list).pipe(
        Effect.tap((list) => Effect.sync(() => setConversations(Option.some(list)))),
      ),
    )

  useEffect(() => {
    reload()
  }, [])

  const change = (program: Effect.Effect<void, unknown, ChatConversations>, failure: string) =>
    GrokRuntime.runFork(
      program.pipe(
        Effect.andThen(Effect.sync(reload)),
        Effect.catch(() => failureToast(failure)),
      ),
    )

  const clearAll = async () => {
    const confirmed = await confirmAlert({
      title: "Delete all conversations?",
      message: "This removes every Grok conversation from this Mac.",
      primaryAction: { title: "Delete All", style: Alert.ActionStyle.Destructive },
    })
    if (confirmed) {
      change(
        ChatConversations.use((saved) => saved.clear),
        "Could not delete the conversations",
      )
    }
  }

  const list = Option.getOrElse(conversations, (): ReadonlyArray<Conversation> => [])

  return (
    <List isLoading={Option.isNone(conversations)} searchBarPlaceholder="Search conversations">
      <List.EmptyView
        icon={Icon.SpeechBubble}
        title="No conversations yet"
        description="Ask Grok something in Grok Chat. Conversations stay on this Mac."
      />
      {list.map((conversation) => (
        <List.Item
          key={conversation.id}
          title={conversation.title}
          keywords={conversation.turns.map((turn) => turn.prompt)}
          icon={Icon.SpeechBubble}
          accessories={[
            {
              text: `${conversation.turns.length} ${
                conversation.turns.length === 1 ? "question" : "questions"
              }`,
            },
            { text: dateFormat.format(conversation.updatedAt) },
          ]}
          actions={
            <ActionPanel>
              <Action.Push
                title="Open Conversation"
                icon={Icon.SpeechBubble}
                target={<ChatView initial={Option.some(conversation)} nested />}
                onPop={reload}
              />
              <Action
                title="Delete Conversation"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                shortcut={Keyboard.Shortcut.Common.Remove}
                onAction={() =>
                  change(
                    ChatConversations.use((saved) => saved.remove(conversation.id)),
                    "Could not delete the conversation",
                  )
                }
              />
              <Action
                title="Delete All Conversations"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                shortcut={Keyboard.Shortcut.Common.RemoveAll}
                onAction={clearAll}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}
