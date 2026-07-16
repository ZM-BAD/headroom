# Headroom

> 知道你的 AI 什么时候快要"忘事"了。

[English](./README.md) | **简体中文**

**Headroom** 是一个浏览器扩展，在 AI 聊天对话中实时显示 context window 剩余空间——在你的 AI 开始悄悄遗忘重要细节之前提醒你。

## 问题

当你和 AI 进行一段很长的对话（DeepSeek、Gemini、ChatGPT……），你可能遇到过这些情况：

- AI 忘记了你 10 轮之前提到的一个关键约束
- 它开始和对话前半部分的内容自相矛盾
- 输出质量悄悄下降，但你不知道为什么

这是因为 **context window 有上限**，当它被填满后，AI 会悄无声息地丢弃早期信息。所有主流 AI 聊天平台都没有告诉你 context 还剩多少。这是一个**沉默的杀手**。

## 解决方案

Headroom 显示在浏览器的原生侧边栏中，实时可视化你的 context window 使用情况：

- 🟢 **绿色** — 空间充裕，继续聊
- 🟠 **黄色** — 开始占满了，注意一下
- 🔴 **红色** — 快满了，考虑开新对话

阈值可以自定义。扩展会自动识别你所在的 AI 平台，匹配对应的 context window 上限（可按平台覆盖）。

## 面向谁

**在日常工作中使用 AI 聊天的专业人士** — 开发者、研究者、写作者、分析师。

如果你花大量时间在 AI 聊天界面中进行架构讨论、代码评审、深度调研、技术文档撰写，Headroom 帮你保持对话质量，让你时刻知道 context 什么时候快用完了。

这**不是**一个 token 计费工具。AI 模型越来越便宜，计费不是问题。真正的问题是**上下文质量**：确保你的 AI 没有悄悄遗忘什么关键的东西。

## 工作原理

1. **安装扩展** — Chrome、Edge 或 Firefox，无需注册任何账号，无需任何配置
2. **在支持的 AI 聊天平台打开侧边栏** — Headroom 从平台拉取该对话的完整历史，估算你的 token 消耗
3. **看着指示器** — 随着对话进行，Headroom 显示 context 还剩多少

就这么简单。而且由于对话历史本来就存在 AI 平台自己的服务器上，计数天然跨设备——换一台机器打开同一个对话，Headroom 会重新拉取完整历史、从头重建计数。

### 需要 Upstash 吗？（不需要——它是可选的）

不配置任何云服务，Headroom 就是完整可用的：仪表盘、逐轮明细、阈值告警全部基于平台自己的历史数据工作。对大多数用户的大多数场景，这就是全部。

