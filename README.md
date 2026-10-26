# Grokcast

Grokcast lets you use Grok in [Raycast](https://www.raycast.com) and Tinycast with your own Grok or X subscription. You do not need an xAI API key, and nothing is billed separately. The extension is built on xAI's official TypeScript SDK, so it can offer any native Grok feature. Voice comes first: dictation and reading text aloud.

## Status

| Feature                                          | State   |
| ------------------------------------------------ | ------- |
| Sign in and sign out with your Grok subscription | Done    |
| Microphone recorder                              | Done    |
| Dictate (record, then transcribe)                | Done    |
| Live dictation with partial text                 | Done    |
| Read selected text aloud                         | Planned |
| Grok Models and Count Tokens                     | Done    |
| Grok Files                                       | Done    |

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

## Models

**Grok Models** lists the Grok language, image, and video models that xAI offers your account, newest first. The side panel shows each model's version, aliases, inputs and outputs, context length, and reasoning efforts. Grokcast does not show prices, because your subscription does not pay per token. Other commands do not pin a model, so xAI's default and its upgrades apply on their own.

On a language model, **Count Tokens** (⌘T) shows how that model splits a text into tokens and how many there are.

## Files

**Grok Files** lists the files you keep at xAI, newest first. The side panel shows each file's size, upload date, expiry, purpose, and public link.

- **Upload File** (⌘N) picks a file on this Mac and uploads it. Choose whether xAI deletes it after 1 hour, 1 day, 7 days, or 30 days, or keeps it until you delete it.
- **Download** saves the file in your Downloads folder. It never replaces a file there: it adds " (1)", " (2)", and so on to the name.
- **Create Public Link** (⌘L) makes a link anyone can open to download the file, and copies it. Choose how long it works. **Revoke Public Link** stops it.
- **Delete File** (⌃X) deletes the file at xAI.

The list shows up to the newest 500 files.

## How sign-in works

**Grok Account** shows who is signed in. **Sign In** starts the xAI device-code sign-in. It copies a short code to your clipboard and opens `accounts.x.ai` in your browser. Approve the code there and the command finishes on its own. **Sign Out** revokes the sign-in at xAI and removes it from this Mac.

The tokens stay in Raycast's encrypted token store on your Mac. Grokcast has no server. Requests go straight to `api.x.ai` and count against your subscription's weekly usage.

xAI does not yet offer client registration for third-party apps. Grokcast reuses Grok Build's public OAuth client, the same way Hermes Agent, OpenCode, and others do. If xAI gives this extension its own client ID, set it in the extension preferences.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).
