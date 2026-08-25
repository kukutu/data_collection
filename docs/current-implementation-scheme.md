# 当前实现方案说明

本文档整理当前手机自动操作控制台的实现方式、模块职责、执行链路、prompt 与 skill 的分工、安全边界，以及接入流量采集 agent 的方案。

## 1. 目标定位

当前系统是一个本地 Web 控制台，用来把用户输入的文本任务转换为受控的 Android ADB 操作。

典型任务包括：

- 打开指定 App，例如“打开抖音”“打开小红书”。
- 被动浏览短视频，例如“刷 10 分钟抖音”。
- 在已进入直播间的前提下，定时上滑切换直播间。
- 返回、回到桌面、查询设备状态、查看执行日志。

系统不是让模型直接控制终端，而是采用：

```text
前端输入任务
  -> 后端解析 intent
  -> 安全策略检查
  -> 选择固定 skill
  -> skill 生成动作序列
  -> ADB allowlist 执行
  -> 前端轮询日志和状态
```

## 2. 技术栈

当前实现尽量保持轻量，没有引入 Express、Vite、React 等依赖。

- 运行时：Node.js ESM
- 后端：Node 原生 `http` 服务
- 前端：静态 HTML/CSS/JS
- 手机控制：ADB
- 模型调用：`fetch` 调用 `OPENAI_BASE_URL` 下的 `/responses`
- 应用配置：`data/apps.json`
- 运行配置：`server/src/config.js`

启动方式：

```powershell
npm start
```

默认监听：

```text
http://localhost:5177
```

如果端口占用，后端会尝试递增端口。

## 3. 目录结构

核心文件如下：

```text
package.json
data/apps.json
public/index.html
public/app.js
public/styles.css
server/index.js
server/src/adb.js
server/src/app-registry.js
server/src/config.js
server/src/harness.js
server/src/llm.js
server/src/safety.js
server/src/task-parser.js
server/src/skills/short-video.js
server/src/skills/live-stream.js
server/src/skills/doubao-chat.js
server/src/capture/*.js
skills/*/SKILL.md
```

模块职责：

| 文件 | 职责 |
|---|---|
| `server/index.js` | HTTP API、静态资源服务、任务入口 |
| `server/src/harness.js` | 任务生命周期管理，串联解析、安全检查、skill、ADB 执行 |
| `server/src/task-parser.js` | 无模型时的规则解析 |
| `server/src/llm.js` | 可选模型解析，把自然语言转成 JSON |
| `server/src/safety.js` | 安全策略，拦截高风险任务 |
| `server/src/adb.js` | ADB 操作封装 |
| `server/src/app-registry.js` | 加载应用表、按名称/别名匹配 App |
| `server/src/config.js` | 集中读取环境变量和默认值 |
| `server/src/skills/short-video.js` | 短视频浏览 skill |
| `server/src/skills/live-stream.js` | 直播间被动观看/切换 skill |
| `server/src/skills/doubao-chat.js` | 豆包英文聊天 skill |
| `server/src/capture/*.js` | 抓包、端侧端口日志、提取和报告模块 |
| `public/app.js` | 前端提交任务、轮询日志、刷新设备状态 |
| `data/apps.json` | App 名称、别名、包名、分类、skill 映射 |

## 4. 前端实现

前端是静态页面，由后端直接托管。

当前页面包含：

- API Key 输入框
- 任务文本框
- 是否使用模型解析的开关
- 开始按钮
- 停止按钮
- 设备状态
- 当前任务状态
- 执行日志

前端主要逻辑在 `public/app.js`：

```text
submit 表单
  -> POST /api/tasks
  -> 保存 taskId
  -> 每秒 GET /api/tasks/:id
  -> 渲染任务状态和日志
  -> 任务结束后停止轮询
```

停止任务：

```text
POST /api/tasks/:id/stop
```

设备状态刷新：

```text
GET /api/device
```

页面之前有应用列表显示，当前已经从前端移除。后端 `/api/apps` 仍保留，后续可以给调试面板或配置页使用。

## 5. 后端 API

后端入口是 `server/index.js`。

