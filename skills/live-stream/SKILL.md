---
name: live-stream
description: Use when implementing or maintaining passive live-stream watching, including verified live-entry flows, current-room switching, capture timing, and account-safe limits.
---

# Live Stream

There are two runtime paths:

- `server/src/skills/live-entry.js`: enters and validates supported live rooms for Douyin, Taobao, JD, WeChat, and Xiaohongshu.
- `server/src/skills/live-stream.js`: operates only when the target App is already foregrounded in a live room.

Both paths must start capture after the live-room state is checked, then run bounded `wait -> swipe` loops. The default switch interval is randomized between two and five minutes; explicit intervals are clamped and jittered.

Use current screen dimensions or scaling metadata for swipe coordinates. Verify live-room evidence with Activity, UI text, or screen motion where the App supports it.

Do not send chat, follow, like, gift, pay, buy products, open shopping carts, or bypass account prompts.
