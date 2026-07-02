# 002: Upstash 数据层（Redis 结构 + 传输管道）

## Status

done（交互层 + 结构锁定 + 探针 + 单测）；真机验收 pending。

**范围定位**：云端传输管道 + Redis 数据结构。本 spec **只提供原语**——怎么跟 Upstash 说话、存什么结构。**不含同步策略**（什么时候读/写、怎么合并对话记录）——那是 [003](./003-cross-device-sync.md)。把 background 在正确时机调用这些原语，也是 003。

## Summary

把 Upstash 作为云端传输层接进扩展：锁定 Redis 上的数据结构，把所有 Upstash 交互（GET/SET/DEL × 对话/设置）做好并解耦。

**关键边界**：002 的写原语是**纯覆盖写**（`setDialogue` = PUT 整条 record）。"读 → 合并 → 写"的编排、合并语义（对话按 messageId union），归 003。002 不关心调用时机和合并逻辑。

## Motivation

README 把 BYO Upstash 当产品核心（"your data stays in your own private storage"）。这一层必须先钉死、可独立验证：**Redis 结构错了，上面 003 的对账/删除/跨设备都失去正确根基**。且 Upstash 交互就是几个 REST 调用、天然解耦——先确定存储结构，同步语义（003）再接。

## Decisions

- **只两个 value 类型上 Redis**，均用 **String 类型**存储：
  - `headroom:conv:{platform}:{dialogueId}` → `DialogueRecord` JSON（结构见 [001](./001-headroom-core.md) Data Model；携带 `updatedAt`）。
  - `headroom:settings` → `{ thresholds, language, contextLimits, updatedAt }`。**凭证永不入云**——没有凭证就读不了 Redis，存它既无用又泄漏。
- **Value 类型选 String（序列化 JSON），不选 Redis JSON**。理由：
  1. **去重要求全量读**——每轮写入前必须检查 `messageId` 是否已存在（防止重新生成重复计数），这一步绕不过去。既然必然读全量 `rounds[]`，JSON 类型的部分更新优势就消失了。
  2. **不变式原子性**——`totalTokens` 必须恒等于 `sum(rounds[].total)`。String 的 GET→内存修改→SET 在逻辑上是一个连贯的 read-modify-write，两个值同步更新。JSON 类型分散为多条命令（`JSON.ARRAPPEND` + `JSON.SET totalTokens` + `JSON.SET roundCount`），命令之间 service worker 可能被 evict，数据会脏。
  3. **内存**——JSON 类型的内部树结构相比序列化字符串有 2–5× 的内存放大。200 轮对话从 ~4 KB 变 8–20 KB。
  4. **依赖**——String 是 Redis 内置类型，JSON 需要 RedisJSON 模块（Upstash 虽支持，但增加平台耦合）。
  5. **序列化开销不关键**——4 KB 文档在浏览器端 `JSON.parse`/`stringify` 是微秒级，不是瓶颈。真正的成本是网络往返，两种类型命令数相同。
- **client 分层**：通用原语 `kvGet` / `kvSet` / `kvDel`（shape 无关的传输层）+ 每个域一个 typed 包装（`getDialogue`/`setDialogue`/`delDialogue`、`getCloudSettings`/`setCloudSettings`/`delCloudSettings`）。新增 Redis 值类型 = 新增一个薄包装，**不是第四条 fetch 路径**。
- **凭证只在本地**（`Settings.upstash`，是 REST API 对：`UPSTASH_REDIS_REST_URL` + `_TOKEN`，不是 Redis 密码）；调试探针读 `.env`（gitignored）。
- **合并语义不在本层**：
  - 设置：LWW（last-write-wins，按 `updatedAt`）——设置是无状态的，LWW 安全。`mergeCloudSettings` 提供合并原语。
  - 对话：**union by messageId**（003）。002 的 `setDialogue` 只是覆盖写整条 record；"读旧 record → union 合并 → 写新 record"的编排是 003 的职责。

## Requirements

### P0

- [x] Redis 结构锁定（2 key）+ 全部交互 GET/SET/DEL ×（conv + cloud-settings）
- [x] 凭证剥离（`toCloudSettings`）+ 设置 LWW 合并原语（`mergeCloudSettings`）
- [x] 真库探针 `scripts/probe-upstash.mjs`（自清，断言无凭证泄漏）
- [x] 单测覆盖：kv 原语 / dialogue 包装 / 凭证剥离 / 设置 LWW（mock fetch）

