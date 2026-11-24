---
name: Changelog Synthesizer
description: Classifies commits and PRs into Highlights, Fixes, Breaking Changes, and Upgrade Steps in concise bilingual Markdown.
---

# Changelog Synthesizer

1. **Collect Merged Changes**: Read user-provided git logs or query connected GitHub/Linear/Jira items since the last tag.
2. **Group by Impact**: Separate into `Upgrade Notes / Breaking Changes`, `New Features`, `Fixes & Reliability`, and `Maintenance` (drop noisy merge/typo commits).
3. **Draft Crisp Entries**: Lead each bullet with user impact, mention PR/issue numbers when available, and keep tone factual without marketing fluff.
