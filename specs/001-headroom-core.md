# 001: Headroom Core — Context Window Usage Monitor

## Status

implemented (runtime verification pending — see Acceptance Criteria)

## Summary

在 AI 聊天平台的浏览器原生侧边栏中，实时展示当前对话的 token 累计消耗占 context window limit 的百分比，并提供三级颜色预警（绿/橙/红），帮助专业用户在 AI 遗忘上下文前主动开新对话。

支持 7 家平台：DeepSeek、ChatGPT、Gemini、Kimi、Qwen、通义千问、豆包。

## Motivation

### 痛点

当专业用户在 AI 聊天网页端进行长对话时（架构讨论、代码评审、技术调研），context window 会被逐渐填满。AI 不会告诉你"我已经忘了你第 3 轮说的关键约束"——它只是悄无声息地丢失细节，输出质量下降但用户不知道原因。

**没有一个主流 AI 聊天平台在 UI 上展示 context window 剩余空间。** Headroom 填补这个空白。

### 不是什么

- 不是 token 计费/成本监控工具。AI 模型越来越便宜，计费不是问题。
- 是**上下文质量保障工具**——确保 AI 没有悄悄遗忘关键信息。

### 目标用户

日常使用 AI 聊天网页版的专业人士（开发者、研究者、写作者、分析师）。

## Requirements

### P0 — 核心功能

- [x] **实时 Token 统计**：统计当前对话的累计 token 数（当前轮次 + 历史累计）
- [x] **Context Window 占比可视化**：进度条 + 百分比
- [x] **三级颜色预警**（阈值可在设置面板自定义）：
  - 🟢 绿色（安全）：占比 < 黄色阈值（默认 50%）
  - 🟡 黄色（中度）：黄色阈值 ≤ 占比 < 红色阈值（默认 50% / 70%）
  - 🔴 红色（紧张）：占比 ≥ 红色阈值（默认 70%）
- [x] **平台识别 + context 匹配**：识别当前平台并匹配 context window limit
- [x] **BYOK Upstash 云端同步**：每轮问答结束后，将对话 metadata 写入用户自有的 Upstash KV 存储。无 Upstash 时本地 tally 兜底。
- [x] **多平台适配**：7 家平台（见下表）

### P1 — 增强功能

- [x] **对话轮次计数**
- [x] **URL 作用域控制**：非匹配页面扩展图标灰化（`action.disable`）、sidepanel 不响应
- [x] **用户设置面板**：预警阈值（双滑块）、Upstash 配置（测试连接/显式保存/清空）、语言切换（中/英/跟随浏览器）
- [x] **context window 覆盖**：用户可在设置面板按平台自定义 context limit；默认值取各 adapter 的 `contextLimit`（自动检测），缺省时回退到 adapter 默认。
- [x] **侧边栏开关**：点击扩展图标打开/关闭原生侧边栏

## Browser Support

**仅支持 Manifest V3**（不支持 MV2），需较新浏览器版本：

| 浏览器         | 最低版本 |
| -------------- | -------- |
| Google Chrome  | ≥ 149    |
| Microsoft Edge | ≥ 149    |
| Firefox        | ≥ 151    |

> **决策：不兼容 Firefox MV2。** Chrome/Edge 已强制 MV3，后台必须按 service worker 语义编写（状态持久化到 `browser.storage.local`、唤醒后重建）；Firefox MV3 用 event page，更宽松。再支持 MV2 只会多一条后台生命周期路径和测试矩阵，不省任何代码——最严的 service worker 模型由 Chrome 锁定，无法靠 MV2 绕开。

## Design

### Architecture

```
┌─────────────────────────────────────────────────────┐
│  Browser (Chrome / Edge / Firefox)                   │
│                                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │  Side Panel   │  │  Background  │  │  Content   │ │
│  │  (UI 展示)    │  │  Service     │  │  Script    │ │
│  │               │  │  Worker      │  │ (所有平台) │ │
│  │  - 进度条     │◄─►│              │◄─►│            │ │
│  │  - 占比 %     │  │  - token 估算│  │  - DOM 抓取│ │
│  │  - 预警颜色   │  │  - 预警判断  │  │  - 轮次检测│ │
│  │  - 轮次数     │  │  - Upstash   │  │            │ │
│  │  - 设置面板   │  │    同步      │  │            │ │
│  └──────────────┘  └──────┬───────┘  └────────────┘ │
└───────────────────────────┼──────────────────────────┘
                            │
                     ┌──────▼───────┐
                     │  Upstash KV  │
                     │  (用户私有)   │
                     └──────────────┘
```

三个 entrypoint：`entrypoints/sidepanel/`（UI）、`entrypoints/background.ts`（引擎，含 webRequest 拦截 + action 灰化）、`entrypoints/platform.content.ts`（**单一** content script，按 adapter matchPattern 注入，覆盖所有平台）。

### Data Flow

```
1. 用户在平台页面发消息
2. webRequest 拦截发送请求 → 解析 prompt + dialogueId
3. Content Script 检测 AI 回复完成 → 抓取回复文本 → 发到 Background
4. Background 配对 prompt + answer，估算 token，累计（Upstash 或本地）
   → 计算预警等级 → 广播到 Side Panel
5. Side Panel 更新进度条/占比/颜色/轮次
```

### Data Model

**存储分层**：Upstash KV 是云端主存储（跨会话持久），`browser.storage.local` 是兜底（无 Upstash 时作为唯一 tally 来源）。

