# 001: Headroom Core — Context Monitor + 估算引擎 + 适配器基座

## Status

重写版（目标产品形态）。本 spec 不依赖当前代码实现；代码需按本 spec 重构。

**范围定位**：单设备即时层。仪表盘纯本地工作，不依赖云端，**可独立发布**。跨设备同步、对账、删除联动归 [003](./003-cross-device-sync.md)；Upstash 传输管道归 [002](./002-upstash-data-layer.md)。

## Summary

在 AI 聊天平台的浏览器原生侧边栏中，实时展示当前对话 token 累计消耗占 context window 的百分比，并提供三级颜色预警（绿/橙/红）。内置可按「平台 × 文字脚本」配置的 **token 估算引擎**，以及平台无关的**适配器架构**（首期 DeepSeek 全实现）。

核心立场：**token 永远是"拿到文本后估算出来的"**——平台不告诉你 context 用了多少，而平台也大概率不存每轮 token，所以真值是平台历史的**文本内容**，token 由我们用系数矩阵换算。本 spec 只做单设备即时层；把这份估算能力和 002 的管道组合成跨设备对账，是 003 的事。

## Motivation

### 痛点

专业用户在 AI 聊天网页端进行长对话（架构讨论、代码评审、技术调研）时，context window 被逐渐填满。AI 不会告诉你"我已经忘了你第 3 轮说的关键约束"——它只是悄无声息地丢失细节，输出质量下降但用户不知道原因。

**没有一个主流 AI 聊天平台在 UI 上展示 context window 剩余空间。** Headroom 填补这个空白。

### 不是什么

- 不是 token 计费/成本监控工具。模型越来越便宜，计费不是问题。
- 是**上下文质量保障工具**——确保 AI 没有悄悄遗忘关键信息。

### 为什么估算引擎是一等公民

要知道 context 用了多少，就得算 token。算 token 有两条路：

- **打包各家 tokenizer**：词表巨大、各模型编码不同、会让扩展变重且强绑定模型。
- **估算**：轻量、模型无关，精度靠「平台 × 脚本」系数矩阵保证。

Headroom 选估算。v1 做中文（CJK）+ 英文（Latin）两种脚本；更多脚本（西/德/法/日/俄/葡/阿…）与按平台 tokenizer 精确校准，见 [004](./004-optimizations.md)。

### 目标用户

日常使用 AI 聊天网页版的专业人士（开发者、研究者、写作者、分析师）。

## Requirements

### P0 — 核心

- [ ] **实时 context 占比可视化**：进度条 + 百分比
- [ ] **三级颜色预警**（阈值可在设置面板自定义，双滑块）：🟢 绿（< 黄阈值，默认 50%）/ 🟡 黄（黄≤占比<红，默认 50%/70%）/ 🔴 红（≥ 红阈值）
- [ ] **平台识别 + context 匹配**：domain → platform，匹配该平台 context window limit；用户可在设置按平台覆盖（默认值取 adapter `contextLimit`）
- [ ] **token 估算引擎**：text → token，按「文字脚本 × 平台」系数；v1 脚本 = 中文（CJK）+ 英文（Latin）
- [ ] **适配器架构**：完整契约（见 Design），DeepSeek 全实现；接口为新增平台预留
- [ ] **增量轮次捕获**：webRequest 拦发送请求取 prompt + 对话 id；content script 抓 AI 回复文本 → 配对 → 估算 → 更新仪表盘
- [ ] **本地工作状态**：仪表盘的读源，纯本地，不依赖云端
- [ ] **URL 作用域**：非匹配页面 `action.disable` 灰化、sidepanel 不响应
- [ ] **用户设置面板**：阈值双滑块 / context 覆盖 / UI 语言切换 / Upstash 配置（URL·Token·测试·清空·保存）

### P1 — 增强