当前 API：

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/device` | 查询 ADB 设备、型号、前台应用、屏幕尺寸 |
| `GET` | `/api/apps` | 返回配置应用，并标记是否已安装 |
| `POST` | `/api/tasks` | 创建并启动任务 |
| `GET` | `/api/tasks/:id` | 查询任务快照 |
| `POST` | `/api/tasks/:id/stop` | 请求停止任务 |
| `GET` | `/api/screenshot.png` | 获取手机截图 |
| `GET` | `/` | 返回前端页面 |

任务创建请求示例：

```json
{
  "taskText": "刷10分钟抖音",
  "apiKey": "sk-...",
  "useModel": true
}
```

任务快照示例：

```json
{
  "id": "uuid",
  "input": "刷10分钟抖音",
  "status": "running",
  "parsed": {
    "intent": "watch_feed",
    "appName": "抖音",
    "durationMs": 600000
  },
  "stepIndex": 3,
  "totalSteps": 40,
  "logs": []
}
```

## 6. Harness 执行链路

核心类是 `TaskManager`，位于 `server/src/harness.js`。

任务生命周期：

```text
start()
  -> 创建 task 对象
  -> 异步 #run()
  -> 返回初始 snapshot

#run()
  -> #parse()
  -> evaluateSafety()
  -> #execute()
  -> completed / blocked / failed / stopped
```

任务对象核心字段：

| 字段 | 含义 |
|---|---|
| `id` | 任务 UUID |
| `input` | 用户原始输入 |
| `status` | `running` / `completed` / `failed` / `blocked` / `stopped` |
| `parsed` | 解析后的结构化任务 |
| `stepIndex` | 当前执行到第几步 |
| `totalSteps` | 总步骤数 |
| `logs` | 执行日志 |
| `stopped` | 停止标记 |

停止机制：

```text
stop(taskId)
  -> task.stopped = true
  -> skill 执行 wait/swipe 前后检查 stopped
  -> 抛出 TaskStoppedError
  -> 状态变为 stopped
```

目前 harness 支持的 intent：

```text
launch_app
watch_feed
watch_live
back
home
```

## 7. Prompt 与 Skill 的分工

当前系统不是“模型直接控制手机”，而是“模型只做任务解析”。

### 7.1 模型负责什么

模型输入是用户任务和应用列表。

模型输出必须是 JSON，例如：

```json
{
  "intent": "watch_feed",
  "appName": "抖音",
  "durationMs": 600000
}
```

或：

```json
{
  "intent": "watch_live",
  "appName": "抖音",
  "durationMs": 600000,
  "switchIntervalMs": 60000,
  "requiresCurrentLiveRoom": true
}
```

模型禁止输出：

- shell 命令
- adb 命令
- 坐标点击
- 自由文本执行计划

### 7.2 Skill 负责什么

Skill 是后端固定代码，负责把结构化任务变成动作序列。

例如短视频 skill：

```text
launch_app
wait
swipe
wait
swipe
complete
```

模型只决定“做什么”，skill 决定“怎么安全地做”。

这种结构的好处：

- 模型不能直接执行危险命令。
- ADB 能力被限定在后端 allowlist。
- 每类 App 可以逐步沉淀可复用的 skill。
- 可以为不同业务流建立不同安全策略。

## 8. 规则解析 fallback

如果前端没有勾选“使用模型解析”，或者模型调用失败，后端会走 `parseTaskFallback()`。

fallback 主要支持：

- 返回
- 回到桌面
- 打开 App
- 刷短视频
- 观看直播并定时切换
- 时长解析
- 直播切换间隔解析

fallback 解析能力有限，适合固定格式命令，例如：

```text
打开抖音
刷30秒抖音
刷10分钟小红书
观看抖音直播10分钟每1分钟切换
返回
回到桌面
```

复杂自然语言建议走模型解析。

## 9. ADB 执行层

ADB 封装在 `server/src/adb.js`。

当前支持：

| 方法 | ADB 能力 |
|---|---|
| `listDevices()` | `adb devices` |
| `getDeviceStatus()` | 设备、型号、前台 App、屏幕尺寸 |
| `getInstalledPackages()` | `pm list packages` |
| `getCurrentFocus()` | `dumpsys window` |
| `getScreenSize()` | `wm size` |
| `launchPackage()` | `monkey -p package` |
| `keyevent()` | 返回、Home 等按键 |
| `swipe()` | 滑动 |
| `tap()` | 点击 |
| `screenshotPng()` | 截图 |

虽然 `tap()` 已封装，但当前 skill 主要使用 `launch_app`、`wait`、`swipe`、`keyevent`。危险的随机点击、表单提交、支付等没有开放给模型。

## 10. App Registry

应用配置在 `data/apps.json`。

每个 App 包含：

```json
{
  "id": "douyin",
  "name": "抖音",
  "aliases": ["抖音", "抖音短视频", "抖音直播"],
  "packageName": "com.ss.android.ugc.aweme",
  "categories": ["短视频", "直播"],
  "skill": "short_video_feed"
}
```

匹配逻辑：

```text
用户输入 / 模型输出 appName
  -> findAppByName()
  -> 按 name 和 aliases 匹配
  -> 返回 packageName 和 skill
