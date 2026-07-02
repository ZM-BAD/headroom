# Contributing to Headroom

感谢你对 Headroom 的关注！我们欢迎各种形式的贡献。

## 报告 Bug

有两种方式反馈问题：

- **GitHub Issues**：[点击创建 issue](https://github.com/badlogic/headroom/issues/new/choose)
- **Discord/邮件**：如果涉及敏感信息，请私下联系我

### 提 Issue 前请确认

- [ ] 已重新加载扩展卡片（`chrome://extensions` → 🔄）
- [ ] 已刷新目标平台页面（F5）
- [ ] 已检查是否有重复 issue

### 有用的信息

请尽可能提供以下信息，有助于快速定位：

- 平台名称（DeepSeek / ChatGPT / Gitmi / Kimi / Qwen / 通义千问 / 豆包）
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

- 纯中文消息：token ≈ 字数 × 0.6
- 纯英文消息：token ≈ 词数 × 0.5
- 中英混排：按字符类型分别计费

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
git clone https://github.com/badlogic/headroom.git
cd headroom

# 安装依赖
npm install

# 准备 WXT 类型
npx wxt prepare

# 开发构建（输出到 .output/chrome-mv3-dev/）
npm run dev

# 生产构建（输出到 .output/chrome-mv3/）
npm run build

# 代码检查
npm run lint
npm run typecheck
npm run test
```

### 代码风格

- 使用 TypeScript 严格模式
- 遵循 Conventional Commits 格式
- 文件长度尽量控制在 200 行以内
- 相关测试请一并更新

### 文件结构

```
headroom/
├── entrypoints/          # WXT 入口点
│   ├── background.ts     # 后台 service worker
│   ├── platform.content.ts  # 内容脚本（通用）
│   └── sidepanel/        # 侧边栏 UI
├── adapters/             # 各平台适配器
├── utils/                # 工具函数
│   ├── platform-adapter.ts  # 适配器接口定义
│   ├── upstash.ts        # Upstash REST 客户端
│   └── estimate.ts       # Token 估算引擎
├── public/               # 静态资源（图标、翻译）
├── specs/                # 设计规格
└── docs/                 # 文档
```

### Pull Request 流程

1. Fork 仓库
2. 创建特性分支（`feature/xxx` 或 `fix/xxx`）
3. 开发 + 测试
4. 更新本文档（如果涉及）
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
