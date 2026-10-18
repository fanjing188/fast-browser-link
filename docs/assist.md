# First use of Assist

Finish [installation](installation.md) and connect the browser. The sidebar starts with **Try first, no Agent needed**:

1. **Detect and export tables:** read the current page, select a table, choose Excel, CSV or copy, then review and confirm.
2. **Multi-page collection:** open the same table panel; choose Save all when pagination or an incomplete table is detected. Review the page count, limits and filter notice before confirming.
3. **Page annotations:** show existing local evidence on this page; click again to stop. Missing evidence stays unknown. This does not start a model.
4. **Work basket:** open an empty basket, then add objects using annotation + or a confirmed table export. Batch work still requires preview and confirmation.

For proactive suggestions, click **Configure Agent**, choose Hermes or Codex, check the connection, then explicitly enable Assist. Proactive workflow suggestions stay hidden before configuration; tables you explicitly detect remain available. Reopen setup in Settings → Assist Agent. Install and log into Codex yourself (CLI 0.162.1 minimum); if Hermes needs model configuration, run `hermes model` as prompted.

Measured Codex restricted inference has about **10.6K input tokens** of fixed overhead per call, plus task context; actual usage can vary. Without an explicit inference model, Assist checks `model/list` for name segments nano, mini, then luna, preserving catalog order within a tier. No match keeps the default. Names are a cost heuristic, not live prices. Explicit choices win; execution models are unaffected.

Take over or stop whenever needed. Passwords, payments, verification codes and final submission stay with you. Inspect an uncertain result before another write. Settings → Memory lets you view, delete or disable local work memory. Real third-party sites and accounts need separate acceptance.

[Export a multi-page table](export-tables.md) · [Troubleshooting](fbl-troubleshooting.md) · [Design and safety contract](design/assist.md) · [中文](assist.zh-CN.md)
