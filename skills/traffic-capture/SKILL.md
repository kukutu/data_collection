---
name: traffic-capture
description: Use when implementing, maintaining, or operating task-integrated traffic capture in data_collect_agent, including configurable WLAN/tshark capture, ADB/HDC port mapping logs, HarmonyOS screen recording, extraction, and capture reports.
---

# Traffic Capture

Runtime implementation lives in `server/src/capture/`; task timing lives in the business skills and `server/src/harness.js`.

Capture must begin only after the target business state is reached:

1. Launch or navigate into the target App.
2. Check foreground package and the relevant UI, Activity, media, or screen-motion state.
3. Execute the `start_capture` step.
4. Run the requested bounded business activity.
5. Let the task lifecycle stop and finalize capture on completion, failure, or user stop.

`launch_app` is the exception: it starts capture immediately after App launch because it has no deeper business state.

Capture orchestration:

1. Parse `tshark -D` and match the requested interface name; never hardcode an interface index.
2. Write `traffic.pcapng` under `<root>/<App>/<business>/<session>/`.
3. Start the device-side `netstat -anp` logger with ADB or HDC.
4. Match Android by package name and HarmonyOS by bundle name.
5. Prefer HarmonyOS system screen recording; fall back to screenshots plus FFmpeg.
6. Stop components, pull `port_mapping.txt`, optionally run `GET_PCAP_SCRIPT`, and write `report.md`.

The HTTP API exposes capture configuration and snapshots. Start/stop is task-integrated, not a separate public capture command.

Do not use capture to expand task permissions. The wrapped task must already pass `server/src/safety.js`. Never automate payment, orders, ticket grabbing, login/captcha bypass, likes, follows, comments, or other account-impacting actions.
