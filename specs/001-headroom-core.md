# 001: Headroom Core — Context Window Usage Monitor

## Status

draft

## Summary

在 AI 聊天平台（首期 DeepSeek）的浏览器原生侧边栏中，实时展示当前对话的 token 累计消耗占 context window limit 的百分比，并提供三级颜色预警（绿/橙/红），帮助专业用户在 AI 遗忘上下文前主动开新对话。

## Motivation

### 痛点

当专业用户在 AI 聊天网页端进行长对话时（架构讨论、代码评审、技术调研），context window 会被逐渐填满。AI 不会告诉你"我已经忘了你第 3 轮说的关键约束"——它只是悄无声息地丢失细节，输出质量下降但用户不知道原因。

**没有一个主流 AI 聊天平台在 UI 上展示 context window 剩余空间。** Headroom 填补这个空白。

### 不是什么

- 不是 token 计费/成本监控工具。AI 模型越来越便宜，计费不是问题。
- 是**上下文质量保障工具**——确保 AI 没有悄悄遗忘关键信息。

### 目标用户

日常使用 AI 聊天网页版的专业人士（开发者、研究者、写作者、分析师）。他们不仅用 Claude Code/Codex/Hermes，也花大量时间在 DeepSeek、ChatGPT、Gemini 等网页端进行深度对话。

## Requirements

### P0 — 核心功能

- [ ] **实时 Token 统计**：统计当前对话的累计 token 数（当前轮次 + 历史累计）
- [ ] **Context Window 占比可视化**：以进度条 + 百分比形式展示已用 token 占当前模型 context window limit 的比例
- [ ] **三级颜色预警**：
  - 🟢 绿色：占比 < 阈值（默认 50%）
  - 🟠 橙色：占比 ≥ 橙色阈值（默认 50%）且 < 红色阈值（默认 70%）
  - 🔴 红色：占比 ≥ 红色阈值（默认 70%）
- [ ] **模型自动识别**：检测当前 AI 聊天使用的模型（如 DeepSeek-V3、DeepSeek-R1），自动匹配对应的 context window limit
- [ ] **BYOK Upstash 云端同步**：每轮问答结束后，将对话 metadata 写入用户自有的 Upstash KV 存储（用户自行申请免费实例、配置 API Key）
- [ ] **DeepSeek 平台适配**：首期支持 chat.deepseek.com 页面的对话数据采集

### P1 — 增强功能

- [ ] **对话轮次计数**：显示当前对话的问答轮次数
- [ ] **URL 作用域控制**：仅在匹配 URL 上激活，非匹配页面扩展图标灰化、sidepanel 不响应
- [ ] **用户设置面板**：
  - 自定义三级预警阈值（绿/橙/红）
  - 覆盖模型的 context window size
  - 配置 Upstash URL 和 API Token
- [ ] **侧边栏开关**：点击扩展图标打开/关闭原生侧边栏

## Browser Support

Headroom **仅支持 Manifest V3**（不支持 MV2），需较新浏览器版本：

| 浏览器         | 最低版本 |
| -------------- | -------- |
| Google Chrome  | ≥ 149    |
| Microsoft Edge | ≥ 149    |
| Firefox        | ≥ 151    |

架构与实现均基于 MV3；Firefox 端通过 `sidebarAction` 提供原生侧边栏。

> **决策：不兼容 Firefox MV2。** Chrome/Edge 已强制 MV3，后台必须按 service worker 语义编写（状态持久化到 `browser.storage.local`、唤醒后重建）；Firefox MV3 用 event page（`background.scripts`），更宽松、天然兼容，WXT 自动按目标浏览器生成分流 manifest。再支持 MV2 只会多一条后台生命周期路径和测试矩阵，不省任何代码——因为最严的 service worker 模型由 Chrome 锁定，无法靠 MV2 绕开。

## Design

### Architecture

