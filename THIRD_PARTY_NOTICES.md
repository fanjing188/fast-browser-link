# Third-party notices

## Hermes Agent

来源仓库：https://github.com/NousResearch/hermes-agent
Hermes checkout HEAD：`dce1e9b37581dd62e480a9064dc04a709c2940d3`。以下 hash 标识本轮实际读取的源码；HEAD 不代表工作树无改动。

Copyright (c) 2025 Nous Research。MIT 完整许可证见 `third-party/licenses/hermes-agent-MIT.txt`。

| 原文件 | SHA-256 | 参考和移植范围 |
| --- | --- | --- |
| `apps/desktop/src/lib/preview-act/visibility.ts` | `785708f3dbb73300977686363a2d577647159dc471b5696b04e025a70de475ba` | 53–143：交互视觉检查，改编到 page-semantics/index.js；沿用插件组合树、缓存和恢复扫描，遮挡保留提示。 |
| `apps/desktop/src/lib/preview-act/act-in-page.ts` | `0f8052df4c1e0f930449122802bdfef57a2af0d072daa2afa923417a426813bf` | 559–573：富文本编辑机制；未复制 execCommand/textContent 兜底和自动提交。 |
| `apps/desktop/src/app/chat/right-rail/preview-act.ts` | `a2aad2f4c46813c0c49b9cb748bed603db0aa4111faa5b9881466a3a9513434d` | 283–334、585–645、662–685：动作后重采集、焦点与全选输入机制；在 native-extension/core.mjs 复用已有授权和 CDP 窗口。 |

S2 独立调整插件已有 full/delta 的 UTF-8 序列化大小选择；没有引用或复制 identity.ts。未移植 anchortree re-bind ladder、Liveblocks 箭头几何或任何 S5–S7。

扩展构建和 Executor 候选打包将此声明及完整 MIT 许可复制到各自包内相同相对路径，纳入构建身份哈希和来源快照。