```

`/api/apps` 会结合 `adb shell pm list packages` 标记应用是否已安装。

## 11. 已实现 Skill

### 11.1 short_video_feed

文件：

```text
server/src/skills/short-video.js
```

用途：

```text
刷抖音
刷小红书
刷 B 站短视频
```

动作策略：

```text
1. 打开 App
2. 等待加载
3. 按屏幕高度计算上滑坐标
4. 观看 5、7、9、11、13 秒循环
5. 上滑下一条
6. 到达时长后 complete
```

安全限制：

- 不点赞
- 不关注
- 不评论
- 不私信
- 不点击广告或商品
- 不进入支付/下单流程

### 11.2 live-stream

文件：

```text
server/src/skills/live-stream.js
```

用途：

```text
在用户已经手动进入直播间后，被动观看并定时上滑切换直播间
```

设计约束：

- 不自动搜索直播间。
- 不自动进入直播间。
- 不打赏。
- 不发评论。
- 不关注主播。
- 不点击购物车。

`harness` 会检查当前前台包名。如果当前前台 App 不是目标 App，会拒绝执行并提示先手动进入直播间。

动作策略：

```text
wait switchIntervalMs
swipe
wait switchIntervalMs
swipe
complete
```

## 12. 安全策略

安全策略在 `server/src/safety.js`。

当前拦截关键词包括：

```text
付款
支付
下单
抢票
抢单
抢红包
评论
私信
关注
点赞
打赏
验证码
人机验证
绕过
```

当前允许的 intent：

```text
launch_app
watch_feed
watch_live
back
home
```

策略原则：

- 被动浏览可以自动化。
- 影响他人、影响账号、涉及交易、绕过风控的动作不自动化。
- 模型输出必须经过安全检查。
- skill 内部不做高风险点击。

## 13. 当前已验证能力

根据已有验证记录，已经确认：

- ADB 可识别 Android 手机。
- 可打开小红书。
- 可打开抖音。
- 可执行短视频上滑浏览。
- 可停止运行中的任务。
- 高风险任务会被拦截。
- 手机可连接电脑热点，落在 `192.168.137.0/24`。
- 指定 WLAN 接口可用 `tshark` 抓到手机流量。
- 豆包英文聊天已经固化为 `doubao_chat` runtime skill。

## 14. 与流量采集 Agent 的关系

当前系统已经能完成“操作手机”的部分。要成为完整的流量采集 agent，需要增加采集编排层。

目标链路：

```text
用户输入采集任务
  -> 解析 App 和业务流
  -> 检查手机是否连到电脑热点
  -> 启动指定 WLAN 接口抓包
  -> 启动端侧端口映射记录
  -> 执行 App skill
  -> 停止端侧记录
  -> 拉回 port_mapping.txt
  -> 停止抓包
  -> 调用 get_pcap.py 提取应用流量
  -> 输出 pcap 和采集报告