- [ ] **侧边栏开关**：点击扩展图标打开/关闭原生侧边栏
- [ ] **轮次计数显示**
- [ ] **估算系数用户覆盖**：默认系数来自 adapter，用户可在设置按平台调

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
│  │               │  │  Worker      │  │ (单一,     │ │
│  │  - 进度条     │◄─►│              │◄─►│  全平台)   │ │
│  │  - 占比 %     │  │  - 估算引擎  │  │            │ │
│  │  - 预警颜色   │  │  - 轮次配对  │  │  - DOM 抓取│ │
│  │  - 轮次数     │  │  - 预警判断  │  │  - 回复检测│ │
│  │  - 设置面板   │  │  - action 灰化│ │            │ │
│  └──────────────┘  └──────────────┘  └────────────┘ │
└─────────────────────────────────────────────────────┘
              ↑ 001 数据流到此为止，纯本地
              │ （Upstash 管道 002 / 跨设备对账 003，本 spec 不涉及）
```

三个 entrypoint：`entrypoints/sidepanel/`（UI）、`entrypoints/background.ts`（引擎：估算 + webRequest 拦截匹配 + 轮次配对 + 状态投影 + action 灰化）、`entrypoints/platform.content.ts`（**单一** content script，按 adapter `matchPattern` 注入，覆盖所有平台）。

### Entrypoints

| Entrypoint | 文件                              | 职责                                                                                      |
| ---------- | --------------------------------- | ----------------------------------------------------------------------------------------- |
| sidepanel  | `entrypoints/sidepanel/`          | UI：仪表盘主视图 + 设置视图                                                               |
| background | `entrypoints/background.ts`       | 引擎：估算、webRequest 拦截匹配、轮次配对、状态投影、预警、action 灰化                    |
| content    | `entrypoints/platform.content.ts` | **单一** content script，按 adapter `matchPattern` 注入全平台；DOM 抓 AI 回复、发页面信号 |

### Token 估算引擎 ★核心

**模型**：

```
tokens(text, platform) = Σ over 脚本 s  [ count(text, s) × coeff(s, platform) ]
```

- 按**字符的脚本（script）**分桶，不是按消息"语言"——因为一条消息常混排中英。逐字符判脚本 → 归桶计数 → 乘该脚本在该平台的系数。
- v1 两种脚本：
  - **CJK（中文等）**：按字计。`tokens = cjkChars × cjkCoeff`
  - **Latin（英文等）**：按词计。`tokens = latinWords × latinCoeff`（词 = 空白分隔）
  - 其他脚本（西/德/法/日/俄/葡/阿…）v1 暂归 Latin 桶估算，004 扩展独立系数。
- 系数是**脚本 × 平台**二维：每个 adapter 提供默认系数表，用户可在设置覆盖（P1）。同一脚本在不同平台 tokenizer 下系数不同（如 DeepSeek 与 Qwen/GPT 的汉字系数不同）。
- **v1 默认值（待 004 标定，下为起点值）**：DeepSeek `cjk ≈ 0.6 token/字`、`latin ≈ 0.5 token/词`。其余平台未标定前沿用同值，接入时按各自 tokenizer 调。
- **不依赖平台服务端 token**：即便个别平台 API 偶尔返回 token 用量，也只作 004 校准参考，不计入核心路径。产品形态按"文本 → 估算"设计。

**每轮 input/output 分别估**：prompt 文本 → `promptTokens`，answer 文本 → `answerTokens`，本轮 `total = promptTokens + answerTokens`。

### Adapter Pattern（平台无关，新增平台 = 注册 + 一个文件）

新增一个 AI 平台 = 注册 + 写一个 `adapters/<platform>.ts`。完整契约（**归属**列说明哪个 spec 定义/使用该字段）：

| 字段                                                                             | 归属 | 说明                                    |
| -------------------------------------------------------------------------------- | ---- | --------------------------------------- |
| `id` / `matchPattern`                                                            | 001  | 平台 id；content 注入 + host 匹配       |
| `contextLimit`                                                                   | 001  | 默认 context window，用户可覆盖         |
| `tokenCoefficients { cjk, latin }`                                               | 001  | 默认估算系数，用户可覆盖                |
| `sendUrl` / `parseSend(body) → { prompt, dialogueId }`                           | 001  | 增量捕获：拦发送请求取 prompt + 对话 id |
| `answerSelector`（或等价抓取策略）                                               | 001  | DOM 抓 AI 回复                          |
| `deleteUrl` / `parseDelete(body) → dialogueId` / `deleteHost?` / `deleteMethod?` | 003  | 删除联动拦截                            |
| `fetchHistory?(dialogueId) → HistoryMessage[]`                                   | 003  | 全量对账：拉平台完整历史                |
| `fetchConversationList?() → string[]`                                            | 003  | 僵尸清理：拉对话 id 列表                |
| `detectDeletedPage?(doc) → boolean`                                              | 003  | 移动端删除懒清理                        |

001 实现 DeepSeek 的**全部 001 字段**；003 字段在本 spec 里只占契约位，实现在 003。background 是平台无关引擎——只认 adapter 接口。

**DeepSeek 参考实现（001 范围）**：

| 项                  | 值                                                      |
| ------------------- | ------------------------------------------------------- |
| `matchPattern`      | `chat.deepseek.com`                                     |
| `contextLimit`      | 1,000,000                                               |
| `sendUrl`           | DeepSeek 发送 API（真机抓包确认）                       |
| `parseSend`         | 取 `content`（prompt）+ `chat_session_id`（dialogueId） |
| `answerSelector`    | 回复 DOM 选择器（真机实测确认）                         |
| `tokenCoefficients` | `cjk 0.6 / latin 0.5`（v1 起点值，待 004 标定）         |

### 7 平台 context 默认值（首期 DeepSeek 验通，其余 fast-follow）

| 平台     | 页面 host         | Context（默认） | 发送请求解析                              |
| -------- | ----------------- | --------------- | ----------------------------------------- |
| DeepSeek | chat.deepseek.com | 1,000,000       | ✅ prompt + `chat_session_id`             |
| ChatGPT  | chatgpt.com       | 128,000         | ✅ `content.parts[0]` + `conversation_id` |
| Gemini   | gemini.google.com | 1,000,000       | ❌ 纯 DOM（`f.req` 不可解析）             |
| Kimi     | www.kimi.com      | 200,000         | ✅ `blocks[0].text.content` + `chat_id`   |
| Qwen     | chat.qwen.ai      | 131,072         | ✅ prompt + `chat_id`（URL query）        |
| 通义千问 | www.qianwen.com   | 131,072         | ✅ `messages[0].content` + `session_id`   |
| 豆包     | www.doubao.com    | 256,000         | ✅ prompt（`content` 是字符串化 JSON）    |

> 7 家 DOM 选择器 + API host/path 均经真机实测确认（2026-06）。001 的**验收里程碑以 DeepSeek 验通为准**；其余 6 家 adapter 字段就绪，深度 runtime 验收见 004。

### Data Flow（001 scope，纯本地）

```
1. 用户在平台页发消息
2. webRequest 命中 adapter.sendUrl → parseSend 取 prompt + dialogueId → 存 pending（单槽，跨 SW 重启保活）
3. content script 检测 AI 回复完成（answerSelector）→ 抓回复文本 → 发 background
4. background 配对 pending.prompt + answer → 估算引擎算 prompt/answer token
   → 追加本轮到 DialogueRecord → 更新 totalTokens/roundCount
