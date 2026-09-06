# 手机自动化与流量采集控制台

这是一个本地运行的手机自动化控制台。用户可以在网页输入文本任务或选择快捷工作流，后端完成任务解析、安全检查、ADB/HDC 设备控制，并在业务页面就绪后同步采集网络流量、端口映射和屏幕录像。

## 当前能力

- Android ADB 与 HarmonyOS HDC 双设备适配
- 本地规则、OpenAI-compatible API、本机 Codex 三种任务解析模式
- 参数化快捷任务，未验证功能保持灰色
- 动作录制、轨迹质量诊断、模型纠正和回放验证
- Wireshark/tshark 抓包、端侧端口映射、系统录屏和报告输出
- 跨分辨率坐标缩放及 UI 节点优先定位
- 任务、录制和回放共用设备锁，避免并发操作同一设备

## 前置条件

- Windows
- Node.js 22 或兼容版本
- 至少一种设备工具：
  - Android：`adb`，或通过 `ADB_PATH` 指定
  - HarmonyOS：`hdc`，或通过 `HDC_PATH` 指定
- 手机已开启开发者模式、USB 调试并授权当前电脑
- 采集功能需要 Wireshark/tshark
- 截图回退录屏需要 FFmpeg
- 可选：流量提取脚本及 Python
- 可选：本机 Codex 登录状态或 OpenAI-compatible API Key

本机存在下列路径时会自动使用，否则回退到 PATH：

```text
F:\hdc\windows\toolchains\hdc.exe
F:\wireshark\tshark.exe
F:\ffmpeg\ffmpeg-2025-12-18-git-78c75d546a-full_build\bin\ffmpeg.exe
```

## 启动

```powershell
npm start
```

访问：

```text
http://localhost:5177
```

端口 `5177` 被占用时服务会直接报错退出，避免浏览器误连旧版本。先停止旧服务再重新启动。

## 设备检查

Android：

```powershell
adb devices
```

HarmonyOS：

```powershell
hdc list targets -v
```

设备控制器初次选择时优先 ADB，ADB 不可用时使用 HDC；任务开始后会锁定当前设备和 transport，直到任务、录制或回放结束。

## 页面使用

1. 启动服务并打开网页。
2. 确认顶部显示已连接的 ADB 或 HDC 设备。
3. 选择解析模式：
   - `本地规则`：固定任务，不需要 Key。
   - `API 模型`：前端填写 API Key，通过 Responses API 解析。
   - `本机 Codex`：使用本机 Codex CLI 和配置。
4. 输入任务，或从快捷任务选择 App、功能和参数。
5. 按需配置同步采集，然后点击“开始”。
6. 在右侧查看任务、采集、人工确认和错误状态。

## 快捷任务与验证状态

快捷任务由 `server/src/workflow-registry.js` 定义，目前包含 49 个工作流：

- VoIP
- 会议
- 短视频
- 直播
- 传输
- 上传下载
- AI 应用

长视频和导航暂不显示在快捷任务区，但已实现的腾讯视频、通用媒体播放和高德导航仍可通过文本任务调用。

快捷任务只有同时满足以下条件才可直接执行：

- 当前设备已安装对应 App
- 工作流状态为 `verified`

代码内置的验证基线包括抖音短视频、微信视频号、微信直播、微信发消息和豆包聊天。本机动作录制成功回放后也会产生本地验证状态。

`data/recordings/` 包含屏幕内容和操作上下文，默认不提交 Git。因此动作录制产生的额外验证状态只在当前机器生效；迁移到新机器时需要重新录制回放，或将稳定逻辑正式固化为代码 skill。

## 动作录制

动作录制区与快捷任务使用同一份工作流和参数定义。

基本流程：

1. 选择 App、功能和参数。
2. 点击“开始录制”，在手机上完成目标操作。
3. 点击“结束录制”，生成轨迹、时间轴和质量诊断。
4. 必要时使用“模型纠正”修复轨迹。
5. 点击“回放测试”；只有成功回放才会标记为 `verified`。

录制规则：

- 同一功能的新录制会替换旧的未验证录制。
- 已成功验证的录制不会被新录制自动删除。
- 结束录制完成前不会提前释放开始按钮。
- 遗留的已结束会话锁会在下一次录制前自动释放。
- 敏感参数写入录制元数据时会被隐藏。
- 普通工作流当前验证“轨迹完整执行”；腾讯会议快速会议和微信媒体发送有额外业务状态检查。

VoIP 工作流已拆分为独立类型：

- 微信、QQ、钉钉、企业微信、畅连的音频通话
- 微信、QQ、钉钉、企业微信、畅连的视频通话

两类通话默认选择第一个联系人，不提供联系人参数，在各自回放验证前保持灰色。

## 同步采集

采集由任务 harness 管理，不是独立的手工开始/停止流程。多数业务 skill 会先进入目标业务页面并完成状态检查，再执行 `start_capture`；单纯“打开 App”任务会在 App 启动后开始采集。

采集内容：

- `traffic.pcapng`：指定 WLAN 接口的 tshark 流量
- `port_mapping.txt`：手机端 TCP/UDP 端口映射
- `screen_record.mp4`：任务期间屏幕录像
- `extracted/`：可选提取脚本输出
- `report.md`：时间、组件状态、文件和错误摘要

输出结构：

```text
<保存目录>/<App>/<业务>/<时间戳-会话ID>/
```

HarmonyOS 优先调用系统录屏；启动失败时回退为定时截图并通过 FFmpeg 合成视频。ADB 当前直接使用截图回退方案。HDC 端口日志按 Harmony bundle 名称匹配，ADB 按 Android package 名称匹配。

