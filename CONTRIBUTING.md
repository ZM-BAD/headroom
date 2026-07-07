# Contributing to Headroom

感谢你对 Headroom 的关注！我们欢迎各种形式的贡献。

## 报告 Bug

有两种方式反馈问题：

- **GitHub Issues**：[点击创建 issue](https://github.com/ZM-BAD/headroom/issues/new/choose)
- **Discord/邮件**：如果涉及敏感信息，请私下联系我

### 提 Issue 前请确认

- [ ] 已重新加载扩展卡片（`chrome://extensions` → 🔄）
- [ ] 已刷新目标平台页面（F5）
- [ ] 已检查是否有重复 issue

### 有用的信息

请尽可能提供以下信息，有助于快速定位：

- 平台名称（DeepSeek / ChatGPT / Gemini / Kimi / Qwen / 通义千问 / 豆包）
- 浏览器及版本（Chrome / Edge / Firefox + 版本号）
- 扩展版本（在 `chrome://extensions` 中查看）
- 复现步骤
- 期望 vs 实际行为
- Console 日志（F12 → Console，筛选 `[Headroom]`）
- 截图（如果有帮助）

## 测试矩阵

Headroom 覆盖多个平台×浏览器的组合。核心功能测试在每次发布前由维护者完成，**社区测试帮助我们覆盖更多边缘场景**。

以下是我们特别需要社区反馈的测试类别：

### 跨平台冒烟测试

如果你有空，可以帮忙验证以下平台的基础功能：

- 工具栏图标在该平台不灰化
- 打开对话面板能加载
- dialogueId 显示正确
- 删除拦截生效（如已配置）
- 打开已有对话框后面板显示累计 token + 轮数
- 对话标题正确显示

### Token 估算验证

- CJK 字符：token ≈ 字 × 0.6 tok/ch
- 假名 / 谚文：按字符数 × 各自系数
- 英文 / 拉丁字母：token ≈ 词数 × 0.5 tok/wd
- 中英混排：CJK 按字计、英文按词计，互不重复计数

### 轮次生命周期

- 新增一轮：轮次 +1，累计增加
- 重新生成：轮次不变，该轮 token 更新
- 停止生成：不视为完成
- SPA 切对话：面板换新对话数据

### 历史对话加载

打开一个较长对话（5+ 轮）后检查：

- 面板显示的轮数 = 实际问答对数
- 累计 token 量级合理

## 代码贡献

### 设置开发环境

```bash
# 克隆项目
git clone https://github.com/ZM-BAD/headroom.git
cd headroom

# 安装依赖
npm install

# 准备 WXT 类型
npx wxt prepare

# 开发构建（输出到 .output/chrome-mv3-dev/）
npm run dev

# 生产构建（输出到 .output/chrome-mv3/）
npm run build
```

### 代码质量检查

**每次改动后必跑（顺序执行）：**

```bash
npm run typecheck   # TypeScript 类型检查（tsc --noEmit）
npm run lint        # ESLint 检查
npm run test:run    # Vitest 单元测试（utils + adapters）
npm run build       # 生产构建（wxt build 不包含 typecheck！）
```

> **`npm run build` 用 esbuild 转译，不做类型检查**——绿构建 ≠ 类型正确。先跑 `typecheck`。

### 测试

**单元测试**覆盖 `utils/`（纯逻辑）和 `adapters/`（parse 函数）：

```bash
npm run test:run        # 一次运行全部
npm run test            # watch 模式（开发时用）
npx vitest --coverage   # 覆盖率报告（需要 @vitest/coverage-v8）
```

单元测试跑在 node 环境（无 browser API），`browser.*` 调用需 mock。

**entrypoint（background / content script / side panel）目前不跑单元测试**——它们重度依赖 `browser.*` API（tabs、webRequest、storage、runtime…），mock 成本高、收益低。这些由**真机验收 checklist**（见 `specs/acceptance-checklist.md`）和未来的 Playwright E2E 套件覆盖。

### 代码风格

- 使用 TypeScript 严格模式
- 遵循 [Conventional Commits](https://www.conventionalcommits.org/) 格式（`commitlint` 在 commit-msg 钩子强制校验）
- 文件长度尽量控制在 200 行以内
- 相关测试请一并更新
- 架构决策记录在 `specs/` 中——改设计前先读相关 spec

### 项目结构

```
headroom/
├── entrypoints/             # WXT 入口点
│   ├── background.ts        # 后台 service worker（引擎核心）
│   ├── platform.content.ts  # 内容脚本（通用，全平台注入）
│   └── sidepanel/           # 侧边栏 UI（主视图 + 设置）
├── adapters/                # 各平台适配器（新增平台 = 加一个文件）
│   ├── index.ts             # 适配器注册表
│   ├── deepseek.ts          # DeepSeek 参考实现
│   └── __tests__/           # 适配器 parse 测试
├── utils/                   # 工具函数（纯逻辑，有单测覆盖）
│   ├── estimate.ts          # 六路文字系统 token 估算引擎 (spec 004)
│   ├── dialogue-record.ts   # 对话记录数据结构 + union merge
│   ├── upstash.ts           # Upstash REST 客户端
│   ├── local-cache.ts       # 本地缓存 LRU 淘汰
│   ├── platform-adapter.ts  # 适配器接口定义
│   ├── messages.ts          # 消息协议类型
│   ├── settings.ts          # 设置存取
│   ├── cloud-settings.ts    # 云端设置（凭证剥离）
│   ├── thresholds.ts        # 预警阈值逻辑
│   └── match-host.ts        # URL → platform 匹配
├── brand/                   # 项目 logo 源文件（SVG）
│   ├── blue.svg             # 主 logo（Headroom 仪表盘图标）
│   └── white.svg            # 浅色背景备用
├── icon/                    # 平台 logo（SVG，供 UI 使用）
│   ├── default.svg          # 默认图标（→ ../brand/blue.svg 软链接）
│   ├── deepseek.svg — qwen.svg  # 7 个平台品牌 logo
│   └── openai.svg           # ChatGPT 使用 OpenAI logo
├── public/                  # 静态资源
│   ├── _locales/            # i18n 翻译（en + zh_CN 完整，其余回退英文）
│   └── icon/                # 扩展图标 PNG（从 brand/blue.svg 渲染）
├── specs/                   # 设计规格 + 验收 checklist
│   ├── 001-headroom-core.md
│   ├── 002-upstash-data-layer.md
│   ├── 003-cross-device-sync.md
│   ├── 004-optimizations.md
│   ├── ROADMAP.md
│   └── acceptance-checklist.md
├── scripts/
│   └── probe-upstash.mjs    # Upstash 连通性探针（不在 npm test 中）
├── public/                  # 静态资源（图标、_locales 翻译）
└── wxt.config.ts            # WXT 配置
```

### Pull Request 流程

1. Fork 仓库
2. 创建特性分支（`feature/xxx` 或 `fix/xxx`）
3. 开发 + 跑 `typecheck && lint && test:run && build`
4. 更新相关 spec（设计有变时）
5. 提交 PR（关联相关 Issue）

## 设计决策

如果你对架构有建议，请先开 Issue 讨论再动手。

关键原则：

- **Token 永远自己估算**，不信任平台返回的 token 数
- **永远不存对话文本**到云端，只存计数
- **尽可能分享代码**，各平台 fetchHistory 之外的部分共用

## 其他贡献方式

- 📖 完善文档
- 🌐 翻译 UI 文案
- 🎨 设计图标、Logo
- 📣 宣传 Headroom

谢谢你的贡献！
