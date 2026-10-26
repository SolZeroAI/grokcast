# Grokcast

Grokcast lets you use Grok in [Raycast](https://www.raycast.com) and Tinycast with your own Grok or X subscription. You do not need an xAI API key, and nothing is billed separately. The extension is built on xAI's official TypeScript SDK, so it can offer any native Grok feature. Voice comes first: dictation and reading text aloud.

## Status

| Feature                                          | State                         |
| ------------------------------------------------ | ----------------------------- |
| Sign in and sign out with your Grok subscription | Done                          |
| Microphone recorder                              | Done                          |
| Dictate (record, then transcribe)                | Done                          |
| Live dictation with partial text                 | Done                          |
| Read selected text aloud                         | Planned                       |
| Talk to Grok (spoken conversation)               | Built, not yet tried on a Mac |

## Microphone

Grokcast records with a small Swift helper that ships inside the extension, so you do not need to install anything. The first time it records, macOS asks to let Raycast (or Tinycast) use the microphone. Audio is not saved.

## Dictation

**Dictate** listens until you press Return and shows the text while you speak. Then it pastes the text into the app you were using. Press Esc to cancel. Recording stops on its own after 5 minutes.

When it's done, a HUD sums up the dictation, and the side panel shows the words, length, speaking speed, language, how long the text took after you stopped, and whether it came live or from the whole recording. Press ⌘Y to open **Dictation History**, which shows the same details for each dictation.

The live text comes from xAI's streaming speech-to-text, with your subscription. If the live connection stops, Dictate keeps recording and sends the whole recording to xAI when you stop, so you still get your text.

Set these in the extension preferences:

- **Dictation Language**: the language you speak, or Detect Automatically.
- **Formatting**: write numbers, currencies, and units as digits. This needs a dictation language. Live text always writes them as digits when a language is set; this setting applies when the whole recording is sent.
- **After Dictation**: paste into the frontmost app, or only copy to the clipboard.
- **History**: keep the text of your last 100 dictations on this Mac. **Dictation History** lets you search, paste, copy, or delete them. Audio is never saved.

## Talk to Grok

**Talk to Grok** is a spoken conversation. Speak, then pause: Grok answers out loud, and the words of both sides show as you go. Press ⌘. to stop Grok mid-answer, and Return or Esc to end the conversation. Copy Transcript puts the whole conversation on the clipboard. A conversation ends on its own after 10 minutes. Audio is not saved.

While Grok speaks, the microphone is not sent, so Grok does not hear itself through your speakers. To cut in, press ⌘. first.

Set these in the command's preferences:

- **Voice**: xAI Default, or one of Eve, Ara, Rex, Sal, and Leo.
- **Custom Voice ID**: the ID of one of your custom voices, or another built-in voice. It replaces the voice above.
- **Instructions**: tell Grok how to behave, such as "Answer in one or two sentences."

The conversation uses xAI's realtime voice endpoint, with your subscription. Grokcast does not pick a voice model, so xAI's default and its upgrades apply.

## How sign-in works

**Grok Account** shows who is signed in. **Sign In** starts the xAI device-code sign-in. It copies a short code to your clipboard and opens `accounts.x.ai` in your browser. Approve the code there and the command finishes on its own. **Sign Out** revokes the sign-in at xAI and removes it from this Mac.

The tokens stay in Raycast's encrypted token store on your Mac. Grokcast has no server. Requests go straight to `api.x.ai` and count against your subscription's weekly usage.

xAI does not yet offer client registration for third-party apps. Grokcast reuses Grok Build's public OAuth client, the same way Hermes Agent, OpenCode, and others do. If xAI gives this extension its own client ID, set it in the extension preferences.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).
