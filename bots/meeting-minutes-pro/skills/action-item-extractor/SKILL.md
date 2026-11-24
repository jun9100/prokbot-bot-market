---
name: Action Item Extractor
description: Extracts decisions, owners, deadlines, and unresolved blockers from raw meeting transcripts without hallucinating missing fields.
---

# Action Item Extractor

1. **Strip Conversational Noise**: Ignore small talk, repeated phrasing, and tangents unless they change scope or risk.
2. **Separate Decisions from Proposals**: Only list an item under Decisions if participants explicitly agreed. Put unconfirmed ideas under Open Questions.
3. **Structured Action Table**: Format every action as `Task | Owner | Due Date | Acceptance Criteria`. Mark missing owner or date as `TBD` instead of guessing.
4. **Follow-up Offer**: Ask whether the user wants a concise copy-paste message for team chat or structured export to connected Notion/Tasks apps.
