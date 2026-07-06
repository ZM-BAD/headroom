# 004: 优化 — Token 系数校准 + 用户覆盖 + 跨浏览器 QA

## Status

远期 stub（主干 [001](./001-headroom-core.md) / [002](./002-upstash-data-layer.md) / [003](./003-cross-device-sync.md) 跑通后再展开）。三件事都是**非主干优化**；轮到时可拆成多个 spec。

> 估算系数用户覆盖从 [001](./001-headroom-core.md) P1 迁入——它和系数校准共享同一条数据通路（`TokenCoefficients` → `estimateTokens()`），放在一起实现更自然。

## Summary

三个独立优化主题，合一 spec：

1. **Token 估算体系升级（正确性 + 可控性）**：扩展书写系统 → 识别各平台分词器 → 标定默认系数矩阵 → 用户可在 Advanced Settings 按平台覆盖。
2. **跨浏览器深度 QA（可移植性）**：开发以 Chrome 为主，Edge 基本跟随，Firefox 补齐边角交互差异。

## 主题 1：Token 估算体系升级

### 1.1 现状

**v1 估算公式**（`utils/estimate.ts`）：

```
tokens(text, platform) = cjkChars × coeff.cjk + latinWords × coeff.latin
```

- 两种书写系统：CJK（汉字）按字计，Latin（英文等）按空白分隔词计
- 其他所有书写系统（日文假名、韩文、西里尔、阿拉伯…）统统归 Latin 桶
- 全部 7 家平台使用同一套系数 `{ cjk: 0.6, latin: 0.5 }`（未经标定的起点值）

**问题**：

1. **书写系统覆盖面窄**——日语一段文本里汉字 + 假名混排，假名被当 Latin 词计，偏差显著。韩文、俄文等同理。
2. **不区分平台分词器**——DeepSeek 和 ChatGPT 对同一个汉字的 token 数不同，但当前用同一套系数。
3. **用户不可控**——代码通路已参数化（`TokenCoefficients` → `estimateTokens(text, coeff)`），但设置面板没有暴露。

### 1.2 各平台分词器

系数标定的前提是知道每个平台用什么分词器——不同的分词器对同一段文本的 token 化结果不同。

**核心原则**：Headroom 不需要拿到分词器本身（不打包 tok）。我们只需要知道**系数**——即该分词器下每种书写系统"平均几个字符/词换 1 个 token"。系数可以通过经验方法标定，不需要分词器开源。

以下是各平台的分词器已知情况（2026-07）：

| 平台     | 分词器                     | 状态                          | 标定方法                                                   |
| -------- | -------------------------- | ----------------------------- | ---------------------------------------------------------- |
| ChatGPT  | tiktoken `o200k_base`      | ✅ 已知（开源）               | 直接用 tiktoken 库离线精确计算系数                         |
| DeepSeek | DeepSeek tokenizer（BPE）  | ⚠️ 模型开源，网页版变体未确认 | 服务端返回 token 数回归 + 采样对照                         |
| Qwen     | Qwen tokenizer（BPE）      | ⚠️ 模型开源，网页版变体未确认 | 服务端返回 token 数回归 + 采样对照                         |
| 通义千问 | 同 Qwen tokenizer          | ⚠️ 同上                       | 同上                                                       |
| Kimi     | **未知** — Moonshot 未公开 | ❌ 未披露                     | 纯经验估算（采样文本 → 人工/半自动 token 计数 → 回归系数） |
| Gemini   | **未知** — Google 未公开   | ❌ 未披露                     | 纯经验估算（同上）                                         |
| 豆包     | **未知** — 字节跳动未公开  | ❌ 未披露                     | 纯经验估算（同上）                                         |

> **"未知"不意味着没法做**——对未披露分词器的平台，标定方法是：取一批覆盖各书写系统的样本文本 → 通过平台 API 发送（或在前端拦截请求体）→ 对比输入文本字符数和平台实际消费的 token 数（如果平台返回此数据）→ 回归出系数。如果平台连 token 数都不返回（Gemini、豆包），则用人工标注 + 同类分词器的系数作交叉验证。

**标定数据源**：

| 平台     | 服务端返回 token 数                    | 标定方式                                            |
| -------- | -------------------------------------- | --------------------------------------------------- |
| ChatGPT  | ❌                                     | tiktoken 库离线精确计算（开源，无需网络）           |
| DeepSeek | ✅ `accumulated_token_usage`           | 采集样本 → 服务端 token 回归                        |
| Qwen     | ✅ `content_list[].usage.total_tokens` | 采集样本 → 服务端 token 回归                        |
| 通义千问 | ✅ `extra_info...total_usage`          | 采集样本 → 服务端 token 回归                        |
| Kimi     | ❌                                     | 经验估算（同类 BPE 分词器系数作参考基线）           |
| Gemini   | ❌                                     | 经验估算（同类 SentencePiece 分词器系数作参考基线） |
| 豆包     | ❌                                     | 经验估算（同类 BPE 分词器系数作参考基线）           |