```
┌─────────────────────────────────────────────────────┐
│  Browser (Chrome / Edge / Firefox)                   │
│                                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │  Side Panel   │  │  Background  │  │  Content   │ │
│  │  (UI 展示)    │  │  Service     │  │  Script    │ │
│  │               │  │  Worker      │  │  (DeepSeek)│ │
│  │  - 进度条     │◄─►│              │◄─►│            │ │
│  │  - 占比 %     │  │  - token 计算│  │  - DOM 解析│ │
│  │  - 预警颜色   │  │  - 预警判断  │  │  - 网络拦截│ │
│  │  - 轮次数     │  │  - Upstash   │  │  - 模型检测│ │
│  │  - 设置面板   │  │    同步      │  │  - 轮次检测│ │
│  └──────────────┘  └──────┬───────┘  └────────────┘ │
│                           │                          │
└───────────────────────────┼──────────────────────────┘
                            │
                     ┌──────▼───────┐
                     │  Upstash KV  │
                     │  (用户私有)   │
                     └──────────────┘
```

### Entrypoints

| Entrypoint     | 文件                                           | 职责                                                                                             |
| -------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Side Panel     | `entrypoints/sidepanel/index.html` + `main.ts` | 原生侧边栏 UI 展示：进度条、占比、预警颜色、轮次数、设置面板                                     |
| Content Script | `entrypoints/deepseek.content.ts`              | DeepSeek 页面数据采集：DOM 解析/网络拦截获取对话内容、检测模型、检测轮次完成                     |
| Background     | `entrypoints/background.ts`                    | 消息桥接（sidepanel ↔ content script）、token 计算（js-tiktoken）、预警等级判断、Upstash KV 读写 |

### Data Flow

```
1. 用户在 DeepSeek 页面进行问答
2. Content Script 检测到新一轮问答完成
   → 提取对话文本 + 当前模型信息 + conversation_id
   → 发送消息到 Background

3. Background Service Worker 收到消息
   → 使用 js-tiktoken 计算 token 数
   → 从 Upstash KV 读取该对话的历史累计 token
   → 计算新累计：历史 + 当前轮次
   → 判断预警等级（对比阈值）
   → 写入 Upstash KV：更新对话 metadata
   → 发送更新消息到 Side Panel

4. Side Panel 收到更新消息
   → 更新进度条、占比百分比、预警颜色、轮次数
```

### Data Model (Upstash KV)

**Key 设计：** 扁平 key + 前缀，适合 Redis KV 操作

```
# 对话数据 — 每个对话一个 key
headroom:conv:{platform}:{conversation_id}

# 用户设置 — 单个 key
headroom:settings
```

**对话 metadata 结构：**

```json
{
  "model": "deepseek-v3",
  "context_window_limit": 131072,
  "total_tokens": 49750,
  "round_count": 12,
  "last_round_tokens": 1520,
  "created_at": "2026-06-09T08:00:00Z",
  "updated_at": "2026-06-09T10:30:00Z"
}
```

**用户设置结构：**

```json
{
  "thresholds": { "green": 0.5, "orange": 0.7, "red": 1.0 },
  "model_overrides": {
    "deepseek-chat": 65536,
    "gpt-4o": 131072
  },
  "upstash_url": "https://xxx.upstash.io",
  "upstash_token": "AxXX...xxx"
}
```

### UI (Side Panel)

```
┌─────────────────────────┐
│  Headroom            ⚙️  │  ← 标题 + 设置按钮
│                         │
│  DeepSeek-V3            │  ← 当前模型
│  Context: 128K          │  ← Context window limit
│                         │
│  ████████████░░░░░░░░░  │  ← 进度条（带颜色）
│  49,750 / 131,072       │  ← token 数
│  38.0%                  │  ← 占比百分比
│                         │
│  🟢 Plenty of room      │  ← 预警状态文字
│                         │
│  Round: 12              │  ← 对话轮次
│  Last round: 1,520      │  ← 上一轮 token
│                         │
│  ─────── Settings ──────│  ← 设置区域（可折叠）
│  Warning Thresholds:    │
│  🟢 < 50%  🟠 50%  🔴 70%│
│  Upstash: ✓ Connected   │
└─────────────────────────┘
```

### Browser APIs

