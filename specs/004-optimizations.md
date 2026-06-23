# 004: 优化 — Token 系数校准 + 跨浏览器查缺补漏

## Status

远期 stub（主干 [001](./001-headroom-core.md) / [002](./002-upstash-data-layer.md) / [003](./003-cross-device-sync.md) 跑通后再展开）。两件事都是**非主干优化**，都不大；轮到时可拆成两个 spec。

## Summary

两个独立优化主题，合一 spec：

1. **Token 估算系数校准（正确性）**：把 001 的「平台 × 脚本」系数矩阵从 v1（中文/英文）扩到更多脚本，并按各平台真实 tokenizer 精确校准。
2. **跨浏览器深度 QA（可移植性）**：开发以 Chrome 为主，Edge 基本跟随，Firefox 补齐边角交互差异。

## 主题 1：Token 系数校准

**现状（001）**：CJK + Latin 两脚本，DeepSeek 系数为起点值（`cjk 0.6 / latin 0.5`，待标定）；其余平台沿用同值。

**目标**：

- 扩脚本：西里尔、阿拉伯、日文假名、等——给每种脚本独立系数（v1 都归 Latin 桶，偏差大）。
- 按平台 tokenizer 校准：同一脚本在不同平台系数不同（DeepSeek 与 Qwen/GPT 的汉字系数差异等）。
- 标定基准：可借用平台服务端返回的 token 数（DeepSeek/Qwen/通义千问有）作参照，对照估测值回归系数。

**验收**：估算值 vs 真实 tokenizer，各脚本/平台落在给定误差带内。

## 主题 2：跨浏览器深度 QA

**现状（001 闸门 3）**：Chrome / Edge / Firefox **冒烟**（能装能开面板、DeepSeek 一轮跑通）。

**目标**：Firefox 的边角差异查缺补漏——`sidePanel` vs `sidebarAction` 生命周期、service worker vs event page、`webRequest` 行为差异等；Edge 跟随 Chrome，只验一致。

**验收**：三端功能 / 生命周期 / 拦截行为一致。

## Open Questions

- [ ] 各脚本 × 平台系数的标定基准与可接受误差带。
- [ ] 是否在 004 引入轻量 tokenizer 作可选精度升级（仍非默认路径）。
- [ ] Firefox 差异清单：哪些交互在三端表现不一，需各自适配。
