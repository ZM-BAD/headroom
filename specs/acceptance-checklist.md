# Acceptance Checklist

**真机验收清单** — 每一行必须在真实浏览器 + 真实 AI 平台页面上手动验证并打勾。
自动化（typecheck / lint / unit test / build）不能替代这份清单 — 它们只验证逻辑，
不验证浏览器 API、平台 API 和真实用户交互。

> **使用方式**：每次真机测试前，复制一份到本地，逐项打勾。完成后把结果贴到
> commit message 或 PR 描述中。

---

## 前置条件

- [x] Chrome ≥149 已安装
- [x] 扩展已加载（`chrome://extensions` → 加载已解压的扩展 → 选 `.output/chrome-mv3/`）
- [x] 已配置 Upstash（设置面板填入 REST URL + Token → 测试连接 → 保存）
- [x] 已登录至少两个 AI 平台（DeepSeek 必测，其余任选 2–3 家交叉验证）

---

## 001 核心监控（闸门 1 — DeepSeek 必过）

### 安装与激活

- [x] **001-01** 非平台页（如 `github.com`）→ 工具栏图标灰化，点击无反应（三维 ACL 方案：`setIcon` 灰度 + `onClicked` 拦截 + `setOptions({enabled:false})`）
- [x] **001-02** 打开 `chat.deepseek.com` → 图标变亮，可点击
- [x] **001-03** 点击图标 → 原生侧边栏打开，显示 Headroom UI
- [x] **001-04** 侧边栏显示 "DeepSeek" 平台名 + context limit（1,048,576）
- [x] **001-05** 主页（未点开具体对话）→ 仪表盘显示 IDLE 态（进度条为 0）
- [x] **001-06** 关闭侧边栏（点 × 或再点图标）→ 正常关闭

### 对话加载

- [x] **001-07** 点开已有对话 → 仪表盘从 0 爬升到真实累计值（不会卡在 0）
- [x] **001-08** 对话标题 + dialogueId 正确显示（标题不为空，id 可 hover 看全）
- [x] **001-09** 轮次数 = 对话实际问答对数
- [x] **001-10** 对话轮次表格显示每轮 prompt/answer token + 累计

### 实时增量

- [x] **001-11** 发一条新消息 → 等待回答完毕 → 面板更新（轮次 +1，累计增加）
- [x] **001-12** 进度条长度随累计 token 增长
- [x] **001-13** 占比超过黄阈值（默认 50%）→ 进度条变黄色
- [x] **001-14** 占比超过红阈值（默认 70%）→ 进度条变红色
- [x] **001-15** 低于黄阈值 → 绿色，状态文字 "空间充足"

### SPA 切对话

- [x] **001-18** 在 DeepSeek 侧边栏点另一个对话 → 面板更新为新对话数据
- [x] **001-20** 切回主页 → IDLE 态

### 设置面板

- [x] **001-21** ⚙️ 进入设置 → 显示阈值双滑块 + context 覆盖 + 语言下拉 + Upstash 配置
- [x] **001-22** 拖黄滑块到 40% → 保存 → 回主视图 → 40% 时变黄
- [x] **001-23** 拖红滑块到 60% → 保存 → 60% 时变红
- [x] **001-24** 重置阈值 → 恢复到默认 50%/70%
- [x] **001-25** 改 DeepSeek context limit 为 500,000 → 保存 → 主视图显示 500,000
- [x] **001-26** 切换语言 → UI 文字变化（至少试 en ↔ zh_CN）

### 删除对话

- [x] **001-27** 在 DeepSeek 页面删除一个对话 → 面板归零（本地 record 被清）

---

## 001 闸门 2 — 其他平台冒烟

> 以下每平台至少验证：加载、切对话、删除。至少覆盖 3 家。
> （ChatGPT / Gemini / 豆包的"一轮问答后面板更新"已知有 bug，不在本次验收范围内。）

### ChatGPT (`chatgpt.com`)

- [x] **001-CG-01** 打开已有对话 → 面板显示累计
- [x] **001-CG-03** 切对话 → 面板换数据
- [x] **001-CG-04** 删除对话 → 归零

### Gemini (`gemini.google.com`)

- [x] **001-GM-01** 打开已有对话 → 面板显示累计（DOM 兜底路径）
- [x] **001-GM-03** 切对话 → 面板换数据

