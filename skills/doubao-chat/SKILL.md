---
name: doubao-chat
description: Use when implementing, maintaining, or operating the Doubao chat automation in data_collect_agent, including parsing doubao_chat tasks, resolving app package/resource configuration from data/apps.json, generating ADB/uiautomator steps, and validating bounded English-only message loops.
---

# Doubao Chat

Keep this skill folder as repo-level guidance for the runtime implementation in `server/src/skills/doubao-chat.js`.

Use `doubao_chat` only for bounded English short-message conversations with 豆包. Resolve the app package and UI resource ids from `data/apps.json`; reject the task if app resolution does not point to a `doubao_chat` app.

Runtime flow:

1. Parse tasks such as `和豆包随机聊天十分钟` into `intent: "doubao_chat"`, `appName: "豆包"`, `durationMs`, `intervalMs`, `language: "en"`, and `random: true` when requested.
2. Let `server/src/harness.js` route `doubao_chat` to `buildDoubaoChatPlan`.
3. Generate only these step types: `launch_app`, `wait`, `tap_resource`, `input_text`, and `complete`.
4. Locate UI controls by resource id from `app.skillConfig.resources`, not by fixed coordinates. Required keys are `input` and `send`; `closeButton` is optional.
5. Send short ASCII English messages because `adb shell input text` is unreliable for Chinese and rich punctuation.

Do not add uploads, calls, payments, account changes, social engagement, captcha bypass, ticket/order submission, or other high-risk actions to this skill.
