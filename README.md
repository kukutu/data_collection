# 手机文本控制台

这是一个本地运行的 Android 手机文本控制台。你在网页输入任务，例如“刷30分钟抖音”“高德地图导航到北京站5分钟”“用腾讯会议加入会议 https://meeting.tencent.com/... 30分钟”，后端会解析任务、执行安全检查，然后通过 ADB 控制手机完成对应业务流。

## 前置条件

- Windows
- Node.js 22 或兼容版本
- ADB 已加入 PATH，或通过 `ADB_PATH` 指定
- 手机已开启开发者选项和 USB 调试，并授权当前电脑
- 可选：本机已登录 Codex，或准备 OpenAI-compatible API Key

## 启动

在项目目录运行：

```powershell
npm start
```

默认访问：

```text
http://localhost:5177
```

如果 `5177` 被占用，服务会自动尝试后续端口，实际地址会显示在终端输出里。

## 使用方式

1. 连接手机，确认 `adb devices` 能看到 `device` 状态。
2. 启动服务并打开网页。
3. 选择解析模式：
   - `本地规则`：不需要 key，适合已支持的固定任务。
   - `API 模型`：前端填写 API Key，通过 `OPENAI_BASE_URL` 调用模型解析任务。
   - `本机 Codex`：不需要 API Key，使用 `C:\Users\<当前用户>\.codex` 的本机 Codex 配置。
4. 直接输入任务，或点击“快捷任务”生成任务文本。
5. 点击“开始”，执行日志会显示在右侧。

## 快捷任务

前端已按业务类型提供参数槽：

| 分类 | 参数 | 示例 |
| --- | --- | --- |
| 短视频 | App、时长 | `刷30分钟抖音` |
| 长视频 | App、时长 | `看5分钟腾讯视频` |
| 直播 | App、时长 | `看5分钟抖音直播` |
| 会议 | App、入会地址、时长 | `用腾讯会议加入会议 https://meeting.tencent.com/... 30分钟` |
| 导航 | App、目的地、时长 | `高德地图导航到北京站5分钟` |
| AI 应用 | App、时长 | `和千问聊天5分钟` |
| 系统 | 固定命令 | `回到桌面` |

## 当前已实现功能

前端会根据 `adb shell pm list packages` 只展示这台手机已经安装的 App。下面列表表示代码已实现，不表示每台手机都已安装。

| 功能 | 已实现 App | 说明 |
| --- | --- | --- |
| 短视频浏览 | 抖音、小红书视频、快手、西瓜视频、微信视频号 | 打开 App 或入口后按时长上滑浏览，小红书会先进入“视频”流；快手、西瓜视频未安装时不会在前端显示 |
| 长视频播放 | 腾讯视频、B站、优酷视频 | 必须进入真实视频播放页才算执行 |
| 直播浏览 | 抖音、淘宝、京东、微信、小红书 | 必须进入真实直播间并检测画面变化才算执行；默认随机 2-5 分钟切换一次直播间，也可写“每3分钟下滑”；微信路径为“发现 > 直播”；小红书路径为顶部“直播”；微博已移除 |
| 地图导航 | 高德地图 | 必须填写目的地，会打开路线并尝试开始导航 |
| AI 对话 | 豆包、千问 | 输入英文短句并按间隔发送 |
| 会议入会 | 钉钉、腾讯会议、飞书、welink | 必须填写入会地址，只打开链接并尝试入会 |
| 系统操作 | Android 系统 | 返回、回桌面 |

## 会议任务说明

会议类现在支持，但必须有明确入会地址。下面这种会执行：

```text
用腾讯会议加入会议 https://meeting.tencent.com/dm/abc 30分钟
```

下面这种不会执行，因为只是入口停留：

```text
进入腾讯会议
```

会议 skill 的边界：

- 会通过 ADB 打开入会链接。
- 会尝试点击“加入会议”“进入会议”“立即加入”等按钮。
- 默认会自动点击首次启动协议或常规系统权限里的“同意/允许”。
- 不会自动点击支付、下单、关注、点赞、评论、打赏等业务动作。
- 默认会自动点击首次启动协议或常规系统权限里的“同意/允许”；如果遇到无法识别的权限或隐私弹窗，需要先在手机上手动处理。

## 安全边界

系统不会执行以下高风险动作：

- 付款、自动支付、支付密码、扫码支付
- 下单、提交订单、购买、买票、购票、抢票
- 抢单、抢红包、确认叫车
- 评论、私信、关注、点赞、打赏
- 验证码、人机验证、绕过风控
- 支付、下单、关注、点赞、评论、打赏等业务确认

只打开 App、进入入口页、停留几秒不算已实现业务流。没有真实目标参数的音视频通话、票务、游戏、上传下载、出行叫车等任务会被拦截。

## 解析模式配置

API 模式默认配置在 `server/src/config.js`：

```text
OPENAI_BASE_URL=https://api.codexzh.com/v1
OPENAI_MODEL=gpt-5.5
```

启动前可在 PowerShell 里覆盖：

```powershell
$env:OPENAI_BASE_URL="https://api.codexzh.com/v1"
$env:OPENAI_MODEL="gpt-5.5"
npm start
```

本机 Codex 模式相关环境变量：

```text
CODEX_CLI_PATH      Codex CLI 路径
CODEX_HOME_PATH     Codex 配置目录，默认 C:\Users\<当前用户>\.codex
CODEX_MODEL         Codex 使用的模型，不填则使用本机配置默认值
CODEX_TIMEOUT_MS    Codex 解析超时，默认 120000
```

## 项目结构

```text
public/                  前端页面、样式和交互逻辑
server/index.js           HTTP 服务和 API 路由
server/src/adb.js         ADB 封装和 allowlist 动作
server/src/app-registry.js App 注册表读取和已安装检测
server/src/harness.js     任务调度和 skill 执行
server/src/llm.js         API / Codex 解析
server/src/task-parser.js 本地规则解析
server/src/safety.js      安全策略
server/src/skills/        具体业务 skill
data/apps.json            App 名称、别名、分类、包名和 skill 映射
tests/                    单元测试
docs/                     实现方案文档
skills/                   Codex skill 说明文件
```

## 测试

运行：

```powershell
npm test
```

语法检查示例：

```powershell
node --check public\app.js
node --check server\src\task-parser.js
node --check server\src\harness.js
```

当前测试覆盖：

- ADB URI 参数引用
- 高德导航任务构建
- 腾讯视频和通用长视频播放
- 短视频、直播、微信视频号
- AI 对话
- 会议入会链接
- 安全策略拦截
- 本地规则和模型 JSON 解析

## 常用排查

查看设备：

```powershell
adb devices
```

查看当前前台 App：

```powershell
adb shell dumpsys window | Select-String -Pattern "mCurrentFocus|mFocusedApp"
```

如果网页显示未连接：

- 确认手机弹出的 USB 调试授权已经允许。
- 重新插拔数据线。
- 执行 `adb kill-server` 后再执行 `adb start-server`。
- 确认没有手机助手类软件占用 ADB。

如果任务被拦截：

- 看右侧日志里的拦截原因。
- 导航任务必须有目的地。
- 会议任务必须有入会地址。
- 权限、隐私协议需要手动处理。