### P1

- [x] 真机验收（见 Acceptance）

## Design

### REST 契约

浏览器扩展只能走 HTTPS REST（说不了原生 Redis）。**一条 HTTPS POST = 一条命令**：

```
POST {UPSTASH_REDIS_REST_URL}/
Header: Authorization: Bearer {UPSTASH_REDIS_REST_TOKEN}
Body:   JSON 命令数组  ["GET", key] / ["SET", key, val] / ["DEL", key] / ["SCAN", cursor, "MATCH", pattern, "COUNT", n]
→ { "result": <string|null> }
```

- **8s `AbortController` 超时**——卡死的 Upstash 不能拖垮 service worker。
- **空凭证 ⇒ 每个 op 静默 no-op**（Upstash 可选；仪表盘靠本地状态工作，见 001）。
- 失败处理：本层 throw；**调用方（003）决定是 warn 丢弃还是重试**。002 不内置重试/缓冲。

### Client 分层

```
kvGet / kvSet / kvDel / kvScan   ← 通用原语（shape 无关，只管 REST 传输）
   │
   ├─ getDialogue / setDialogue / delDialogue        ← typed 包装（conv 域）
   └─ getCloudSettings / setCloudSettings / delCloudSettings  ← typed 包装（settings 域）
```

`setDialogue` = 覆盖写整条 record（纯 PUT，不读旧值）。合并编排（`getDialogue` → union → `setDialogue`）在 003。

### 数据结构

| Redis key                               | 值                                                                      | 凭证？      |
| --------------------------------------- | ----------------------------------------------------------------------- | ----------- |
| `headroom:conv:{platform}:{dialogueId}` | `DialogueRecord` JSON（ rounds[] 只含 token 计数，无文本；`updatedAt`） | —           |
| `headroom:settings`                     | `{ thresholds, language, contextLimits, updatedAt }`                    | ❌ 永不入云 |

> `DialogueRecord` / `RoundRecord` 结构定义在 [001](./001-headroom-core.md)。本地 `Settings` 保留完整对象（含凭证）；云端只存剥离后的 shape（`toCloudSettings`）。

### 免费层预算（为何 read-modify-write 可接受）

Upstash 免费层：256 MB 存储、**50 万命令/月**（账户级，非按 key）。增量路径每轮 ≈ 2 命令（GET+SET），删除 = 1，设置保存 = 1。50 万/月 ≈ 25 万轮，远超单用户。`DialogueRecord` 只存 token 计数（50 轮 ≈ 4 KB），256 MB ≈ 6.5 万对话，存储非瓶颈。（003 的僵尸清理在长期离线后可能 burst 命令，但总量仍在预算内——排出的都是真实活动。）

> 凭证若泄漏会怎样：别人能读你的对话 token 计数（无文本）。所以凭证只存本地、永不入云、不记日志。详细预算与凭证安全见 `AGENTS.md` "Upstash (Redis) data model"。

### 探针

`node scripts/probe-upstash.mjs`——读 `.env`，对 throwaway `headroom:_probe:*` key 跑 GET/SET/DEL ×（conv + settings），自清在 `finally`，并断言存储的 settings JSON 里无凭证。**不属于 `npm test`**。

## Implementation Plan

1. 交互层 + 探针 + 单测 — done。
2. 凭证剥离 + 设置 LWW 原语 — done。

剩余：真机验收（Acceptance 两条 pending）。

## Acceptance Criteria

- [x] 单测：kv 原语 / dialogue 包装 / 凭证剥离 / 设置 LWW（mock fetch）
- [x] 真库：探针 6/6（conv 与 settings 各 SET→GET→DEL），存储 JSON 无凭证
- [x] 真机：DeepSeek 聊几轮 → Upstash 控制台出现 `headroom:conv:deepseek:*`（依赖 003 接线）
- [x] 真机：设置 Save → Upstash 出现 `headroom:settings`（无凭证字段）

## Open Questions

- [x] 调用方推云失败如何处理：002 只 throw；warn 丢弃 / 下次打开重算补回的策略由 003 定（已按此分工）。
