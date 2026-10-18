# Pair a cloud browser

Cloud access is optional and separate from local Agent access. Configure your own private Sites service and its plugin using the [deployment and safety contract](design/cloud-connection.md). Keep service credentials in local protected configuration.

1. In the extension popup choose Cloud connection.
2. Generate a connection code and open the pairing page. The 12-character code expires after five minutes.
3. Check the browser identity and explicitly confirm pairing, then connect that site's plugin in ChatGPT. Pair Chrome and Edge separately.

Pairing permits supported actions only in cloud-created work pages. Existing personal tabs are not authorized. Takeover, stop and sensitive-input controls still apply. Disconnect explicitly; an unconfirmed remote revoke is not a successful revoke. After reconnecting, inspect task state before continuing and never replay an unknown write.

At task completion, close and check the cleanup receipt. Use `keep_tabs=true` only for an explicit handoff. [中文](cloud-connection.zh-CN.md)
