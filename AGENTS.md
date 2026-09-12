# Project Instructions

## Environment

On Windows, run these commands before other shell work:

```powershell
[Console]::InputEncoding  = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
chcp 65001 > $null
```

## Purpose And Stack

- This is a local phone automation and traffic-capture console for Android and HarmonyOS.
- The runtime is Node.js ESM with a native `http` server and static HTML/CSS/JS.
- Device access goes through `server/src/device-controller.js`, which selects ADB or HDC.

## Run And Verify

- Start: `npm start`
- URL: `http://localhost:5177`
- The server must fail if port `5177` is occupied; do not silently move to another port.
- Tests: `npm test`
- Syntax checks: `node --check public/app.js` and `node --check server/index.js`

## Structure And Conventions

- `data/apps.json`: app identity, aliases, Android package, Harmony bundle, runtime skill.
- `server/src/workflow-registry.js`: recording/shortcut workflow catalog and parameters.
- `server/src/harness.js`: task lifecycle, safety gate, skill dispatch, capture timing.
- `server/src/action-recorder.js`: record, repair, replay, validation, and local persistence.
- `server/src/capture/`: tshark, device port logs, screen recording, extraction, reports.
- `server/src/skills/`: executable business logic; prefer existing device-controller methods.
- Coordinates must carry normalized values or a `referenceScreen` so other resolutions scale.
- Start capture only after the target app/business state has been reached and checked.
- A workflow may become verified after the agent successfully tests its business flow on a real device, or after successful recorded replay; task completion alone without business-state validation is insufficient.
- VoIP workflows are separate `audio-call` and `video-call` entries and use the first contact.

## Safety And Local Data

- Never automate payment, ordering, ticket grabbing, captcha bypass, likes, follows, or comments.
- Do not commit API keys, recordings, screenshots, PCAP files, port logs, or chat contexts.
- `data/recordings/`, `data_collect/`, `data/*.png`, and logs are local runtime artifacts.
- Do not edit, overwrite, stage, or commit `App流识别_列表.xlsx` unless the user explicitly asks.
- Local recording verification is machine-local because recording artifacts are gitignored.

## Current Boundary

- Quick-task categories come from the workflow registry; long video and navigation stay hidden there.
- Free-text parsing still supports implemented long-video and AMap skills.
- Recorded trajectories replay from the recording panel; they are not generic TaskManager skills.
- New app/workflow functions remain gray until real-device business-flow testing or recorded replay succeeds. The agent may then enable the shortcut without requiring the user to record it first.
