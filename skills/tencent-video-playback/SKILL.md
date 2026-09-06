---
name: tencent-video-playback
description: Use when implementing or maintaining bounded Tencent Video playback with manual content selection, playback-state validation, and task-integrated capture.
---

# Tencent Video Playback

Runtime implementation lives in `server/src/skills/tencent-video.js`.

Task examples:

- `看10分钟腾讯视频`
- `播放20秒腾讯视频`

Current flow:

1. Clear stale prompts and reset Tencent Video.
2. Launch the App.
3. Ask the user to open the target video and enter landscape full-screen playback.
4. Verify landscape orientation, foreground package, and media playback state.
5. Execute `start_capture`.
6. Keep the playback session active for the requested duration.

Successful execution requires a real playing media session, not merely the App home page. The user handoff is intentional because the content page is dynamic.

Do not automate subscriptions, purchases, comments, likes, or other account-impacting actions.
