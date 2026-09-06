# 当前实现方案

本文档描述截至 2026-09-06 的现役实现。用户操作说明以根目录 `README.md` 为准；本文件只解释架构、状态机、数据边界和已知限制。

## 1. 系统边界

系统是本地运行的手机自动化与流量采集控制台：

```text
网页任务或参数化工作流
  -> 规则/API/Codex 解析
  -> 安全策略
  -> 固定业务 skill
  -> ADB/HDC 设备控制
  -> 到达目标业务状态
  -> tshark + 端口映射 + 屏幕录制
  -> 任务收尾、拉取文件、可选提取、报告
```

模型不直接控制 shell 或手机。任务模型只生成受 schema 限制的 intent；轨迹纠正模型只返回动作白名单内的修正结果。

## 2. 技术栈和入口

- Node.js ESM
- Node 原生 `http`
- 静态 HTML/CSS/JavaScript
- ADB 与 HDC
- tshark/Wireshark
- HarmonyOS 系统录屏，失败时截图加 FFmpeg 合成
- OpenAI-compatible Responses API 或本机 Codex CLI

入口：

```text
package.json              npm start / npm test
server/index.js           HTTP 路由和依赖装配
public/index.html         用户界面
server/src/config.js      环境变量和本机工具回退路径
```

服务固定监听 `PORT`，默认 `5177`。端口占用时直接退出，不自动递增。

## 3. 设备抽象

`server/src/device-controller.js` 是业务代码访问设备的唯一统一入口。

选择规则：

1. 优先复用最近成功的 adapter。
2. 初次探测顺序为 ADB、HDC。
3. ADB 不可用时回退 HDC。
4. 任务、录制和回放开始时锁定具体 adapter 和序列号。
5. 锁定期间设备变化会返回错误，不会静默切换到另一台手机。

Adapter：

```text
server/src/adb.js   Android ADB
server/src/hdc.js   HarmonyOS HDC
```

统一能力包括：

- 应用安装列表、前台应用、屏幕尺寸和方向
- 启动/停止应用、Activity/URI、返回/Home
- 点击、长按、滑动
- UI 文本、资源节点和通用节点定位
- 文本与硬件键码输入
- 截图和 UI 动作录制
- 媒体播放和敏感弹窗检查

### 3.1 坐标适配

动作可携带：

- `normalizedX` / `normalizedY`
- `referenceScreen`
- UI target（文本、resource id、节点类型）

执行时优先使用 UI 节点中心；无法定位时按录制分辨率与目标分辨率比例换算坐标，并把结果限制在目标屏幕范围内。滑动起止点使用相同规则。

### 3.2 HarmonyOS 输入

普通文本使用：

```text
hdc shell uitest uiInput text
```

部分仅接受硬件键输入的场景使用 `input_key_text`，当前只支持无空格的 ASCII 字母和数字。豆包 HarmonyOS skill 使用这种方式。

## 4. App 与工作流

`data/apps.json` 是 App 身份来源，包含：

- `id`
- 展示名称和别名
- Android `packageName`
- 可选 HarmonyOS `harmonyBundleName`
- 分类
- runtime skill
- 可选 skill UI 配置

当前配置 51 个 App，其中 24 个有 Harmony bundle 映射。

`server/src/workflow-registry.js` 定义动作录制和快捷任务共用的工作流。当前共 49 个：

| 分类 | 数量 | 说明 |
| --- | ---: | --- |
| VoIP | 10 | 5 个 App，各自拆分音频/视频通话 |
| 会议 | 8 | 快速会议和加入会议 |
| 短视频 | 7 | 时长参数 |
| 直播 | 14 | 时长参数 |
| 传输 | 3 | 微信消息、微信媒体、welink 媒体 |
| 上传下载 | 3 | 目标参数 |
| AI 应用 | 4 | 时长和间隔 |

长视频和导航不在快捷任务目录中，但对应文本 intent 和代码 skill 仍存在。

工作流状态：

```text
pending   未验证，前端灰色
verified  已验证，且 App 安装时可执行
```

`VERIFIED_WORKFLOW_IDS` 是可随 Git 分发的代码验证基线。动作录制回放产生的额外验证状态来自 `data/recordings/`，仅在当前机器生效。

## 5. 任务解析和执行

