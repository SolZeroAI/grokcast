# Grokcast

Grokcast lets you use Grok in [Raycast](https://www.raycast.com) and Tinycast with your own Grok or X subscription. You do not need an xAI API key, and nothing is billed separately. The extension is built on xAI's official TypeScript SDK, so it can offer any native Grok feature. Voice comes first: dictation and reading text aloud.

## Status

| Feature                                          | State   |
| ------------------------------------------------ | ------- |
| Sign in and sign out with your Grok subscription | Done    |
| Microphone recorder                              | Planned |
| Dictate (record, then transcribe)                | Planned |
| Live dictation with partial text                 | Planned |
| Read selected text aloud                         | Planned |

## How sign-in works

**Sign in to Grok** starts the xAI device-code sign-in. It copies a short code to your clipboard and opens `accounts.x.ai` in your browser. Approve the code there and the command finishes on its own. **Sign out of Grok** revokes the sign-in at xAI and removes it from this Mac.

The tokens stay in Raycast's encrypted token store on your Mac. Grokcast has no server. Requests go straight to `api.x.ai` and count against your subscription's weekly usage.

xAI does not yet offer client registration for third-party apps. Grokcast reuses Grok Build's public OAuth client, the same way Hermes Agent, OpenCode, and others do. If xAI gives this extension its own client ID, set it in the extension preferences.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).