> **经验估算的可靠性**：对于"未知"平台，系数仍然比 v1 的通用兜底值更准——因为我们至少知道它是中文优化的 BPE 分词器（Kimi、豆包）还是多语言 SentencePiece（Gemini），可以用同类已知分词器的系数作为先验，再做人工抽检校准。误差会比当前所有平台用同一套 `{0.6, 0.5}` 小一个数量级。

### 1.3 书写系统扩展

v2 目标——从 2 种扩展到以下书写系统，每种有独立系数：

| 书写系统     | Unicode 范围               | 计数方式 | v1 归属     | 优先级 |
| ------------ | -------------------------- | -------- | ----------- | ------ |
| CJK 汉字     | `\p{Unified_Ideograph}`    | 按字     | CJK         | —      |
| 日文假名     | `\p{Hiragana}\p{Katakana}` | 按字     | Latin 桶 ❌ | **高** |
| 韩文 Hangul  | `\p{Hangul}`               | 按字     | Latin 桶 ❌ | **高** |
| 西里尔       | `\p{Cyrillic}`             | 按词     | Latin 桶    | 中     |
| 阿拉伯       | `\p{Arabic}`               | 按词     | Latin 桶    | 中     |
| Latin 及其他 | 剩余                       | 按词     | Latin       | —      |

> **决策：按字 vs 按词**——CJK、假名、韩文按字符计（这些书写系统中一个字 ≈ 1-3 token，方差小），西里尔/阿拉伯/Latin 按词计（词长变化大，按空白分隔更稳）。这与当前 CJK/Latin 的分治逻辑一致，只是把桶拆细了。

**v2 估算公式**：

```
tokens(text, platform) = Σ over scripts s [ count(text, s) × coeff(s, platform) ]
```

其中 `coeff(s, platform)` 从 adapter 的默认系数表读取。`TokenCoefficients` 类型从 2 字段扩展为按书写系统的 map：

```typescript
// v2
interface TokenCoefficients {
  cjk: number; // CJK 汉字
  kana: number; // 日文假名
  hangul: number; // 韩文
  cyrillic: number; // 西里尔
  arabic: number; // 阿拉伯
  latin: number; // Latin 及其他（兜底桶）
}
```

`estimateTokens` 内部新增对应的字符分类逻辑和分桶计数。

### 1.4 默认系数矩阵（adapter）

每个 adapter 提供一套默认系数。标定来源分三等：

1. **已知分词器（ChatGPT）**：用 tiktoken 库离线精确计算——准备各书写系统的标准样本集 → 跑 `o200k_base` 编码 → 回归系数。这是精度最高的来源。
2. **开源但网页版变体未确认（DeepSeek / Qwen / 通义千问）**：以服务端返回的 token 数为主标定源，开源 tokenizer 的系数作为交叉验证。
3. **未知分词器（Kimi / Gemini / 豆包）**：经验估算——以同类已知分词器的系数作先验基线，再用采样文本做人工/半自动抽检校准。在系数表中标注"经验值"。

**待标定矩阵**（标定后填入实际值；当前全部用 v1 起点值占位，"经验"标注来源为类型 3）：

| 平台 ↓ / 书写系统 → | CJK  | Kana | Hangul | Cyrillic | Arabic | Latin | 来源          |
| ------------------- | ---- | ---- | ------ | -------- | ------ | ----- | ------------- |
| DeepSeek            | 0.60 | ?    | ?      | ?        | ?      | 0.50  | 服务端回归    |
| ChatGPT             | ?    | ?    | ?      | ?        | ?      | ?     | tiktoken 精确 |
| Qwen                | ?    | ?    | ?      | ?        | ?      | ?     | 服务端回归    |
| 通义千问            | ?    | ?    | ?      | ?        | ?      | ?     | 服务端回归    |
| Kimi                | ?    | ?    | ?      | ?        | ?      | ?     | **经验值**    |
| Gemini              | ?    | ?    | ?      | ?        | ?      | ?     | **经验值**    |
| 豆包                | ?    | ?    | ?      | ?        | ?      | ?     | **经验值**    |

> 系数精度统一为 **2 位小数**（如 `0.60`）。这个精度对百分比仪表盘场景足够——0.01 的系数差异在 1M context window 下对应 ~200 token 的估算偏差，在百分比显示上不可见。

所有平台 v1 的 `cjk: 0.6, latin: 0.5` 先用着——即使未标定，分桶细化本身就能减少误差（假名和韩文不再被错误归入 Latin 桶）。标定工作在实施阶段逐平台完成。