5. 占比 = totalTokens / contextLimit → 预警等级 → 广播 side panel
6. side panel 渲染进度条/占比/颜色/轮次
```

**无 Upstash。** 本轮的云持久化、跨设备对账是 003。001 的仪表盘离了云也照常工作。

### Data Model（001 scope，本地）

```
headroom:settings            → { thresholds, language, contextLimits(覆盖), upstash?(凭证) }
headroom:conv:{p}:{id}       → DialogueRecord（当前活动对话）
headroom:pending             → { platformId, dialogueId, prompt }（单槽；轮次完成后清除）
```

**`DialogueRecord` / `RoundRecord` 只存 token 计数，绝不存对话文本**（隐私设计）：

```
RoundRecord    = { n, promptTokens, answerTokens, total, ts }
DialogueRecord = {
  platformId, dialogueId, contextLimit,
  rounds: RoundRecord[],       // 滚动裁剪，上限 MAX_RETAINED_ROUNDS
  totalTokens: number,         // 真实累计（裁剪数组 ≠ 丢失累计）
  roundCount: number,          // 真实轮次
  updatedAt: number,
}
```

**不变式**：`rounds[]` 按上限滚动裁剪，但 `totalTokens` / `roundCount` 始终是真实累计值——裁剪数组不等于丢失累计。这是最易出 bug 的地方，由不变式测试守护。

**仪表盘从 `DialogueRecord` 投影**：累计 = `totalTokens`，轮次 = `roundCount`，最近轮 = `rounds[last].total`，占比 = `totalTokens / contextLimit`。

> 001 只维护**当前活动对话**的本地 record（切对话时加载/新建）。多对话本地缓存 + LRU 淘汰是 003。`DialogueRecord` 结构由 001 定义，003 在其上加云端生命（持久化 / 对账 / 缓存），无需重写结构。

### UI（Side Panel）

主视图 + 设置视图切换（⚙️ 进入设置）：

```
┌─── 主视图 ──────────────┐    ┌─── 设置视图 ───────────────┐
│  Headroom            ⚙️  │    │  ← 返回                     │
│  DeepSeek               │    │  预警阈值 🟡50% 🔴70%        │
│  Context: 1M            │    │  Context 覆盖 [按平台]       │
│  ██░░░░░░  5.0%         │    │  语言 [自动 ▾]               │
│  🟢 空间充足             │    │  Upstash URL/Token/测试/清空 │
│  Round: 12  Last: 1,520 │    │  [保存设置]                  │
└─────────────────────────┘    └─────────────────────────────┘
```

- 第一行显示**平台名**（v1 不检测具体模型；context limit 取 adapter 默认或用户覆盖）。
- **Upstash 字段是输入控件**；「测试连接」「保存」的云端动作由 002（传输）/ 003（同步）接线。未配 Upstash 时这些控件 inert，仪表盘照常工作。

### Browser APIs

| API                                                       | 用途                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| `browser.sidePanel` / `browser.sidebarAction`             | 原生侧边栏（WXT 自动适配）                                   |
| `browser.runtime.sendMessage` / `onMessage`               | Sidepanel ↔ Background ↔ Content 消息                        |
| `browser.storage.local`                                   | 设置 + 活动对话 record + pending                             |
| `browser.action.enable` / `disable(tabId)`                | 非匹配页灰化 action                                          |
| `browser.tabs.onActivated` / `onUpdated`                  | 同步 action enable/disable                                   |
| `browser.webRequest.onBeforeRequest`（`["requestBody"]`） | 读发送请求体取 prompt + dialogueId（删除监听同 API，归 003） |

## Implementation Plan

1. **估算引擎（TDD）**：脚本分桶（CJK/Latin）+ 系数表 + 混排累计；DeepSeek 默认系数。
2. **adapter 契约 + DeepSeek 全实现**（001 字段）。
3. **增量捕获闭环**：webRequest send + DOM answer + 配对 + 估算 + 投影。
4. **侧边栏 UI**（主视图 + 设置）+ action 灰化。
5. **本地 DialogueRecord 存取 + 不变式测试**。

## Acceptance Criteria

> 按**闸门次序**验收。**001 是纯本地层——闸门里不含任何 Upstash 断言**（那是 002/003）。

### 闸门 1 — DeepSeek 端到端（必过，卡后续一切）

- [ ] 平台页点扩展图标 → 原生侧边栏打开，显示 Headroom UI
- [ ] 一轮问答后，面板实时更新 token 数与占比
- [ ] 占比过阈值时进度条变色（黄/红）
- [ ] 阈值可在设置面板自定义
- [ ] 显示当前平台 context window limit
- [ ] 非匹配页图标灰化、点击不开侧栏

### 闸门 2 — 另 6 家冒烟（fast-follow，不卡主路径）

- [ ] ChatGPT / Gemini / Kimi / Qwen / 通义 / 豆包 各至少：能加载、能拦到一轮发送、面板有数

### 闸门 3 — 跨浏览器冒烟（早抓 Chrome 专属假设；深度 QA 归 004）

- [ ] Edge、Firefox 能装、能开面板、DeepSeek 一轮问答跑通

## Open Questions

- [ ] v1 估算系数的精确标定值（→ 004）
- [ ] 脚本判定与中英混排的估算精度（→ 004）
- [ ] DOM 选择器 / API host 的时效性（平台改版风险）
- [ ] `MAX_RETAINED_ROUNDS` 在 003 全量对账下是否需要调整（平台历史可能更长）
