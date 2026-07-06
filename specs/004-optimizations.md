# 004: Token 估算体系升级 — 书写系统扩展 + 平台系数 + 用户覆盖

## Status

开发中。代码基础设施先行（类型扩展 + estimateTokens 升级 + Settings UI 分层 + Advanced 面板），系数标定独立推进（纯配置数据，不阻塞代码）。

## Summary

把 Token 估算从 v1 的 2 种书写系统升级到 v2 的 6 种，每平台独立系数，用户可在 Advanced Settings 按平台覆盖。

**不在本 spec 范围**：跨浏览器深度 QA（归 [`acceptance-checklist.md`](./acceptance-checklist.md)）。

## Motivation

v1 的三个问题：

1. **书写系统覆盖面窄**：日文假名、韩文 Hangul 被错误归入 Latin 桶计词，偏差显著
2. **不区分平台分词器**：DeepSeek 和 ChatGPT 对同一汉字的 token 数不同，但 7 家平台用同一套系数
3. **用户不可控**：代码通路已参数化（`TokenCoefficients` → `estimateTokens(text, coeff)`），但设置面板没暴露

## Design

### 1. 书写系统扩展

从 2 种扩展到 6 种，每种独立系数：

| 书写系统     | Unicode 范围               | 计数方式 | 优先级 |
| ------------ | -------------------------- | -------- | ------ |
| CJK 汉字     | `\p{Unified_Ideograph}`    | 按字     | —      |
| 日文假名     | `\p{Hiragana}\p{Katakana}` | 按字     | 高     |
| 韩文 Hangul  | `\p{Hangul}`               | 按字     | 高     |
| 西里尔       | `\p{Cyrillic}`             | 按词     | 中     |
| 阿拉伯       | `\p{Arabic}`               | 按词     | 中     |
| Latin 及其他 | 剩余                       | 按词     | —      |

> **按字 vs 按词**：CJK/假名/韩文按字符计（一字 ≈ 1-3 token，方差小），西里尔/阿拉伯/Latin 按空白分隔词计（词长变化大，按词更稳）。

**v2 估算公式**：

```
tokens(text) = Σ over scripts s [ count_chars_or_words(text, s) × coeff[s] ]
```

其中 `coeff[s]` 从 adapter 的 `tokenCoefficients` 读取。

### 2. TokenCoefficients 类型

```typescript
// utils/estimate.ts
interface TokenCoefficients {
  cjk: number; // CJK 汉字
  kana: number; // 日文假名
  hangul: number; // 韩文 Hangul
  cyrillic: number; // 西里尔
  arabic: number; // 阿拉伯
  latin: number; // Latin 及其他（兜底桶）
}
```

所有字段必填。`estimateTokens` 内部按 Unicode property escapes（`\p{...}`，`u` flag）逐字符分类 → 分桶计数 → 乘系数求和。

### 3. 系数解析链（两级）

```
Settings.tokenCoefficients[platformId].cjk   ← 用户覆盖（最高优先）
  ?? adapter.tokenCoefficients.cjk            ← 平台默认（每个 adapter 必提供）
```

没有第三级全局兜底——每个 adapter 的 `tokenCoefficients` 是必填字段，adapter 自己就是该平台的默认值。"重置"操作即清空用户覆盖，回到 adapter 自带值。

`DEFAULT_COEFFICIENTS` 常量仅用于 `estimateTokens` 单测的参考值，不参与运行时解析链。

### 4. 各平台分词器与标定策略

**核心原则**：Headroom 不打包 tokenizer。只需要**系数**——"该分词器下每种书写系统平均几个字符/词换 1 个 token"。系数通过经验方法标定，不需要分词器开源。

| 平台            | 分词器                              | 标定方法                                  |
| --------------- | ----------------------------------- | ----------------------------------------- |
| ChatGPT         | tiktoken `o200k_base`（开源）       | tiktoken 库离线精确计算                   |
| DeepSeek        | DeepSeek tokenizer（BPE，模型开源） | 服务端 `accumulated_token_usage` 回归     |
| Qwen / 通义千问 | Qwen tokenizer（BPE，模型开源）     | 服务端 `usage.total_tokens` 回归          |
| Kimi            | Moonshot 未公开                     | 经验估算（同类 BPE 系数作基线）           |
| Gemini          | Google 未公开                       | 经验估算（同类 SentencePiece 系数作基线） |
| 豆包            | 字节跳动未公开                      | 经验估算（同类 BPE 系数作基线）           |

> 标定工作是纯配置数据工作，不涉及代码改动。占位值先行，调研 + 社区采样后填入。

### 5. 占位系数矩阵

标定前所有平台使用同一套占位值：

| 平台          | CJK  | Kana | Hangul | Cyrillic | Arabic | Latin | 来源         |
| ------------- | ---- | ---- | ------ | -------- | ------ | ----- | ------------ |
| **全部 7 家** | 0.60 | 0.50 | 0.50   | 0.50     | 0.50   | 0.50  | 占位，待标定 |

系数精度 **2 位小数**。0.01 差异在 1M context window 下 ≈ 200 token 估算偏差，百分比显示不可见。

即使系数未标定，分桶细化本身就能减少误差（假名和韩文不再被错误归入 Latin 桶）。

### 6. Settings 分层：General vs Advanced

当前设置面板是平铺的。加入系数矩阵后拆为两层：

**General Settings**（已有，不变）：

| 设置项             | 说明                               |
| ------------------ | ---------------------------------- |
| 预警阈值           | 双滑块：黄/红阈值                  |
| UI 语言            | Auto / en / zh_CN / …              |
| Context Limit 覆盖 | 按平台覆盖 context window 上限     |
| Upstash 配置       | REST URL / Token / 测试连接 / 清空 |