### Kimi (`www.kimi.com`)

- [x] **001-KM-01** 打开已有对话 → 面板显示累计
- [x] **001-KM-02** 一轮问答后面板更新
- [x] **001-KM-03** 切对话 → 面板换数据

### Qwen (`chat.qwen.ai`)

- [x] **001-QW-01** 打开已有对话 → 面板显示累计
- [x] **001-QW-02** 一轮问答后面板更新
- [x] **001-QW-03** 切对话 → 面板换数据

### 通义千问 (`www.qianwen.com`)

- [x] **001-TY-01** 打开已有对话 → 面板显示累计（分页路径）
- [x] **001-TY-02** 一轮问答后面板更新
- [x] **001-TY-03** 切对话 → 面板换数据

### 豆包 (`www.doubao.com`)

- [x] **001-DB-01** 打开已有对话 → 面板显示累计（IM 协议路径）
- [x] **001-DB-02** 一轮问答后面板更新（IM chain 异步落库,靠 settle 重试 — 2026-07 真机验证）
- [x] **001-DB-03** 切对话 → 面板换数据

---

## 002 Upstash 数据层（真机）

- [x] **002-01** DeepSeek 聊 3 轮 → 打开 Upstash 控制台 → 出现 `headroom:conv:deepseek:*` key
- [x] **002-02** 控制台查看该 key → value 是合法 JSON，包含 `rounds[]` 且无对话文本
- [x] **002-03** 设置面板 Save → 控制台出现 `headroom:settings`
- [x] **002-04** `headroom:settings` value 中**没有 `url` / `token` 字段**（凭证剥离验证）
- [x] **002-05** 清除 Upstash 配置 → 删除对话 → 不会报错（no-creds = no-op）

---

## 003 跨设备对账（真机 — 核心风险区）

### 打开即对账

- [x] **003-01** 第一次装扩展 → 打开已有对话 → 仪表盘从 0 爬到真实累计（不等网络）
- [x] **003-02** 关面板再开 → 秒开（读本地缓存，不等 Upstash）
- [x] **003-03** 在有 Upstash 记录的对话中再聊一轮 → Upstash 值更新（覆盖写整条）

### 跨设备（需要两台设备 / 两个浏览器 Profile）

- [x] **003-04** 设备 A 聊 5 轮 → 设备 B 打开同对话 → B 显示 5 轮累计（不是 0）
- [x] **003-05** 设备 A 聊完后设备 B 再聊 2 轮 → 设备 A 打开显示 7 轮
- [x] **003-06** 对话包含移动端聊的轮次（如果有）→ 纳入累计

### Upstash 事后接入

- [x] **003-07** 不填 Upstash → 聊 3 轮 → 填正确 Upstash 保存 → 打开同对话 → 3 轮已推送到 cloud（控制台可见 `headroom:conv:…` key）

### union 合并正确性

> 重新生成场景暂不验收——涉及平台树形对话结构，各平台 `/regenerate` 端点不统一，非 MVP 范围。

### 删除联动 + 僵尸清理

- [x] **003-10** 网页删对话 → 本地缓存 + Upstash key 都消失
- [x] **003-11** 打开平台首页 → 触发僵尸清理，孤儿 key 被 DEL（至少 DeepSeek + ChatGPT 各验一次）。等价于验证：设备 A 删对话 → 设备 B 打开首页 → Upstash 记录被清理
- [x] **003-12** 等 60min → DevTools Console 无 `zombie cleanup failed` 错误
  - **操作**：保持扩展运行 >1h，期间偶尔打开 DevTools Console 看有无 zombie cleanup 报错。

### 对账频率控制（debounce）

- [x] **003-13** 快速切对话时仪表盘立即切换（从缓存读，不卡顿）
  - **操作**：打开一个对话等它加载完，切到另一个对话，立刻切回第一个。面板**瞬间**显示第一个对话的数据（来自本地缓存），不会短暂空白或显示检测中。
- [x] **003-14** 回答完毕后立即拉历史（代码路径审查：REFRESH_HISTORY 走独立分支直调 `fetchAndShipHistory()`，不经过 SPA debounce）

---

## 跨浏览器冒烟（001 闸门 3）

### Edge

