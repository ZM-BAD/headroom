# 006: Tool 结果的 Context Window 占用模型

## Summary

调研 LLM 平台对 tool 调用/网页搜索结果在 context window 中的占用形式（2026-08-16，官方文档 + 论文 + 实测），建立**双模式分类模型**（含存档不重放变体）：tool 结果要么**持久化进对话历史且每轮重读**（持续占用 context），要么**当轮瞬时注入**（生成完即释放、不进历史）；ChatGPT 是变体——调用文本存档于历史接口但**不重放**。该模型指导 Headroom 的计数策略：`toolTokens` 只对"历史接口可见"的平台计数，`—` 表示"无工具"或"平台不暴露"，两者语义不同但**都不影响 context window 剩余量监控的准确性**。

## Motivation

spec 005 建立了 `toolTokens` 计数，但各平台的占用形式差异是隐式的——DeepSeek Web 实测（006 调研）显示其搜索内容**不进入后续 context**（next completion 请求仅携带 `parent_message_id` + 新 prompt，服务端增量续传），而 Kimi/Qwen/Qianwen/Doubao Web 的搜索文本**持久在历史接口中**。没有统一的占用模型，就无法回答："不计 DeepSeek 的搜索是否会让 gauge 失真？" 本 spec 固化调研结论，使其成为计数策略的依据。

## 双模式分类模型

### 模式 A：持久化进对话历史（PERSISTED）