### 1.5 Settings 分层：General vs Advanced

当前设置面板是平铺的——阈值、语言、context limit 覆盖、Upstash 配置全部混在一起。随着系数矩阵加入（6 种书写系统 × 7 个平台 = 42 个可配置值），需要把设置拆成两层。

**General Settings**（常规设置，用户日常会调的）：

| 设置项             | 说明                                       |
| ------------------ | ------------------------------------------ |
| 预警阈值           | 双滑块：黄阈值、红阈值（已有）             |
| UI 语言            | Auto / en / zh_CN（已有）                  |
| Context Limit 覆盖 | 按平台覆盖 context window 上限（已有）     |
| Upstash 配置       | REST URL / Token / 测试连接 / 清空（已有） |

**Advanced Settings**（高阶设置，需要时才展开）：

| 设置项         | 说明                           |
| -------------- | ------------------------------ |
| Token 估算系数 | 按平台覆盖书写系统系数（新增） |

**UI 交互**：

- 设置面板底部加一个「Advanced」折叠区，默认收起。
- 展开后按平台分组，每个平台一张小表：书写系统列 × 系数输入框。
- 每个输入框右侧有一个「重置」按钮，恢复到该平台的 adapter 默认值。
- 顶部有一个「全部重置」按钮，清空所有用户覆盖。

**存储**：

```typescript
// Settings 新增字段
interface Settings {
  // ... 现有字段 ...
  tokenCoefficients: Record<string, Partial<TokenCoefficients>>;
  // 按 platformId 索引，只存用户覆盖的部分（未覆盖的字段从 adapter 默认值取）
}
```

写入云端时 `tokenCoefficients` 随 `CloudSettings` 一起上云（LWW 合并），跨设备同步。

**读取优先级**：

```
用户 Settings.tokenCoefficients[platformId].cjk
  ?? adapter.tokenCoefficients.cjk
  ?? DEFAULT_COEFFICIENTS.cjk   // { cjk: 0.6, kana: 0.5, hangul: 0.5, cyrillic: 0.4, arabic: 0.4, latin: 0.5 }
```

### 1.6 实施步骤

1. **扩展 `TokenCoefficients` 类型**：加 `kana` / `hangul` / `cyrillic` / `arabic` 字段。
2. **升级 `estimateTokens`**：新增假名、韩文、西里尔、阿拉伯的字符分类 + 分桶计数。
3. **更新所有 adapter 的 `tokenCoefficients`**：从 `{ cjk, latin }` 升级到 v2 六字段，先用 `DEFAULT_COEFFICIENTS`。
4. **标定默认系数**：DeepSeek/Qwen/通义千问用服务端 token 回归；ChatGPT 用 tiktoken 对照；其余手工标注。
5. **Settings UI 分层**：重构设置面板为 General + Advanced 折叠布局。
6. **Advanced 面板**：按平台分组的系数输入 + 重置按钮。
7. **`Settings` 类型 + 存储 + 云端同步**：加 `tokenCoefficients` 字段 → `getSettings` 读 → `applyHistory` 取覆盖 → `CloudSettings` 带上云。
8. **单测**：新增书写系统分桶测试 + 系数覆盖优先级测试。

### 1.7 验收

> 详细操作步骤见 [`specs/acceptance-checklist.md`](./acceptance-checklist.md)（004 部分待 spec 展开后补充）。

- 日文/韩文/俄文/阿拉伯文混排文本的估算误差在目标范围内（具体范围待标定时定）。
- 各平台默认系数标定完毕，矩阵表不再有 `?`。
- 用户在 Advanced Settings 改系数后，下一轮 token 估算按新系数计算。
- 「重置」按钮恢复到 adapter 默认值。
- 系数覆盖跨设备同步（设备 A 改完 → 设备 B 打开设置看到相同值）。
- 未配置 Upstash 时系数覆盖仅本地生效（不报错）。

---

## 主题 2：跨浏览器深度 QA

**现状（001 闸门 3）**：Chrome / Edge / Firefox **冒烟**（能装能开面板、DeepSeek 一轮跑通）。

**目标**：Firefox 的边角差异查缺补漏——`sidePanel` vs `sidebarAction` 生命周期、service worker vs event page、`webRequest` 行为差异等；Edge 跟随 Chrome，只验一致。

**验收**：三端功能 / 生命周期 / 拦截行为一致。

## Open Questions

- 各书写系统 × 平台系数的标定基准与可接受误差带。
- 是否在 004 引入轻量 tokenizer 作可选精度升级（仍非默认路径）。
- Firefox 差异清单：哪些交互在三端表现不一，需各自适配。
- 对于"未知"分词器平台的经验估算，可接受的误差带是多少？是否需要定期（平台升级模型时）重新采样校准？
