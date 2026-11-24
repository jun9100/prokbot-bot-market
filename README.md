# ProkBot Community Bot Market / ProkBot 社区 Bot 市场

[![Build & Publish Bot Market Index](https://github.com/jun9100/prokbot-bot-market/actions/workflows/build-index.yml/badge.svg)](https://github.com/jun9100/prokbot-bot-market/actions/workflows/build-index.yml)

面向 [ProkBot Host2](https://github.com/jun9100/prokbot-host2) 的公开去中心化社区 Bot 模板市场。所有模板均为纯声明式配置（零作者记忆、无可执行代码、例程默认暂停、全量密钥扫描与 SHA-256 校验），通过 GitHub Actions 自动构建并发布到 GitHub Pages。

A public, decentralized community Bot template registry for [ProkBot Host2](https://github.com/jun9100/prokbot-host2). Every template is purely declarative (zero author memory, no executable scripts, paused routines by default, automated secret scanning, and SHA-256 package digests), automatically validated and published via GitHub Actions to GitHub Pages.

---

## 订阅地址 / Subscription URL

在 ProkBot Host2 管理台 → **Bot 市场 → 订阅源 → 添加订阅源** 中填写：

Add this URL in ProkBot Host2 Admin → **Bot Market → Sources**:

```text
https://jun9100.github.io/prokbot-bot-market/index.json
```

网页目录预览 / Web catalog preview: https://jun9100.github.io/prokbot-bot-market/

---

## 收录模板 / Included Community Bots

| Slug | 名称 / Name | 分类 / Category | 可选联动应用 / Optional Apps |
| --- | --- | --- | --- |
| `daily-digest` | 每日摘要助手 / Daily Digest Assistant | `productivity` | `gmail`, `google-calendar`, `notion` |
| `arxiv-paper-radar` | 论文速读与前沿雷达 / ArXiv Paper Radar | `research` | `rss`, `notion` |
| `meeting-minutes-pro` | 会议纪要与行动追踪官 / Meeting Minutes & Action Tracker | `productivity` | `notion`, `google-calendar`, `calendar-caldav`, `tasks` |
| `homelab-nas-doctor` | 家庭服务器与 Docker 体检医生 / Homelab & Docker Health Doctor | `ops` | `home-assistant`, `web-watch` |
| `release-notes-crafter` | 版本发布说明撰写官 / Release Notes & Changelog Crafter | `coding` | `github`, `linear`, `jira` |
| `japanese-conversation-tutor` | 日语会话与 JLPT 陪练 / Japanese Conversation & JLPT Coach | `learning` | — |

---

## 投稿与本地校验 / Contributing & Local Validation

1. 在 `bots/<your-slug>/` 下添加 `meta.json`、`recipe.json` 以及可选的 `skills/<skill-name>/SKILL.md`。
2. 也可直接从 ProkBot Host2 管理台导出规范条目（`GET /admin/api/bot-market/items/:id/registry-entry`）。
3. 本地运行零依赖校验器（Node.js 20+）：
   ```sh
   node path/to/prokbot-host2/host/tools/build-market-index.mjs --source ./bots --check
   ```
4. 发起 Pull Request，CI 将自动完成结构、双语字段、密钥脱敏、零记忆、暂停例程与确定性 ZIP 打包校验；合并到 `main` 后自动部署到 GitHub Pages。

## 许可证 / License

遵循 `ProkBot Noncommercial License 1.0`（详见 [LICENSE](LICENSE)），仅限非商业用途。