`TaskManager` 位于 `server/src/harness.js`。

任务状态：

```text
running
waiting_confirmation
completed
blocked
failed
stopped
```

解析模式：

- `rules`：`parseTaskFallback()`
- `api`：Responses API；失败时带错误信息回退规则解析
- `codex`：本机 Codex CLI；失败时带错误信息回退规则解析

现役 intent：

```text
launch_app
watch_feed
watch_live
live_entry
play_tencent_video
play_generic_media
amap_navigation
wechat_channels_feed
wechat_send_messages
wechat_send_media
doubao_chat
ai_chat
back
home
```

`missing_parameter`、`unsupported_flow` 和 `unknown` 不进入执行。

### 5.1 执行动作

Harness 可执行的动作包括：

- App/Activity/URI 启动
- tap/long press/swipe/key event
- UI 文本、节点、Activity、方向和媒体状态断言
- 屏幕变化断言
- 文本输入和微信消息循环
- 人工确认
- `start_capture`
- 完成

每个动作前后检查停止标记。任务结束、失败或停止时都会尝试停止采集并释放设备锁。

### 5.2 人工确认

动态页面无法可靠自动进入时，skill 可以进入 `waiting_confirmation`。用户完成指定手机操作后调用：

```text
POST /api/tasks/:id/continue
```

典型场景是小红书或腾讯视频的内容入口。人工确认不允许绕过安全策略。

## 6. 动作录制

`server/src/action-recorder.js` 管理录制、修复、回放和本地恢复。

录制会话状态主要包括：

```text
starting
recording
stopping
stopped
replaying
replayed
replay_failed
failed
```

模型纠正状态单独记录在 `correctionStatus`，不复用录制会话状态。

流程：

1. 根据工作流参数创建本地会话。
2. 锁定当前设备。
3. 启动 ADB/HDC UI 动作记录。
4. 保存原始动作、时间轴、动作上下文和诊断截图。
5. 结束后解析为可回放轨迹并评估质量。
6. 可选调用模型纠正轨迹。
7. 回放时根据目标屏幕缩放坐标。
8. 全部验证检查通过后写入 `verified`。

覆盖规则：

- 开始同一工作流的新录制时，删除该工作流旧的未验证录制。
- 已验证录制不自动删除。
- 下一次开始前会释放状态已结束但仍残留的会话锁。
- 敏感参数不会明文进入快照和产物。

验证层级：

- 普通工作流：轨迹完成验证。
- 腾讯会议快速会议：专用会议状态检查。
- 微信发图/发视频：专用聊天媒体气泡和发送结果检查。

录制产生：

```text
data/recordings/<App>/<功能>/<时间戳-会话ID>/
  trajectory.json
  skill-draft.json
  skill-corrected.json       可选
  contexts.json
  raw-live.jsonl
  raw-remote.log
  recording-*.png
  replay-*.png
```

目录中可能包含联系人、聊天内容和截图，已被 `.gitignore` 排除。

### 6.1 当前集成边界

录制轨迹由动作录制面板回放。`TaskManager` 尚未把任意录制轨迹作为通用 runtime skill 执行。

因此：

- 工作流“已回放验证”表示录制面板可以复现该轨迹。
- 自由文本和快捷任务执行仍取决于 harness 中已有 intent 和代码 skill。
- 将录制轨迹升级为可分发 runtime skill 需要独立的发布和脱敏流程。

## 7. VoIP 工作流

以下 App 分别有独立的 `audio-call` 和 `video-call`：

- 微信
- QQ
- 钉钉
- 企业微信
- 畅连

命令语义固定为向第一个联系人发起对应类型通话，不提供联系人参数。音频和视频轨迹、验证状态、保存目录互不覆盖。

旧“音视频通话”记录通过 `workflowId` 映射到当前规范名称；新录制写入“音频通话”或“视频通话”目录。

## 8. 同步采集

`server/src/capture/manager.js` 管理一个活动采集会话。

采集不是先于手机业务操作统一启动。Skill 在目标页面或业务状态检查之后放置 `start_capture`：

```text
进入 App/业务页
  -> 前台 App、UI、Activity、媒体或画面变化检查
  -> start_capture
  -> 正式持续操作
```