**Advanced Settings**（新增）：

| 设置项         | 说明                   |
| -------------- | ---------------------- |
| Token 估算系数 | 按平台覆盖书写系统系数 |

**UI 交互**：

- 设置面板底部「Advanced」折叠区，默认收起
- 展开后按平台分组，每个平台一个折叠行（`<details>` 或 accordion）
- 展开平台行 → 显示 6 个系数输入框（`<input type="number" step="0.01">`）
- 每个平台行右侧一个「重置」按钮 → 恢复到该 adapter 默认值
- 「全部重置」按钮 → 清空所有用户覆盖
- 保存设置后弹提示："系数修改需刷新平台页面后生效"

### 7. 数据模型

**Settings（本地）新增字段**：

```typescript
// utils/settings.ts
interface Settings {
  // ... 现有字段 ...
  tokenCoefficients: Record<string, Partial<TokenCoefficients>>;
  // 按 platformId 索引，只存用户覆盖的部分。未覆盖字段从 adapter 默认值读取。
}
```

**CloudSettings（云端）新增字段**：

```typescript
// utils/cloud-settings.ts
interface CloudSettings {
  // ... 现有字段 ...
  tokenCoefficients: Record<string, Partial<TokenCoefficients>>;
}
```

`toCloudSettings` 携带、`mergeCloudSettings` 做 LWW 合并。凭证永不包含在 `tokenCoefficients` 中（与现有字段一致的剥离逻辑）。

**PlatformAdapter 类型变更**：

`tokenCoefficients` 从可选（`?`）改为必填。每个 adapter 必须提供一套默认系数。

### 8. 运行时生效时机

用户保存系数覆盖 → 设置面板弹提示"需刷新平台页面" → 用户手动 F5 → 页面重载 → content script 注入 → `PAGE_READY` → `fetchHistory` → `applyHistory` → `estimateTokens` 读取新系数。

不追求"保存即生效"——对话历史已用旧系数估算过，改系数后需全量重估。

## Implementation

分两阶段。标定工作（阶段 B）是纯配置数据，不阻塞阶段 A。

### 阶段 A — 代码基础设施

| 步骤 | 文件                                                         | 改动                                                                                                                                               |
| ---- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | `utils/estimate.ts`                                          | `TokenCoefficients` 扩展为 6 字段；`estimateTokens` 新增假名/韩文/西里尔/阿拉伯字符分类与分桶计数；Unicode property escapes `\p{...}` 替换手动范围 |
| A2   | `utils/estimate.test.ts`                                     | 新增 6 种书写系统分桶测试 + 混排测试                                                                                                               |
| A3   | `utils/platform-adapter.ts`                                  | `tokenCoefficients?` → `tokenCoefficients`（必填）                                                                                                 |
| A4   | `adapters/*.ts`（7 文件）                                    | 无需改动——已引用占位值，类型自动跟随                                                                                                               |
| A5   | `utils/settings.ts`                                          | `Settings` 加 `tokenCoefficients` 字段；`getSettings` 读                                                                                           |
| A6   | `utils/settings.test.ts`                                     | 加系数覆盖优先级测试                                                                                                                               |
| A7   | `utils/cloud-settings.ts`                                    | `CloudSettings` 加 `tokenCoefficients`；`toCloudSettings` 传递；`mergeCloudSettings` LWW 合并                                                      |
| A8   | `utils/cloud-settings.test.ts`                               | 加系数字段同步 + 凭证剥离测试                                                                                                                      |
| A9   | `entrypoints/background.ts`                                  | `applyHistory` 解析链改为：`settings.tokenCoefficients[platformId] ?? adapter.tokenCoefficients`                                                   |
| A10  | `entrypoints/sidepanel/main.ts` + `index.html` + `style.css` | 设置面板重构：General 区 + Advanced 折叠区；按平台分组的系数输入 + 重置按钮 + 全部重置                                                             |
| A11  | `_locales/*/messages.json`                                   | 新增 Advanced Settings 相关文案 key                                                                                                                |

### 阶段 B — 系数标定（配置数据，独立推进）

| 步骤 | 内容                                                  |
| ---- | ----------------------------------------------------- |
| B1   | ChatGPT：tiktoken 离线计算 6 种书写系统系数           |
| B2   | DeepSeek：采集样本 → 服务端 token 回归                |
| B3   | Qwen / 通义千问：采集样本 → 服务端 token 回归         |
| B4   | Kimi / Gemini / 豆包：同类分词器系数作基线 + 人工抽检 |
| B5   | 更新 7 个 adapter 的 `tokenCoefficients` 为标定值     |

> 阶段 B 产出仅为 7 个 adapter 各一行的配置数据变更，不影响代码逻辑。

## Acceptance Criteria

> 详细操作步骤见 [`specs/acceptance-checklist.md`](./acceptance-checklist.md)。

- 日文/韩文/西里尔/阿拉伯混排文本估算误差在目标范围内（标定时确定）
- 各平台默认系数标定完毕，矩阵表不再有占位标记
- 用户在 Advanced Settings 改系数 → 保存 → 刷新页面 → 下一轮估算用新系数
- 平台行「重置」恢复到该 adapter 默认值；「全部重置」清空所有覆盖
- 保存系数后弹提示"需刷新平台页面"
- 系数覆盖跨设备同步
- 未配置 Upstash 时系数覆盖仅本地生效

## Open Questions

- 各书写系统 × 平台系数的标定基准与可接受误差带
- 是否引入轻量 tokenizer 作可选精度升级（仍非默认路径）
- 对于"未知"分词器平台的经验估算，可接受的误差带是多少
- 是否需要定期（平台升级模型时）重新采样校准
