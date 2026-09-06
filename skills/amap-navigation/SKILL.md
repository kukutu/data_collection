---
name: amap-navigation
description: Use when implementing or maintaining bounded AMap route sessions with required destinations, scaled navigation controls, and task-integrated capture.
---

# AMap Navigation

Runtime implementation lives in `server/src/skills/amap-navigation.js`.

Task examples:

- `高德地图导航到北京站5分钟`
- `运行10分钟高德地图导航到上海虹桥站`

The skill requires a destination, opens `androidamap://route`, waits for route calculation, checks non-sensitive prompts, taps the lower primary action area, confirms the foreground App, starts capture, and keeps the navigation session active for the requested duration.

Tap coordinates derive from the current screen dimensions and are scaled by the device controller when replay metadata is present.

An ambiguous destination may leave AMap on candidate results instead of active navigation. Use a specific destination and treat the foreground-package check as weaker evidence than a dedicated navigation-state assertion.

Do not confirm rides, payments, orders, or other transaction flows.
