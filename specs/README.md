# Specs

Spec-Driven Development 规范目录。所有功能开发必须先写 spec，再实现。

## 流程

```
draft/ → active/ → completed/
  编写     评审通过     已实现
```

1. **Draft**: 新功能/变更先在 `draft/` 中编写 spec
2. **Active**: Spec 评审通过后移入 `active/`，开始实现
3. **Completed**: 实现并验证通过后移入 `completed/` 归档

## 规则

- **No spec, no code** — 没有对应的 active spec，不写实现代码
- Spec 文件名格式: `{序号}-{kebab-case-name}.md`，如 `001-popup-ui.md`
- 序号自增，从 001 开始
- 实现完成后在 spec 中追加 **Implementation Notes** 记录偏差和决策
- `templates/` 中提供 spec 模板，新 spec 基于模板创建

## 目录

| 目录         | 用途             |
| ------------ | ---------------- |
| `templates/` | Spec 模板        |
| `draft/`     | 草稿，尚未评审   |
| `active/`    | 已批准，正在实现 |
| `completed/` | 已实现，归档     |
