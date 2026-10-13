# 从 GitHub 自动安装并验证

将下面提示词发送给能执行本机命令的 agent。默认使用独立 skills 模式。

```text
请从 https://github.com/fanjing188/fast-browser-link 的正式 Releases 自动下载安装 Fast-browser-link，并实际调用验证。

1. 使用 GitHub API 或 gh 获取真实 Release 附件，选择 fast-browser-link-<版本>.zip；不要选择 Source code 或带 -hermes- 的适配器包。
2. 校验发布的 ZIP SHA256 和包内 SHA256SUMS.json，在独立目录解压；仓库或附件不可用时如实停止，不猜测 URL。
3. 阅读安装说明，检查 macOS、Python 3.11+ 和目标目录。已有安装不覆盖、不删除。
4. 记录原 Hermes 配置、插件及 Native host 文件的摘要。保留所有现有插件、数据和标签页。
5. 先运行 bash install.sh --dry-run，再运行 bash install.sh。不要加 --hermes-plugin，不开启 tools.override，不修改 Hermes 源码或 config.yaml。
6. 在日常使用的 Chrome/Edge 中，通过正常扩展管理界面加载输出的 extension 目录。新版扩展 ID 为 hhnljehnkmhhgjjjmnlhilfpcjhobloc；保留旧扩展启用。不要装进其他应用的专用浏览器或临时 profile。
7. 读取 ~/.agents/skills/fast-browser-link/SKILL.md，使用其 scripts/browser.py 验证 health、browsers、公开网页读取，以及本机测试页的填写、点击和回读。不要向真实网站提交测试数据。
8. 关闭本次创建的任务，核对清理成功和旧安装文件未变。报告 Release URL、摘要、安装位置及验证结果。

请实际执行。文件复制成功或 health 正常，不等于浏览器调用验证通过；需要用户确认时说明具体步骤。
```

通用包无需 Node.js 或 Hermes。浏览器对未上架扩展的首次确认仍然适用；纯云端、不能执行本机命令的 agent 无法直接使用本机 skill。
