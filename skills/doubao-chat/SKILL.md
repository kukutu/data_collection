---
name: doubao-chat
description: Use when implementing or maintaining bounded Doubao chat automation across Android and HarmonyOS, including safe message generation, device-specific input, capture timing, and reply validation.
---

# Doubao Chat

Runtime implementation lives in `server/src/skills/doubao-chat.js`.

Accepted tasks resolve to `intent: "doubao_chat"` with a bounded duration, message interval, English language, and optional message list.

Flow:

1. Resolve Doubao from `data/apps.json`.
2. Launch the App and handle only allowlisted non-sensitive prompts.
3. Confirm the foreground App.
4. Execute `start_capture`.
5. Send short uppercase ASCII tokens and wait for the reply to become stable.

Android uses configured input/send resource ids. HarmonyOS uses scaled input/send coordinates plus HDC hardware key injection because app text input is less reliable there. Harmony key text is limited to ASCII letters and digits without spaces.

Do not add uploads, calls, payments, account changes, social engagement, captcha bypass, ticket/order submission, or unbounded message loops.