前端默认：

```text
网卡: WLAN3
保存目录: D:\andorid_adb\data_collect
系统屏幕录制: 开启
端口映射: 开启
```

## 文本任务示例

```text
刷30分钟抖音
看5分钟微信视频号
看10分钟腾讯视频
高德地图导航到北京站5分钟
和豆包聊天5分钟
循环发送微信测试消息5分钟
向微信第一个会话发送第一项图片或视频3次
返回
回到桌面
```

微信发消息、发图和发视频均固定使用聊天列表中的第一个会话。媒体发送固定选择媒体列表中的第一项，可按次数或持续时间循环。

## 安全边界

系统不会自动执行：

- 支付、付款、支付密码或扫码支付
- 下单、提交订单、购票、抢票、抢单或抢红包
- 自动叫车确认
- 评论、私信、关注、点赞或打赏
- 验证码、人机验证或绕过风控

模型只负责把文本解析为受限 JSON，不能直接输出任意 shell、ADB/HDC 命令。所有任务还必须经过 `server/src/safety.js`，最终动作由固定 skill 和设备适配器执行。

## 配置

主要环境变量：

| 变量 | 默认值或作用 |
| --- | --- |
| `PORT` | `5177` |
| `ADB_PATH` | `adb` |
| `HDC_PATH` | 自动探测本机路径，否则 `hdc` |
| `HDC_SERIAL` | 指定 HDC 设备序列号 |
| `OPENAI_BASE_URL` | `https://api.codexzh.com/v1` |
| `OPENAI_MODEL` | `gpt-5.5` |
| `CODEX_CLI_PATH` | Codex CLI 路径 |
| `CODEX_HOME_PATH` | Codex 配置目录 |
| `CODEX_MODEL` | 本机 Codex 模型覆盖 |
| `CODEX_TIMEOUT_MS` | 默认 `120000` |
| `CAPTURE_INTERFACE_NAME` | `WLAN3` |
| `CAPTURE_SESSIONS_ROOT` | `<项目>\data_collect` |
| `TSHARK_PATH` | tshark 路径 |
| `FFMPEG_PATH` | FFmpeg 路径 |
| `CAPTURE_SCREEN_FPS` | 截图回退录屏帧率，默认 `1` |
| `CAPTURE_PORT_MAPPING_INTERVAL_SEC` | 端口采样间隔，默认 `0.5` |
| `PORT_MAPPING_REMOTE_FILE` | `/data/local/tmp/port_mapping.txt` |
| `GET_PCAP_SCRIPT` | 可选流量提取脚本 |
| `RECORDINGS_ROOT` | `<项目>\data\recordings` |

## API

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/device` | 当前设备、transport、屏幕和前台 App |
| `GET` | `/api/apps` | App 配置及安装状态 |
| `GET` | `/api/workflows` | 快捷任务、参数、安装和验证状态 |
| `POST` | `/api/tasks` | 创建任务 |
| `GET` | `/api/tasks/current` | 当前或最近任务 |
| `GET` | `/api/tasks/:id` | 任务快照 |
| `POST` | `/api/tasks/:id/stop` | 停止任务 |
| `POST` | `/api/tasks/:id/continue` | 继续人工确认后的任务 |
| `GET` | `/api/recordings` | 录制列表 |
| `POST` | `/api/recordings/start` | 开始动作录制 |
| `POST` | `/api/recordings/:id/stop` | 结束动作录制 |
| `POST` | `/api/recordings/:id/repair` | 模型纠正 |
| `POST` | `/api/recordings/:id/replay` | 回放验证 |
| `GET` | `/api/recordings/:id` | 录制快照 |
| `GET` | `/api/capture/config` | 前端采集默认值 |
| `GET` | `/api/captures/:id` | 采集会话快照 |
| `GET` | `/api/screenshot.png` | 当前手机截图 |

## 项目结构

```text
public/                              前端页面、样式和交互
server/index.js                      HTTP API 和静态资源服务
server/src/device-controller.js      ADB/HDC 选择、设备锁、坐标缩放
server/src/adb.js                    Android ADB 适配
server/src/hdc.js                    HarmonyOS HDC 适配
server/src/harness.js                任务解析、调度、执行和采集时机
server/src/action-recorder.js        动作录制、修复、回放和验证
server/src/workflow-registry.js      快捷任务和录制参数定义
server/src/capture/                  抓包、端口日志、录屏、提取、报告
server/src/skills/                   固定业务 skill
data/apps.json                       App 身份、包名、bundle 和 skill 映射
data/recordings/                     本地录制产物，不提交
data_collect/                        本地采集产物，不提交
tests/                               Node 单元和集成级测试
docs/current-implementation-scheme.md 现役架构与边界
skills/                              repo 级运行维护说明
AGENTS.md                            后续 Agent 的项目约束
```

## 测试

```powershell
npm test
node --check public\app.js
node --check server\index.js
```

测试覆盖任务解析、安全策略、设备选择和锁、分辨率缩放、HDC UI 操作、动作录制、严格回放验证、HarmonyOS 系统录屏、抓包编排、微信传输和主要媒体 skill。

## 当前限制

- 动作录制产物包含屏幕和 UI 上下文，只保存在本机且不进入 Git。
- 录制轨迹目前从动作录制面板回放，尚未成为所有快捷任务可直接调用的通用 runtime skill。
- 腾讯会议快速会议和微信媒体发送有专用严格验证；其他录制主要验证轨迹是否完整执行。
- 部分 App 只有工作流槽位或启动能力，仍需逐项录制和回放后开放。
- 设备相关 smoke test 必须在目标手机重新连接后执行。