```
headroom:conv:{platform}:{dialogueId}   # 对话累计（Upstash）
headroom:settings                        # 用户设置（仅 local）
headroom:active-state                    # 当前活动对话状态镜像（仅 local）
```

> 对话记录的 `rounds[]` 按上限滚动裁剪，但 `totalTokens`/`roundCount` 始终是真实累计值（裁剪数组 ≠ 丢失累计）——这是最易出 bug 的地方，有不变式测试守护。具体结构见 `utils/dialogue-record.ts`。

> `upstash` 凭证是 **REST API 对**（`UPSTASH_REDIS_REST_URL` + `_TOKEN`），不是 Redis 密码；浏览器扩展只能走 HTTPS REST。具体结构见 `utils/settings.ts`。

### UI (Side Panel)

主视图 + 设置视图切换（⚙️ 进入设置）：

```
┌─── 主视图 ──────────────┐    ┌─── 设置视图 ───────────────┐
│  Headroom            ⚙️  │    │  ← 返回                     │
│  DeepSeek               │    │  预警阈值 🟡50% 🔴70%        │
│  Context: 1M            │    │  语言 [自动 ▾]               │
│  ██░░░░░░  5.0%         │    │  Upstash URL/Token/测试/清空 │
│  🟢 空间充足             │    │  [保存设置]                  │
│  Round: 12  Last: 1,520 │    └─────────────────────────────┘
└─────────────────────────┘
```

第一行显示**平台名**（v1 不检测具体模型，用 adapter 固定 contextLimit）。

### Browser APIs

| API                                           | 用途                                              |
| --------------------------------------------- | ------------------------------------------------- |
| `browser.sidePanel` / `browser.sidebarAction` | 原生侧边栏（WXT 自动适配）                        |
| `browser.runtime.sendMessage` / `onMessage`   | Sidepanel ↔ Background ↔ Content Script 消息通信  |
| `browser.storage.local`                       | 设置 + 活动状态 + 无 Upstash 时的本地 tally       |
| `browser.action.enable` / `disable(tabId)`    | 非匹配页面禁用 action（Chrome 自动置灰 + 不可点） |
| `browser.tabs.onActivated` / `onUpdated`      | 同步 action enable/disable                        |
| `browser.webRequest.onBeforeRequest`          | 读取发送请求体，提取 prompt + dialogueId          |

### Platform Adapter Pattern

每个平台一个 `PlatformAdapter`（`adapters/<platform>.ts`），封装：webRequest 匹配 URL、请求体解析（prompt + dialogueId）、context window limit、DOM 选择器。background 是平台无关引擎；新增平台 = 加一个 adapter + 注册 + host_permissions。

各平台 context window 默认值（取各 adapter 的 `contextLimit`；用户可在设置面板按平台覆盖）：

| 平台     | 页面 host         | API host          | Context (默认) | 请求体解析                                                 |
| -------- | ----------------- | ----------------- | -------------- | ---------------------------------------------------------- |
| DeepSeek | chat.deepseek.com | chat.deepseek.com | 1,000,000      | ✅ prompt + `chat_session_id`                              |
| ChatGPT  | chatgpt.com       | chatgpt.com       | 128,000        | ✅ `content.parts[0]` + `conversation_id`                  |
| Gemini   | gemini.google.com | —（纯 DOM）       | 1,000,000      | ❌ `f.req` 不可解析 → 全走 DOM                             |
| Kimi     | www.kimi.com      | www.kimi.com      | 200,000        | ✅ `blocks[0].text.content` + `chat_id`（新会话首条无 id） |
| Qwen     | chat.qwen.ai      | chat.qwen.ai      | 131,072        | ✅ prompt + `chat_id`（URL query）                         |
| 通义千问 | www.qianwen.com   | chat2.qianwen.com | 131,072        | ✅ `messages[0].content` + `session_id`                    |
| 豆包     | www.doubao.com    | www.doubao.com    | 256,000        | ✅ prompt（`content` 是字符串化 JSON）                     |

> 7 家 DOM 选择器 + API host/path 全部经 Playwright 登录实测确认（2026-06）。

## Acceptance Criteria

> 以下代码层面已实现，checkbox 标记**运行时验证**状态（均待真实浏览器测试）。

- [ ] 在平台页面点击扩展图标，原生侧边栏打开，显示 Headroom UI
- [ ] 进行一轮问答后，侧边栏实时更新 token 数和占比
- [ ] 占比超过阈值时进度条变色（黄/红）
- [ ] 阈值可在设置面板中自定义
- [ ] 显示当前平台的 context window limit
- [ ] 每轮问答后数据写入用户配置的 Upstash KV
- [ ] 非匹配页面图标灰化且点击不打开侧边栏
- [ ] Chrome、Edge、Firefox 三浏览器均可正常运行

## Open Questions

- [x] 数据采集：**混合**——webRequest 读请求体拿 prompt + dialogueId，DOM 抓 AI 回复文本。响应流不读（MV3 拿不到响应体；真实 token 需 `debugger` API，留作精度升级）。
- [x] Token 计算：**估算**（CJK≈1 token/字，其余≈4 字/token），不打包 js-tiktoken（词表太重且各模型编码不同）。
- [x] DOM 选择器 + API host/path：7 家全部经 Playwright 实测确认。
- [x] context window 覆盖：设置面板按平台可覆盖默认 context limit（默认值来自 adapter，已实现，待运行时验证）。
- [ ] 运行时验收：Acceptance Criteria 8 条均待真实浏览器验证。