| API                                           | 用途                                             |
| --------------------------------------------- | ------------------------------------------------ |
| `browser.sidePanel` / `browser.sidebarAction` | 原生侧边栏（WXT 自动适配）                       |
| `browser.runtime.sendMessage` / `onMessage`   | Sidepanel ↔ Background ↔ Content Script 消息通信 |
| `browser.storage.local`                       | 本地缓存（Upstash 数据的本地镜像，离线可用）     |
| `browser.action.setIcon`                      | 非匹配页面图标灰化                               |
| `browser.tabs.onUpdated`                      | 监听 tab URL 变化，判断是否在匹配页面            |

### Platform Adapter Pattern

平台无关架构，每个 AI 聊天平台一个适配器：

```typescript
// utils/platform-adapter.ts
interface PlatformAdapter {
  platformId: string; // "deepseek" | "chatgpt" | "gemini" | ...
  matchPatterns: string[]; // ["*://chat.deepseek.com/*"]
  detectModel(): string; // 从页面检测当前模型
  getConversationId(): string; // 从页面提取对话 ID
  getConversationText(): string; // 获取当前对话文本
  getRoundCount(): number; // 获取对话轮次
  isResponseComplete(): boolean; // 检测 AI 回复是否完成
}
```

### 内置模型配置表

| 模型              | Context Window (tokens) |
| ----------------- | ----------------------- |
| deepseek-v3       | 131,072 (128K)          |
| deepseek-r1       | 131,072 (128K)          |
| deepseek-chat     | 65,536 (64K)            |
| deepseek-reasoner | 131,072 (128K)          |

用户可通过设置覆盖。

## Implementation Plan

### Phase 1: 基础骨架

1. 创建 sidepanel entrypoint（`entrypoints/sidepanel/index.html` + `main.ts`）
2. 创建 background entrypoint（`entrypoints/background.ts`）
3. 创建 DeepSeek content script（`entrypoints/deepseek.content.ts`）
4. 搭建消息通信桥（sidepanel ↔ background ↔ content script）
5. 配置 URL 匹配规则和图标灰化逻辑

### Phase 2: 数据采集 + Token 计算

6. 实现平台适配器接口（`PlatformAdapter`）
7. 调试 DeepSeek 页面，确定数据采集策略（DOM 解析 vs 网络拦截）
8. 实现模型自动检测
9. 集成 js-tiktoken，实现 token 计算
10. 实现对话轮次检测和 conversation_id 提取

### Phase 3: Upstash 集成

11. 设计 Upstash KV 读写工具函数
12. 实现每轮问答结束后的数据同步
13. 实现侧边栏打开时的数据加载
14. 实现 BYOK 配置（用户填写 Upstash URL + Token）

### Phase 4: UI + 预警

15. 实现进度条 + 占比百分比 UI
16. 实现三级颜色预警逻辑
17. 实现设置面板（阈值调整、模型覆盖、Upstash 配置）
18. 实现本地缓存（browser.storage.local 作为 Upstash 的本地镜像）

## Acceptance Criteria

- [ ] 在 DeepSeek 页面点击扩展图标，原生侧边栏打开，显示 Headroom UI
- [ ] 进行一轮问答后，侧边栏实时更新 token 数和占比
- [ ] 占比超过 50% 时进度条变橙色，超过 70% 时变红色
- [ ] 阈值可在设置面板中自定义
- [ ] 自动检测当前使用的模型并显示对应的 context window limit
- [ ] 每轮问答结束后数据成功写入用户配置的 Upstash KV
- [ ] 非匹配页面点击扩展图标不打开侧边栏，图标灰化
- [ ] 在 Chrome、Edge、Firefox 三浏览器均可正常运行

## Open Questions

- [ ] DeepSeek 页面的数据采集策略：DOM 解析 vs 网络拦截 vs 混合方案？需要在 Phase 2 实际调试后确定
- [ ] DeepSeek 页面中 conversation_id 的获取方式？需调试确认
- [ ] DeepSeek 页面中模型切换的检测方式？需调试确认
- [ ] js-tiktoken 词表文件的大小和处理方式（可能需要仅打包 cl100k_base 词表）

## Implementation Notes

> 实现完成后填写：偏差、技术决策、踩坑记录。
