---
name: short-video
description: Use when implementing, maintaining, or operating passive short-video feed browsing skills in data_collect_agent, including Douyin, Xiaohongshu, Kuaishou, Bilibili-style feeds, bounded watch durations, and swipe-only feed progression.
---

# Short Video

Keep the skill folder as repo-level guidance for the runtime implementation in `server/src/skills/short-video.js`.

Use this skill for passive browsing commands such as `刷30分钟抖音` or `浏览10分钟小红书`. The runtime should resolve the app from `data/apps.json`, launch the package, wait for loading, then alternate bounded waits with upward swipes until the requested duration is reached.

Generate only passive actions: `launch_app`, `wait`, `swipe`, and `complete`. Do not tap like, follow, comment, share, buy, upload, login, or interact with creators or recommendations beyond normal feed scrolling.

Derive swipe coordinates from the current screen size when possible. Use the fallback screen size only when ADB cannot report dimensions.
