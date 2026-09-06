---
name: short-video
description: Use when implementing, maintaining, or operating bounded short-video feed browsing in data_collect_agent, including App-specific entry, validation, capture timing, and swipe-only progression.
---

# Short Video

Runtime implementation lives in `server/src/skills/short-video.js`; WeChat video channels use `server/src/skills/wechat-channels.js`.

For commands such as `刷30分钟抖音`:

1. Resolve the App from `data/apps.json`.
2. Launch or reach the video content.
3. Handle only allowlisted non-sensitive prompts.
4. Confirm foreground App and, where available, screen motion.
5. Execute `start_capture`.
6. Alternate bounded waits and upward swipes until the requested duration ends.

Xiaohongshu currently uses manual confirmation to enter a video or note detail before capture. Douyin uses a fast launch path. Other apps use the generic entry checks.

Coordinates must derive from the current screen size or carry a `referenceScreen`; do not add raw device-specific coordinates without scaling metadata.

Do not like, follow, comment, share, buy, upload, log in, or interact with creators beyond passive feed scrolling.