- [x] **CB-01** 能安装
- [x] **CB-02** DeepSeek 打开对话 → 面板显示累计
- [x] **CB-03** 一轮问答后面板更新
- [x] **CB-04** 侧边栏打开/关闭正常
- [x] **CB-E05** 切回 DeepSeek 面板不自动恢复（已知平台限制，Microsoft issue [#222](https://github.com/microsoft/MicrosoftEdge-Extensions/issues/222) 确认为设计差异，不可修复。需手动点击图标）

### Firefox

- [x] **CB-05** 能安装（sidebarAction 不是 sidePanel）
- [x] **CB-06** DeepSeek 打开对话 → 面板显示累计
- [x] **CB-07** 一轮问答后面板更新
- [x] **CB-08** 侧边栏打开/关闭正常（Firefox 用 sidebarAction，全局面板。切标签页不关——这是 Firefox 平台限制，`sidebarAction.close()` 需要用户手势）
- [x] **CB-09** 非平台页图标灰化，点击无反应（`action.setIcon` reset-then-set + `onClicked` 拦截）
- [x] **CB-10** 切到非平台页侧栏内容切换为提示页（`sidebarAction.setPanel("not-supported.html")`），切回平台页恢复正常

---

## 跨浏览器深度 QA（Firefox 差异点）

> 冒烟通过后，逐项验证 Firefox 与 Chrome 的已知差异。

### Side Panel 差异

- [x] **CB-F01** Firefox 使用 `sidebarAction`（非 `sidePanel`）——面板打开/关闭生命周期与 Chrome 一致
- [x] **CB-F02** Firefox 侧边栏是全局的（不能像 Chrome 那样按 tab 关闭）——确认切换非平台页时面板行为合理

### Service Worker 生命周期

- [x] **CB-F03** 重载扩展后核心功能正常
  - **操作**：打开 `about:debugging#/runtime/this-firefox` → 点 Headroom 的"重新加载"按钮 → 刷新 DeepSeek 页面 → 打开一个对话 → 面板正常显示累计。
- [x] **CB-F04** 浏览器重启后核心功能正常
  - **操作**：完全退出 Firefox → 重新打开 → 打开 DeepSeek 对话 → 面板正常显示累计（SW 从冷启动恢复，消息通道和 alarms 正常）。

### webRequest 行为差异

- [x] **CB-F05** Firefox 的 `webRequest.onBeforeRequest` 支持 `requestBody`——确认删除拦截正常
- [x] **CB-F06** `onCompleted` / `onErrorOccurred` 触发时机与 Chrome 一致——SSE 流关闭 = 回答完毕判定准确

### 存储差异

- [x] **CB-F07** Firefox `storage.local` 配额基于磁盘空间（非 Chrome 的 10 MB）——确认大量对话后无异常
- [x] **CB-F08** `storage.local` 读写延迟在可接受范围内

### alarms 差异

- [x] **CB-F09** Firefox `alarms` 最小 interval ≥1 min（Chrome 支持 10s）——僵尸清理 60min 周期不受影响

### 综合

- [x] **CB-F10** 至少一个其他平台（ChatGPT/Kimi/Qwen 任选一）完整走通"打开→聊一轮→删除→切对话"流程

---

## UI 国际化

- [x] **I18N-01** 切到每种 UI 语言 → 面板文字正确（至少验证 en + zh_CN + ja）
- [x] **I18N-02** 设置面板语言标签正确
- [x] **I18N-03** 状态文字（"空间充足"/"Headroom running low"等）翻译正确

---

## 不验证的项（说明理由）

| 项                           | 理由                                                           |
| ---------------------------- | -------------------------------------------------------------- |
| token 估算精度（004 范围）   | v1 系数未标定，已知不精确，验收标准在 004                      |
| 移动端真机聊                 | 需手机 + 对应 App，条件有限；可由跨设备对账间接验证（003-06）  |
| `storage.local` 精确定量测量 | 需构造 50+ 对话，人工不现实；代码中有 LRU 常量和单元测试保证   |
| 重新生成（001-16/003-08）    | 各平台 `/regenerate` 端点不统一，涉及树形对话结构，非 MVP 范围 |
| 停止生成（001-17）           | 各平台 `/stop` 端点不统一，后续统一处理                        |
