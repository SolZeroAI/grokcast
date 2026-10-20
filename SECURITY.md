# Security

Report a vulnerability through GitHub private vulnerability reporting on [SolZeroAI/raycast-grok-voice](https://github.com/SolZeroAI/raycast-grok-voice). Please do not open a public issue for a token leak or a way to send a token to another host.

The Grok extension keeps xAI OAuth tokens in Raycast's encrypted token store on the user's Mac. It sends them only to `x.ai` hosts. **Sign out of Grok** revokes the refresh token at xAI and deletes the local copy. A user can also revoke access from their xAI account settings.
