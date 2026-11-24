# ProkBot Community Bot Market / ProkBot 社区 Bot 市场

[![Build & Publish Bot Market Index](https://github.com/jun9100/prokbot-bot-market/actions/workflows/build-index.yml/badge.svg)](https://github.com/jun9100/prokbot-bot-market/actions/workflows/build-index.yml)

面向 ProkBot Host2（基于 [ProkBot Plus](https://github.com/ferretgeek/prokbot-plus) 生态）的公开去中心化社区 Bot 模板市场。所有模板均为纯声明式配置（零作者记忆、无可执行代码、例程默认暂停、全量密钥扫描与 SHA-256 校验），通过 GitHub Actions 自动构建并发布到 GitHub Pages。

A public, decentralized community Bot template registry for ProkBot Host2 (in the [ProkBot Plus](https://github.com/ferretgeek/prokbot-plus) ecosystem). Every template is purely declarative (zero author memory, no executable scripts, paused routines by default, automated secret scanning, and SHA-256 package digests), automatically validated and published via GitHub Actions to GitHub Pages.

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
| `arxiv-paper-radar` | 论文速读与前沿雷达 / ArXiv Paper Radar | `research` | `rss-feeds`, `notion` |
| `meeting-minutes-pro` | 会议纪要与行动追踪官 / Meeting Minutes & Action Tracker | `productivity` | `notion`, `google-calendar`, `calendar-caldav`, `tasks` |
| `homelab-nas-doctor` | 家庭服务器与 Docker 体检医生 / Homelab & Docker Health Doctor | `ops` | `home-assistant`, `web-watch` |
| `release-notes-crafter` | 版本发布说明撰写官 / Release Notes & Changelog Crafter | `coding` | `github`, `linear`, `jira` |
| `japanese-conversation-tutor` | 日语会话与 JLPT 陪练 / Japanese Conversation & JLPT Coach | `learning` | — |

---

## 投稿与本地校验 / Contributing & Local Validation

### 中文指南
1. 在 `bots/<your-slug>/` 下添加 `meta.json`（`slug` 必须与目录名完全一致）、`recipe.json`，以及可选的 `skills/<skill-name>/SKILL.md`。目录下不允许存放其他额外文件或可执行脚本。
2. 也可直接从 ProkBot Host2 管理台导出规范条目（`GET /admin/api/bot-market/items/:id/registry-entry`）。
3. **字段约束**：
   - 允许的分类（`category`）：`productivity`、`coding`、`research`、`life`、`ops`、`writing`、`learning`、`finance`。
   - 常用 Host2 内置连接应用 ID（`requiredApps` / `optionalApps`）：`gmail`、`email-imap`、`google-calendar`、`calendar-caldav`、`github`、`notion`、`places`、`rss-feeds`、`home-assistant`、`web-watch`、`tasks`、`linear`、`jira`、`feishu`、`slack`、`google-drive`、`webdav`、`weather`、`obsidian`、`knowledge-base`、`vaultwarden`、`onepassword-connect`、`handoff-workflows`。
   - 预设例程（`routines[].schedule`）须填写标准 5 字段 cron 表达式（如 `"30 8 * * *"`），且安装后强制默认暂停（`isEnabled: false`）。
4. 本地校验与试构建（Node.js 20+，零外部依赖）：
   ```sh
   node tools/host/tools/build-market-index.mjs --source ./bots --check
   node tools/host/tools/build-market-index.mjs --source ./bots --output ./dist
   ```
5. 发起 Pull Request（外部投稿 PR 仅允许修改 `bots/**` 和 `README.md`，不可改动 `tools/`、`site/` 或 `.github/`）。CI 将使用基线分支上的可信校验器自动执行结构、双语字段、密钥脱敏、零记忆、暂停例程与确定性 ZIP 试构建；合并到 `main` 后自动发布到 GitHub Pages。

### English Guide
1. Add `bots/<your-slug>/meta.json` (where `meta.slug` must exactly match the directory name), `recipe.json`, and optional `skills/<skill-name>/SKILL.md` files. Extra files or executable scripts inside bot directories are rejected.
2. You can also export a compliant template entry directly from ProkBot Host2 Admin (`GET /admin/api/bot-market/items/:id/registry-entry`).
3. **Schema rules**:
   - Allowed `category` values: `productivity`, `coding`, `research`, `life`, `ops`, `writing`, `learning`, `finance`.
   - Built-in Host2 Connected App IDs (`requiredApps` / `optionalApps`): `gmail`, `email-imap`, `google-calendar`, `calendar-caldav`, `github`, `notion`, `places`, `rss-feeds`, `home-assistant`, `web-watch`, `tasks`, `linear`, `jira`, `feishu`, `slack`, `google-drive`, `webdav`, `weather`, `obsidian`, `knowledge-base`, `vaultwarden`, `onepassword-connect`, `handoff-workflows`.
   - Routine schedules (`routines[].schedule`) must be valid 5-field cron expressions (e.g. `"30 8 * * *"`); all routines are forced to `isEnabled: false` on packaging and install.
4. Run zero-dependency validation and dry-run build locally (Node.js 20+):
   ```sh
   node tools/host/tools/build-market-index.mjs --source ./bots --check
   node tools/host/tools/build-market-index.mjs --source ./bots --output ./dist
   ```
5. Open a Pull Request (external PRs may only modify `bots/**` and `README.md`; modifications to `tools/`, `site/`, or `.github/` are blocked by CI). CI validates every PR against the trusted base-branch validator and runs a full `./dist` build before merging to `main` deploys to GitHub Pages.

---

## 许可证与声明 / License & Attribution

遵循 `ProkBot Noncommercial License 1.0`（详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)），仅限非商业用途。

Licensed under `ProkBot Noncommercial License 1.0` (see [LICENSE](LICENSE) and [NOTICE](NOTICE)). Non-commercial use only.
