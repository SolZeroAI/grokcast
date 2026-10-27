# Grokcast

Grokcast lets you use Grok in [Raycast](https://www.raycast.com) and Tinycast with your own Grok or X subscription. You do not need an xAI API key, and nothing is billed separately. The extension is built on xAI's official TypeScript SDK, so it can offer any native Grok feature. Voice comes first: dictation and reading text aloud.

## Status

| Feature                                          | State |
| ------------------------------------------------ | ----- |
| Sign in and sign out with your Grok subscription | Done  |
| Microphone recorder                              | Done  |
| Dictate (record, then transcribe)                | Done  |
| Live dictation with partial text                 | Done  |
| Read selected text aloud                         | Done  |
| Generate and edit images                         | Done  |
| Generate, edit, and extend videos                | Built |

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

## Read Aloud

**Read Aloud** reads the selected text aloud in a Grok voice. When nothing is selected, it reads the clipboard. You can also type the text into its argument. The speech plays in the background, so you can keep working. Run **Read Aloud** again to stop it. Assign a hotkey to make this one keystroke.

Grok reads up to 60,000 characters at a time. Speech is made by xAI's text-to-speech with your subscription. The audio is kept only until the next run replaces it.

Set these in the command preferences:

- **Voice**: one of Grok's voices, or xAI Default.
- **Speed**: from 0.7× to 1.5×, or xAI Default.
- **Reading Language**: the language of the text, or Detect Automatically.

## Images

**Generate Image** asks for a prompt and makes up to four images with Grok Imagine on your subscription. Pick an aspect ratio and resolution, or leave them at xAI Default. **Edit Image** changes up to three JPEG, PNG, or WebP images with a prompt. It starts with the images selected in Finder, if there are any. With more than one image, call them `<IMAGE_0>`, `<IMAGE_1>`, and so on in the prompt.

Each new image shows in a grid. Copy or paste it, look at it with Quick Look (⌘Y), save it to Downloads (⌘S), edit it again (⌘E), or reuse the prompt (⇧⌘R). **Image History** keeps your last 200 images in the extension's support folder on this Mac, with the same actions. Grokcast does not choose the image model, so xAI's current default and its upgrades apply.

## Video

**Generate Video** makes a short video with Grok Imagine, with your subscription. Write a prompt, or choose a picture to use as the first frame. You can also edit an MP4 (say what to change) or extend one (say what happens next).

Length, aspect ratio, and resolution start at **xAI Default**. Grokcast never picks the model, so xAI's current video model and its upgrades apply. A video usually takes a minute or two. Keep the command open while it works: the side panel shows xAI's progress. If it takes more than 10 minutes, **Check Again** looks up the same job instead of starting a new one.

When the video is ready, **Open Video** plays it in your browser, and ⌘S saves the MP4 to your Downloads folder. xAI's link is temporary, so save the videos you want to keep.

## How sign-in works

**Grok Account** shows who is signed in. **Sign In** starts the xAI device-code sign-in. It copies a short code to your clipboard and opens `accounts.x.ai` in your browser. Approve the code there and the command finishes on its own. **Sign Out** revokes the sign-in at xAI and removes it from this Mac.

The tokens stay in Raycast's encrypted token store on your Mac. Grokcast has no server. Requests go straight to `api.x.ai` and count against your subscription's weekly usage.

xAI does not yet offer client registration for third-party apps. Grokcast reuses Grok Build's public OAuth client, the same way Hermes Agent, OpenCode, and others do. If xAI gives this extension its own client ID, set it in the extension preferences.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).
