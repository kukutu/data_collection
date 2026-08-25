---
name: live-stream
description: Use when implementing, maintaining, or operating passive live-stream watching skills in data_collect_agent, including current-room-only viewing, timed waits, and swipe-based live room switching without chat, gifts, follows, likes, or purchases.
---

# Live Stream

Keep the skill folder as repo-level guidance for the runtime implementation in `server/src/skills/live-stream.js`.

Use this skill only after the user has manually entered a live room. The harness should verify the current foreground package when available, then execute a loop of `wait -> swipe` until the requested duration is reached.

Generate only `wait`, `swipe`, and `complete` steps. Do not launch into unknown live rooms, send chat messages, follow, like, gift, pay, buy products, or bypass account prompts.

Use `switchIntervalMs` for the wait between live-room switches. Clamp very small intervals to avoid unnatural or unstable device behavior.
