---
name: traffic-capture
description: Use when implementing, maintaining, or operating the traffic capture orchestration in data_collect_agent, including configurable WLAN/tshark capture, adb/hdc device-side port mapping logs, get_pcap.py extraction, and capture report generation.
---

# Traffic Capture

Keep the skill folder as repo-level guidance for the runtime implementation in `server/src/capture/`.

Use this skill to coordinate traffic collection around an already allowed phone automation task:

1. Detect the tshark interface by parsing `tshark -D`; use the requested interface name or `CAPTURE_INTERFACE_NAME` instead of hardcoding an index.
2. Start tshark capture on the matched interface and write the raw pcap to a session output directory.
3. Start the device-side port mapping logger with adb or hdc for the user-specified app package.
4. Run the allowed app skill while capture is active.
5. Stop capture and device logging.
6. Pull the port mapping file back to the session directory; default remote path is configurable with `PORT_MAPPING_REMOTE_FILE`.
7. Run the parameterized `get_pcap.py` extractor against the raw pcap and port mapping file; provide the script path through `GET_PCAP_SCRIPT` or an explicit option.
8. Write a capture report with timestamps, commands, files, and any extraction errors.

Do not use traffic capture to automate payments, orders, ticket grabbing, login bypass, captcha bypass, uploads, or other high-risk workflows. Capture orchestration must wrap only tasks that already pass `server/src/safety.js`.