你也可以选择接入自己的 [Upstash](https://upstash.com/) Redis KV——注册免费账号，创建一个 KV 实例，把 REST 凭据填入扩展设置（BYOK：数据存在你自己的私有存储中，凭据绝不离开你的浏览器）。接入后额外获得：

- **设置跨设备同步** — 阈值、语言、各平台上下文上限、token 系数覆盖，在一台设备上保存后，另一台设备下次打开面板即自动生效。
- **极端场景的计数保底** — 正常情况下 7 个平台都能一次拉全历史，但当平台的历史接口偶发拉不全时（超长对话触发分页上限、分页拉取中断、删除或重新生成某轮），云端记录会保留已经计过的轮次，累计数不会悄悄缩水。

### Upstash 是免费的吗？

对任何合理的个人使用都免费。Upstash 免费层（[定价](https://upstash.com/pricing/redis)）包含 **256 MB 存储**和**每月 50 万次命令**。每轮问答约消耗 2 次命令（一次读 + 一次写），50 万/月约可支撑 25 万轮——远超单用户实际产生量。Headroom 每轮只存 token 计数（不存对话文本），存储完全不构成瓶颈（50 轮对话约 4 KB，256 MB 可存约 6.5 万个对话）。

## 参与贡献

欢迎 Bug 反馈、功能建议和代码贡献！

- **遇到问题？** → [提交 issue](https://github.com/ZM-BAD/headroom/issues/new/choose)
- **想要贡献代码？** → 阅读 [贡献指南](./CONTRIBUTING.md)
- **帮忙测试？** → 查看标记了 `needs-test` 的 [开放 issue](https://github.com/ZM-BAD/headroom/issues)

## 浏览器支持

Headroom **仅支持 Manifest V3**（不支持 MV2），需要较新的浏览器版本：

| 浏览器         | 最低版本 |
| -------------- | -------- |
| Google Chrome  | ≥ 149    |
| Microsoft Edge | ≥ 149    |
| Firefox        | ≥ 151    |

### 已知平台差异

| 行为                     | Chrome | Edge                 | Firefox                    |
| ------------------------ | ------ | -------------------- | -------------------------- |
| 非 AI 页面图标变灰       | ✅     | ✅                   | ✅                         |
| 离开 AI 页面面板自动关闭 | ✅     | ✅                   | ❌（侧栏内容切换为提示页） |
| 回到 AI 页面面板自动恢复 | ✅     | ❌（需手动点击图标） | ✅（内容自动恢复）         |

**Edge 限制：** `sidePanel.setOptions({ enabled: true })` 从非 AI 页面切回后不会自动恢复面板。Microsoft 已确认这是"设计如此"（[issue #222](https://github.com/microsoft/MicrosoftEdge-Extensions/issues/222)，2024年11月创建，至今未修复）。替代方案：点击工具栏图标手动打开。

**Firefox 限制：** `sidebarAction.close()` 需要用户手势，标签页切换不算用户手势，因此侧栏无法程序化关闭，必须用户手动关闭。切换到非 AI 页面时，侧栏内容通过 `sidebarAction.setPanel()` 切换为提示页。三个 AI 平台交叉验证确认这是 Firefox 硬性平台限制，无 workaround。

## 支持平台

| 平台     | 发送请求  | Context（默认） |
| -------- | --------- | --------------- |
| DeepSeek | ✅ 已确认 | 1M              |
| ChatGPT  | ✅ 已确认 | 128K            |
| Gemini   | ✅ 已确认 | 1M              |
| Kimi     | ✅ 已确认 | 256K            |
| Qwen     | ✅ 已确认 | 1M              |
| 通义千问 | ✅ 已确认 | 1M              |
| 豆包     | ✅ 已确认 | 256K            |

7 家平台的发送请求解析、删除请求解析、DOM 选择器均经真机实测确认（2026-06）。采用平台无关的适配器架构——新增 AI 聊天平台只需编写一个新适配器。

## 技术栈

- **[WXT](https://wxt.dev/)** — 下一代 Web 扩展框架 (Manifest V3)
- **原生 Side Panel API** — 浏览器原生侧边栏 (Chrome `sidePanel`、Firefox `sidebarAction`)
- **启发式 token 估算** — 六路文字系统系数引擎（中日韩/假名/谚文/西里尔/阿拉伯/拉丁）；汉字类按字计，单词类按词计。不打包重型 tokenizer（保持扩展轻量、模型无关）
- **Upstash Redis KV** — 可选的用户自有云存储（BYOK 模式）

## 开发

```bash
npm install
npm run dev            # 开发模式 (Chrome 默认)
npm run dev:firefox    # Firefox 开发模式
npm run build          # 生产构建
```

详见 [AGENTS.md](./AGENTS.md) 获取完整开发指南和架构详情。

## 隐私

Headroom 读取你的对话文本仅用于计算 token——它**只存储计数**，绝不存储文本本身，数据存在你的设备和**你自己的** Upstash KV（如已配置）。Headroom 没有自建服务器，没有第三方追踪。详见 [PRIVACY.md](./PRIVACY.md)。

## 许可证

Copyright 2026 ZM-BAD。

基于 **Apache License, Version 2.0** 授权 — 详见 [LICENSE](./LICENSE)。你可以在以下地址获取协议副本：

    http://www.apache.org/licenses/LICENSE-2.0

除非适用法律要求或书面同意，否则依据本协议分发的软件均按"原样"分发。
