# Headroom

> 知道你的 AI 什么时候快要"忘事"了。

**Headroom** 是一个浏览器扩展，在 AI 聊天对话中实时显示 context window 剩余空间——在你的 AI 开始悄悄遗忘重要细节之前提醒你。

## 问题

当你和 AI 进行一段很长的对话（DeepSeek、Gemini、Claude、ChatGPT……），你可能遇到过这些情况：

- AI 忘记了你 10 轮之前提到的一个关键约束
- 它开始和对话前半部分的内容自相矛盾
- 输出质量悄悄下降，但你不知道为什么

这是因为 **context window 有上限**，当它被填满后，AI 会悄无声息地丢弃早期信息。所有主流 AI 聊天平台都没有告诉你 context 还剩多少。这是一个**沉默的杀手**。

## 解决方案

Headroom 显示在浏览器的原生侧边栏中，实时可视化你的 context window 使用情况：

- 🟢 **绿色** — 空间充裕，继续聊
- 🟠 **橙色** — 开始占满了，注意一下
- 🔴 **红色** — 快满了，考虑开新对话

阈值可以自定义。扩展会自动检测你正在使用的模型，计算正确的 context window 上限。

## 面向谁

**在日常工作中使用 AI 聊天的专业人士** — 开发者、研究者、写作者、分析师。

如果你花大量时间在 AI 聊天界面中进行架构讨论、代码评审、深度调研、技术文档撰写，Headroom 帮你保持对话质量，让你时刻知道 context 什么时候快用完了。

这**不是**一个 token 计费工具。AI 模型越来越便宜，计费不是问题。真正的问题是**上下文质量**：确保你的 AI 没有悄悄遗忘什么关键的东西。

## 工作原理

1. **安装扩展** — Chrome、Edge 或 Firefox
2. **使用你自己的 Upstash KV** — 注册免费 [Upstash](https://upstash.com/) 账号，创建一个 Redis KV 实例，把 API key 填入扩展设置。你的数据存在你自己的私有存储中。
3. **在支持的 AI 聊天平台打开侧边栏** — Headroom 自动追踪你的对话 token 消耗
4. **看着指示器** — 随着对话进行，Headroom 显示 context 还剩多少

## 支持平台

| 平台             | 状态           |
| ---------------- | -------------- |
| DeepSeek         | 🚧 开发中 (v1) |
| 更多平台即将支持 | —              |

采用平台无关架构设计——添加新的 AI 聊天平台只需编写一个新的内容适配器。

## 技术栈

- **[WXT](https://wxt.dev/)** — 下一代 Web 扩展框架 (Manifest V3)
- **原生 Side Panel API** — 浏览器原生侧边栏 (Chrome `sidePanel`、Firefox `sidebarAction`)
- **js-tiktoken** — 客户端 token 计算
- **Upstash Redis KV** — 用户自有云存储（BYOK 模式）

## 开发

```bash
npm install
npm run dev            # 开发模式 (Chrome 默认)
npm run dev:firefox    # Firefox 开发模式
npm run build          # 生产构建
```

详见 [CLAUDE.md](./CLAUDE.md) 获取完整开发指南和架构详情。

## 许可证

MIT
