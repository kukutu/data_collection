# tencent-video-playback

Use this skill for Tencent Video playback sessions.

## Task Shape

- `看10分钟腾讯视频`
- `播放20秒腾讯视频`

## Behavior

The skill:

- closes possible leftover jump prompts
- resets Tencent Video state
- opens Tencent Video
- taps into the ranking/content page
- taps the first ranked video
- taps the player area
- keeps the playback/detail session active for the requested duration

Successful execution means the foreground package is `com.tencent.qqlive` and the activity reaches Tencent Video's video detail/player activity, not just the home page.

## Limits

This skill uses coordinate heuristics because Tencent Video's homepage is dynamic. If the layout changes, retune the tap coordinates in `server/src/skills/tencent-video.js`.