Tool 调用文本 + 工具返回结果**作为对话历史的一部分被持久化**，出现在后续每一轮的 context 中。agentic API 循环中每次请求都重发完整历史（或服务端状态化但同样计费），因此 tool 结果是 [token 税](#参考报告) 的"加速器"。

| 特征                        | 证据                                                               |
| --------------------------- | ------------------------------------------------------------------ |
| 结果出现在对话历史/消息 API | 持久 → 可被历史抓取 → 可计数                                       |
| 后续轮次重新占 context      | 每轮重读 → 一次 content 占用（context 剩余量语义）                 |
| 成本呈二次方增长            | stateless API 每轮重发 → O(N²) 累计计费（不改变单次 context 占用） |

### 模式 B：当轮瞬时注入（EPHEMERAL）

搜索/工具结果只注入**当轮**请求的 context（模型生成该轮回答时读取），生成完成即释放；后续轮次的请求**不携带**该内容。历史接口要么完全不保存（DeepSeek Web：`search_results` null、`TOOL_SEARCH`/`TOOL_OPEN` 空壳），要么只存档调用文本但不重放（ChatGPT Web：`content_type:"code"` 的 `search("…")` 调用存档于 conversation API，结果 server-side；2026-08-24 实测调用文本不进入后续轮次的 context，见 [证据](#关键机制细节证据)）。

### 平台归类（2026-08-16 实测 + 文档）

| 平台          | 层  | Tool/搜索结果的占用形式                                                       | 历史接口可见 | Headroom 计数                           |
| ------------- | --- | ----------------------------------------------------------------------------- | ------------ | --------------------------------------- |
| Kimi Web      | Web | 模式 A（tool block 含 title+snippet，持久）                                   | ✅           | toolTokens ✅                           |
| Qwen Web      | Web | 模式 A（web_search phase，持久）                                              | ✅           | toolTokens ✅                           |
| Qianwen Web   | Web | 模式 A（bar/iframe sources，持久）                                            | ✅           | toolTokens ✅                           |
| Doubao Web    | Web | 模式 A（search_query_result_block，持久）                                     | ✅           | toolTokens ✅                           |
| ChatGPT Web   | Web | 模式 B（code node 调用文本存档于 conversation API，不重放；结果 server-side） | ⚠️ 调用存档  | 调用 toolTokens（与 prompt 重复的扣除） |
| DeepSeek Web  | Web | 模式 B（SSE 流注入，历史空壳标记）                                            | ❌           | `—`（正确）                             |
| Gemini Web    | Web | 模式 B 结果（grounding 当轮注入，site names 在 DOM）                          | ⚠️ DOM 名称  | site names（已计）                      |
| OpenAI API    | API | 模式 A（tool 消息入历史，stateful 也计费）                                    | —            | —                                       |
| Anthropic API | API | 模式 A（tool_result 入 messages，官方 context editing 需主动清除）            | —            | —                                       |
| Gemini API    | API | 模式 A（functionResponse 入 contents，stateless 每轮重发）                    | —            | —                                       |
| DeepSeek API  | API | 模式 A（OpenAI 兼容 tool 消息）                                               | —            | —                                       |

> API 层（非 Headroom 监控对象）全部是模式 A——OpenAI 兼容格式的 `tool` 消息是消息数组的一部分。Web 层分化：搜索文本进历史接口且每轮重读的持久（模式 A），否则瞬时（模式 B）——ChatGPT 是 B 的变体：调用文本进历史接口但**不重放**。

## 关键机制细节（证据）

- **DeepSeek Web 增量续传**（006 实测，2026-08-16）：追问的 `POST /api/v0/chat/completion` 请求体 = `{chat_session_id, parent_message_id: 2, prompt: "…"}`——不带任何历史文本。服务端从持久化消息树重建 context，而持久化里搜索内容为空 → **搜索不进入后续 context**。fragments 出现 `TOOL_SEARCH`/`TOOL_OPEN`/`SEARCH` 类型但 content 全空（仅证明搜索发生过；类型名本身也在变体，2026-08-17 又见 `SEARCH`）。
- **DeepSeek 行为实验**（006 补充，2026-08-17）：新对话第一轮搜索"宇树科技IPO进展"（12 条结果，第一条来源证券之星，回答刻意不透露标题）；第二轮追问"第一轮搜索返回的第一条结果的完整标题"（UI 关闭智能搜索无效——`aria-pressed=false` 但请求体 `search_enabled` 仍为 true，键盘事件可切换视觉状态但请求参数不受控）→ 模型回答占位式编造（"宇树科技IPO最新进展 - 宇树科技IPO最新进展"），**无法引用第一轮搜索结果**。结合请求体观察：第一轮搜索结果在第二轮生成时不在 context 中；后续轮次唯一的信息留存是**第一轮回答文本**（模型已把搜索结果消化成回答）。
- **ChatGPT Web**：搜索以系统提示注入（顶层隐藏规则）+ 窗口化分页提取（windowed/sliced page retrieval，非整页）注入当轮；`search_context_size`（low/medium/high）控制注入预算；未文档化的 `search_context_ttl` 控制服务端缓存生命周期（黑盒逆向）。conversation API 只持久化 `search("…")` 调用节点。
- **ChatGPT 行为实验**（006 补充，2026-08-24）：completion 请求体两次实测均为「仅当前消息 + conversation_id」（前端不重发历史，服务端从消息树重建）。搜索词不出现在 user message（要求模型自行生成）时，第二轮追问搜索词 → 模型答「没有执行任何搜索词」；直白探针（"你能读到第一轮 search() 函数调用的内容吗"）→ 模型答「不能」。**结论：code node 调用文本虽存档于 conversation API（可被 Headroom 抓取解析），但不进入后续轮次的 context 重建**——prompt 原文不会因搜索调用而双计，spec 005 的去重策略成立。与 DeepSeek 的差别仅剩「历史接口是否可见」。
- **OpenAI Responses API 状态化计费**：`previous_response_id` 下服务端自动带上下文，但**历史 input tokens 全部照常计费**；`truncation="auto"` 超限丢旧消息；Server-side Compaction 把历史动作压缩成状态（5M tokens / 150 tool calls 不丢精度）——侧面证明 tool 结果默认持续占用。
- **Anthropic**：`tool_result` 是 messages 的一部分，官方文档明示"tool_result is the real context killer"（一个 2000-token 结果在后续每轮重复出现）；官方提供 `clear_tool_uses_20250919` context editing 主动从历史清除已用完的 tool 结果。
- **Gemini API**：stateless，functionResponse 必须随完整历史重发；提供 ContextWindowCompressionConfig（如 triggerTokens 10000 → slidingWindow 5000）压缩。

## 参考报告

### 论文（学术）

- **Toolformer**（Schick et al., Meta AI, 2023, [arXiv 2302.04761](https://arxiv.org/abs/2302.04761)）：工具调用作为 token 内联进文本流，结果折叠回 next-token prediction——工具结果的"文本流成员"语义的开端。
- **ReAct**（Yao et al., 2022/23, [arXiv 2210.03629](https://arxiv.org/abs/2210.03629)）：reasoning/action/observation token 交替的 agent 循环范式。
- **Gorilla**（Patil et al., 2023, [arXiv 2305.15334](https://arxiv.org/abs/2305.15334)）：工具定义放不进 context → 检索式选择（RAT）——tool registry 的 context 占用问题被正式提出。
- **LongFuncEval**（2025, [arXiv 2505.10570](https://arxiv.org/abs/2505.10570)）：长上下文函数调用系统研究——tool 响应长度增长导致答案检索退化 **7%–91%**，多轮对话变长退化 13%/40%——工具结果在长 context 中的持久占用是真实问题。
- **PACMS**（2026, [arXiv 2606.20047](https://arxiv.org/abs/2606.20047)）：agent context 被"verbatim tool call outputs（文件读取、搜索结果、API 响应）"填充；recency 截断是 topic-blind——支持"tool 结果默认持续占用、需要选择性管理"的判断。
- **MCPVerse**（2025, [arXiv 2508.16260](https://arxiv.org/abs/2508.16260)）：3232 个 MCP 工具的定义 ≈ **44k tokens**——工具定义本身的 context 成本量级。
- **NTILC**（2026, [arXiv 2606.06566](https://arxiv.org/abs/2606.06566)）：工具注册表线性扫描的 context 成本 O(N) → 学习式 dispatch O(1)。
- **ITR**（Instruction-Tool Retrieval, 2026, [arXiv 2602.17046](https://arxiv.org/abs/2602.17046)）：动态指令/工具检索把 context 占用降 ~95%、成本降 ~70%。

### 工业界报告/文章

- [The Hidden Token Tax of Tool Use in LLM Agents](https://dev.to/ji_ai/the-hidden-token-tax-of-tool-use-in-llm-agents-4f84)（DEV Community）：stateless agent 循环 token 成本 **O(N²)**；tool 结果是"加速器"（2000-token 结果在后续每轮重复计费；第 5 轮 prompt 可 30K tokens 中 28K 是工具结果历史）。
- [Function Calling Has a Hidden Multiplier](https://www.promptunit.ai/blog/tool-use-function-calling-hidden-cost)：agent 循环实际账单是预估的 5 倍——漏算了工具定义 + 结果累积。
- [Why Your Claude Costs Double Every Quarter](https://dev.to/gerus_team/why-your-claude-costs-double-every-quarter-and-how-to-break-the-cycle-13fm)（DEV Community）：工具 schema 每轮全价重发是成本翻倍主因。
- [ChatGPT 联网搜索黑盒解析](https://blog.csdn.net/CodeVibe/article/details/162815009)：逆向出未文档化 `search_context_ttl`（1–300s 动态衰减）——搜索结果的服务端缓存生命周期。

## 对 Headroom 的功能指导

1. **计数策略 = 历史接口可见性**：`toolTokens` 只从历史接口提取（005 已实现）。模式 A 平台的搜索文本持久 → 计入正确；模式 B 平台不可见 → 不计。**两者都与真实 context 状态一致**——这就是 spec 005 验收 005-05（DeepSeek `—`）的正当性依据。
2. **`—` 的语义（UI 层）**：`—` = "该轮 context 中没有可计数的工具文本"。对模式 B 平台它同时可能意味着"搜索发生了但平台不持久化"——语义不同但**不影响剩余量监控**。UI 上不加区分是产品决策（006 调研后维持），列名"搜索/工具"已澄清用途。
3. **lifetime content-cost 语义正确**：tool 结果虽在 agentic API 循环中每轮重发（O(N²) 计费），但 context window 的**占用**是单份——Headroom 监控剩余量，按"一份内容一次计数"（spec 005 §Design）准确。
4. **工具文本估算（2026-08-17 落地，spec 004 §1）**：spec-004 系数对工具文本系统性低估 20–45%（数字/日期/URL 密集文本被词级估算当 1 个词）。**专用工具系数集方案被数据否决**（57 条真实语料拟合三种策略均不收敛——工具文本形态双峰：中文散文 vs 英文技术，任何单一系数集同时过估/低估）。落地的是**引擎级数字子词化**（`estimateTokens` 把 `\p{N}` 数字串按 `\p{N}{1,3}` 分块计数，BPE 的标准行为）：
   - 实测改善（真实语料 57 条）：Doubao 聚合误差 -42% → -6.3%，Kimi worst 38.9% → 23.7%，中文/新闻类工具文本 ±10–15% ✅
   - 残余：英文技术文本（Qwen 语料）仍低估 15–50%——技术词 BPE 子词切分是词级线性模型的固有局限，工具文本占 context <1%，总量影响可忽略
   - 对话文本无回归（数字在对话中也常见，同受益）；系数重校准后变化 ≤0.02
   - 校准资产：`scripts/tool-corpus/`（真实 snippet 语料）+ `scripts/calibrate-tool-text.mjs`（验证脚本）
5. **未来方向（按优先级）**：
   - **低**：DeepSeek Web 当轮瞬时消耗的 SSE 捕获——单轮低估几千 tokens、生成完即释放，对剩余量监控无收益（006 实测确认）。仅在需要"轮次级完美消耗"时值得。
   - **中**：Gemini Web grounding 的 snippet 提取（P1）——grounding 是当轮注入（模式 B），site names 已计；snippet 需自动打开 source dialog，mutates 用户视图，维持 deferred。
   - **低**：URL/代码符号的启发式子词化（spec 006 调研中技术文本残余低估的下一步）——需要先积累英文技术形态的真实语料（当前语料以中文新闻为主）。
6. **防回归**：新平台接入时按本模型归类（持久→可计；瞬时→不可计），在 spec 005 的平台表登记后再实现，避免"看到搜索就以为该计数"的实现偏差。工具文本估算变更必须跑 `calibrate-tool-text.mjs` 验证（系数从适配器导入，不硬编码）。

## 与 spec 005 的关系

005 定义"计什么"（toolText → toolTokens）；006 定义"为什么这么计"（占用模型）。005 的 DeepSeek 限制行、Open Questions 引用 006 的实测证据。未来任何平台的 tool 相关变更，先查 006 的归类表确认占用模式。