```

电脑侧抓包建议使用：

```text
tshark / dumpcap
接口名通过请求参数或 CAPTURE_INTERFACE_NAME 指定
不要硬编码 -i 4 或 -i 5
```

端侧鸿蒙方案：

```sh
LOG_FILE="$PORT_MAPPING_REMOTE_FILE"
echo "TIME, PROTO, LOCAL_IP, REMOTE_IP, STATE, PID_PROGRAM" > $LOG_FILE

while true; do
  CURRENT_TIME=$(date +%H:%M:%S)
  netstat -anp 2>/dev/null | grep "目标包名" | while read line; do
    echo "$CURRENT_TIME $line" >> $LOG_FILE
  done
  sleep 0.5
done
```

Android 上 `netstat -anp` 通常不会稳定输出 `PID/包名`，因此只能用于模拟热点和抓包链路，无法完全验证鸿蒙端口映射能力。

## 15. 采集编排模块

已新增：

```text
server/src/capture/
  interface.js       # 动态发现 WLAN / NPF GUID
  tshark.js          # 启停抓包进程
  device-log.js      # hdc/adb 端侧 netstat 记录
  extractor.js       # 调用 GET_PCAP_SCRIPT 指定的 get_pcap.py
  manager.js         # 采集会话状态机
  report.js          # 采集报告输出
```

待接入 API：

```text
POST /api/capture/start
POST /api/capture/stop
GET  /api/capture/:id
POST /api/capture/:id/mark
```

采集任务状态：

```text
idle
checking_device
checking_hotspot
capturing
running_skill
pulling_logs
extracting
completed
failed
stopped
```

## 16. 高风险业务的处理方式

对于支付、抢票、抢单、抢红包等业务，系统不应自动完成关键动作。

推荐实现人工确认采集模式：

```text
1. Agent 打开目标 App
2. Agent 启动抓包和端侧记录
3. 用户手动操作到关键按钮前
4. 用户在前端点击“标记关键时刻”
5. 用户手动点击 App 中的关键按钮
6. Agent 截取标记前后时间窗口流量
7. Agent 停止抓包并提取 pcap
```

比如 12306 只能做：

```text
打开 12306
启动采集
人工选票 / 人工提交
记录提交前后窗口
提取流量
```

不能做：

```text
自动抢票
自动提交订单
自动支付
绕过验证码或排队
```

## 17. 当前限制和待修复项

### 17.1 采集入口未接到前端

后端已经有 `server/src/capture/` 基础模块，但 `server/index.js` 还没有暴露 `/api/capture/*`，前端也没有采集会话的启动、停止、标记和下载入口。

### 17.2 真实鸿蒙端 hdc 待联调

Android 可以模拟热点和抓包链路，但 `netstat -anp` 对包名/PID 的输出不稳定。鸿蒙端的 `hdc shell` 端口映射记录还需要在真实鸿蒙设备上验证。

### 17.3 UI 自动化观察层仍偏基础

当前点击控件已经优先通过 `uiautomator dump` 的 resource-id 定位，短视频/直播切换使用屏幕尺寸计算滑动坐标。后续更稳的方案是：

- `uiautomator dump` 定位控件
- OCR 读取屏幕
- screenshot 辅助校验
- 针对弹窗、登录、网络异常做状态机

## 18. 推荐下一步

建议按以下顺序推进：

1. 在 `server/index.js` 接入 `/api/capture/*`。
2. 前端增加采集任务状态、关键时刻标记、产物下载入口。
3. 在真实鸿蒙设备上联调 `hdc` 端口映射记录。
4. 配置 `GET_PCAP_SCRIPT` 指向本机 `get_pcap.py`。

## 19. 总结

当前实现本质是：

```text
prompt 负责理解任务
fallback parser 负责固定命令兜底
safety 负责拦截风险
skill 负责生成动作序列
ADB allowlist 负责执行
frontend 负责输入、日志和停止
```

这种架构适合继续扩展为流量采集 agent，因为手机操作和流量采集可以通过同一个 harness 编排：

```text
采集准备
  -> 手机操作 skill
  -> 端侧端口映射
  -> 指定 WLAN 接口抓包
  -> 流量提取
  -> 报告输出
```

关键工程原则是：模型只做结构化解析，不直接执行命令；高风险业务只允许人工确认采集，不允许自动完成真实交易或抢占行为。