`launch_app` 这种无后续业务状态的任务在应用启动后立即开始采集。

### 8.1 采集组件

1. 解析 `tshark -D`，按用户输入的接口名匹配真实接口。
2. 启动 tshark，写入 `traffic.pcapng`。
3. 通过 ADB/HDC 启动端侧 `netstat -anp` 采样。
4. HDC 使用 Harmony bundle 匹配；ADB 使用 package 名称。
5. HarmonyOS 优先启动系统录屏。
6. 系统录屏失败或使用 ADB 时，定时截图并用 FFmpeg 合成。
7. 任务结束后停止组件并拉取 `port_mapping.txt`。
8. 配置提取脚本时运行 Python 提取。
9. 始终尝试写 `report.md`。

输出目录：

```text
<outputRoot>/<App>/<业务>/<YYYYMMDD_HH-mm-ss-ID>/
  traffic.pcapng
  port_mapping.txt
  screen_record.mp4
  extracted/
  report.md
```

默认配置：

```text
interfaceName = WLAN3
outputRoot = <项目>\data_collect
screenFps = 1
portMappingIntervalSec = 0.5
```

当前 HTTP API 只暴露采集默认值和会话查询；开始与停止由任务生命周期驱动：

```text
GET /api/capture/config
GET /api/captures/:id
```

## 9. 前端

`public/index.html` 和 `public/app.js` 提供：

- 任务文本与三种解析模式
- 采集接口、手机 IP、保存目录、录屏、端口映射和提取脚本
- 参数化快捷任务
- 任务日志、停止和人工继续
- 采集状态与输出路径
- 动作录制、参数、模型纠正和回放

前端从 `/api/apps` 和 `/api/workflows` 动态构造目录，不维护第二份 App/工作流清单。静态资源和 API 都返回 `Cache-Control: no-store`。

## 10. 安全

`server/src/safety.js` 是所有文本任务的执行门。

明确禁止：

- 支付、订单、购买、票务和红包
- 叫车确认
- 评论、私信、关注、点赞和打赏
- 验证码、人机验证和风控绕过

微信传输只允许第一个会话。AI 对话只允许受限英文短消息。未实现的会议、VoIP、上传下载等文本流程会返回 `unsupported_flow`。

## 11. 配置与数据边界

配置来源为环境变量和 `server/src/config.js`。本机工具绝对路径只作为存在性检测后的 Windows 回退，不是跨机器合同。

Git 跟踪：

- 源码、测试、文档、App 和工作流配置

Git 忽略：

- `data/recordings/`
- `data_collect/`
- `data/*.png`
- `*.log`
- `.env`

`App流识别_列表.xlsx` 是受控参考数据。除非用户明确要求，不编辑、覆盖、暂存或提交。

## 12. API

现役路由：

```text
GET  /api/device
GET  /api/apps
GET  /api/workflows
POST /api/tasks
GET  /api/tasks/current
GET  /api/tasks/:id
POST /api/tasks/:id/stop
POST /api/tasks/:id/continue
GET  /api/recordings
POST /api/recordings/start
GET  /api/recordings/:id
POST /api/recordings/:id/stop
POST /api/recordings/:id/repair
POST /api/recordings/:id/replay
GET  /api/capture/config
GET  /api/captures/:id
GET  /api/screenshot.png
```

## 13. 验证门禁

代码和文档同步后至少运行：

```powershell
npm test
node --check public\app.js
node --check server\index.js
```

服务 smoke：

```text
GET http://localhost:5177/
GET http://localhost:5177/app.js
GET http://localhost:5177/api/workflows
GET http://localhost:5177/api/device
```

静态页面和 API 应返回 `Cache-Control: no-store`。设备相关的真实操作、系统录屏和抓包 smoke test 必须在目标手机连接时执行；设备断开时保持 pending，不能由单元测试替代。

## 14. 已知限制

- 本地录制验证状态不随 Git 分发。
- 任意录制轨迹尚未接入通用任务执行。
- 只有腾讯会议快速会议和微信媒体发送有专用严格回放验证。
- 许多工作流仅有参数槽位，仍为 pending。
- ADB 录屏使用截图合成回退，不是 Android 系统 `screenrecord`。
- HDC UI 结构和坐标仍受 App 版本、权限弹窗和设备布局影响。
