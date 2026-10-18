# Use an incognito task

Enable **Allow in Incognito / InPrivate** in the extension details first. Pass `incognito: true` to CLI/MCP `create`, or `incognito=true` to the optional Hermes open/create tool. Missing permission returns `incognito_access_required`; no regular-window fallback is used.

Incognito does not inherit normal cookies. Tasks in the same browser still share its incognito session. Work-page isolation is not account isolation; task metadata, logs and downloaded files may persist. Passwords, payments, codes and final submission remain human actions.

Supported core reading, forms, files and navigation use the same executor. A successful fixture does not certify every third-party site or Agent version. Review [detailed boundaries and acceptance](design/incognito.zh-CN.md), then [connection troubleshooting](fbl-troubleshooting.md). [中文](incognito.zh-CN.md)
