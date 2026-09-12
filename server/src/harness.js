import { randomUUID } from 'node:crypto';
import { executeQqVoipCall } from './skills/qq-voip.js';
import {
  executeWelinkVoipCall,
  WELINK_AUDIO_CALL_WORKFLOW_ID,
  WELINK_VIDEO_CALL_WORKFLOW_ID,
} from './skills/welink-voip.js';
import { executeJdLiveBrowse } from './skills/jd-live.js';
import { executeYangshipinLiveBrowse } from './skills/yangshipin-live.js';
import {
  executeXunleiUploadMedia,
  XUNLEI_UPLOAD_MEDIA_WORKFLOW_ID,
} from './skills/xunlei-upload.js';
import {
  DEFAULT_XUNLEI_MAGNET,
  executeXunleiDownload,
  XUNLEI_DOWNLOAD_WORKFLOW_ID,
} from './skills/xunlei-download.js';
import {
  APP_STORE_DOWNLOAD_WORKFLOW_ID,
  DEFAULT_APP_STORE_TARGET,
  executeAppStoreDownload,
} from './skills/app-store-download.js';
import {
  BAIDU_NETDISK_DOWNLOAD_WORKFLOW_ID,
  executeBaiduNetdiskDownload,
} from './skills/baidu-netdisk-download.js';
import { BAIDU_NETDISK_UPLOAD_WORKFLOW_ID, executeBaiduNetdiskUpload } from './skills/baidu-netdisk-upload.js';

import { findAppByName } from './app-registry.js';
import { parseTaskWithCodexCli, parseTaskWithModel } from './llm.js';
import { parseTaskFallback } from './task-parser.js';
import { evaluateSafety } from './safety.js';
import {
  createDeviceProfile,
  resolveProfiledPoint,
} from './device-profile.js';
import {
  buildHarmonyHomePageSwipe,
  findHarmonyHomeFolders,
  findHarmonyHomeTarget,
} from './harmony-home.js';
import { buildAiChatPlan } from './skills/ai-chat.js';
import { buildDeepseekChatPlan } from './skills/deepseek-chat.js';
import { buildDoubaoChatPlan } from './skills/doubao-chat.js';
import { buildQianwenChatPlan } from './skills/qianwen-chat.js';
import { buildXiaoyiChatPlan } from './skills/xiaoyi-chat.js';
import { buildLiveStreamPlan } from './skills/live-stream.js';
import { buildShortVideoPlan } from './skills/short-video.js';
import { executeDingtalkVoipCall } from './skills/dingtalk-voip.js';
import { executeWecomVoipCall } from './skills/wecom-voip.js';
import { executeFeishuQuickMeeting, executeFeishuJoinMeeting, FEISHU_QUICK_MEETING_WORKFLOW_ID, FEISHU_JOIN_MEETING_WORKFLOW_ID } from './skills/feishu-meeting.js';
import { executeDingtalkQuickMeeting, executeDingtalkJoinMeeting, DINGTALK_QUICK_MEETING_WORKFLOW_ID, DINGTALK_JOIN_MEETING_WORKFLOW_ID } from './skills/dingtalk-meeting.js';
import { buildAmapNavigationPlan } from './skills/amap-navigation.js';
import { buildGenericMediaPlaybackPlan } from './skills/generic-media.js';
import { buildLiveEntryPlan } from './skills/live-entry.js';
import { buildTencentVideoPlaybackPlan } from './skills/tencent-video.js';
import { buildWechatChannelsPlan } from './skills/wechat-channels.js';
import { buildWechatMessagesPlan } from './skills/wechat-messages.js';
import {
  durationParameterToMs as meetingDurationParameterToMs,
  executeTencentJoinMeeting,
  executeTencentQuickMeeting,
  TENCENT_JOIN_MEETING_WORKFLOW_ID,
  TENCENT_QUICK_MEETING_WORKFLOW_ID,
} from './skills/tencent-meeting.js';
import {
  executeWechatMediaTransfer,
  WECHAT_MEDIA_WORKFLOW_ID,
} from './skills/wechat-media.js';
import {
  callTypeForWechatWorkflow,
  executeWechatVoipCall,
  isWechatVoipWorkflowId,
} from './skills/wechat-voip.js';
import {
  executeKuaishouLiveBrowse,
  KUAISHOU_LIVE_WORKFLOW_ID,
} from './skills/kuaishou-live.js';
import {
  BILIBILI_LIVE_WORKFLOW_ID,
  executeBilibiliLiveBrowse,
} from './skills/bilibili-live.js';
import {
  executeHuyaLiveBrowse,
  HUYA_LIVE_WORKFLOW_ID,
} from './skills/huya-live.js';
import {
  DOUYU_LIVE_WORKFLOW_ID,
  executeDouyuLiveBrowse,
} from './skills/douyu-live.js';
import {
  executeIqiyiLiveBrowse,
  IQIYI_LIVE_WORKFLOW_ID,
} from './skills/iqiyi-live.js';
import {
  executeTaobaoLiveBrowse,
  TAOBAO_LIVE_WORKFLOW_ID,
} from './skills/taobao-live.js';
import {
  buildWeiboLiveManualPlan,
  WEIBO_LIVE_WORKFLOW_ID,
} from './skills/weibo-live.js';
import { executeUiMessage } from './ui-message.js';
import { findWorkflow } from './workflow-registry.js';

const MIN_LIVE_SWITCH_INTERVAL_MS = 1000;

export class TaskManager {
  constructor({
    adb,
    apps,
    captureManager = null,
    workflows = [],
    workflowExecutionProvider = null,
    tencentJoinMeetingExecutor = executeTencentJoinMeeting,
    tencentQuickMeetingExecutor = executeTencentQuickMeeting,
    wechatMediaExecutor = executeWechatMediaTransfer,
    wechatVoipExecutor = executeWechatVoipCall,
    welinkVoipExecutor = executeWelinkVoipCall,
    kuaishouLiveExecutor = executeKuaishouLiveBrowse,
    bilibiliLiveExecutor = executeBilibiliLiveBrowse,
    huyaLiveExecutor = executeHuyaLiveBrowse,
    douyuLiveExecutor = executeDouyuLiveBrowse,
    iqiyiLiveExecutor = executeIqiyiLiveBrowse,
    taobaoLiveExecutor = executeTaobaoLiveBrowse,
    xunleiUploadExecutor = executeXunleiUploadMedia,
    xunleiDownloadExecutor = executeXunleiDownload,
    appStoreDownloadExecutor = executeAppStoreDownload,
    baiduNetdiskDownloadExecutor = executeBaiduNetdiskDownload,
    baiduNetdiskUploadExecutor = executeBaiduNetdiskUpload,
  }) {
    this.adb = adb;
    this.apps = apps;
    this.captureManager = captureManager;
    this.workflows = workflows;
    this.workflowExecutionProvider = workflowExecutionProvider;
    this.tencentJoinMeetingExecutor = tencentJoinMeetingExecutor;
    this.tencentQuickMeetingExecutor = tencentQuickMeetingExecutor;
    this.wechatMediaExecutor = wechatMediaExecutor;
    this.wechatVoipExecutor = wechatVoipExecutor;
    this.welinkVoipExecutor = welinkVoipExecutor;
    this.kuaishouLiveExecutor = kuaishouLiveExecutor;
    this.bilibiliLiveExecutor = bilibiliLiveExecutor;
    this.huyaLiveExecutor = huyaLiveExecutor;
    this.douyuLiveExecutor = douyuLiveExecutor;
    this.iqiyiLiveExecutor = iqiyiLiveExecutor;
    this.taobaoLiveExecutor = taobaoLiveExecutor;
    this.xunleiUploadExecutor = xunleiUploadExecutor;
    this.xunleiDownloadExecutor = xunleiDownloadExecutor;
    this.appStoreDownloadExecutor = appStoreDownloadExecutor;
    this.baiduNetdiskDownloadExecutor = baiduNetdiskDownloadExecutor;
    this.baiduNetdiskUploadExecutor = baiduNetdiskUploadExecutor;
    this.tasks = new Map();
  }

  start({
    taskText,
    apiKey,
    useModel = false,
    parseMode,
    capture,
    workflowId = null,
    parameters = {},
  }) {
    const workflow = workflowId ? findWorkflow(this.workflows, workflowId) : null;
    if (workflowId && !workflow) throw new Error(`未找到功能: ${workflowId}`);

    const task = {
      id: randomUUID(),
      input: taskText,
      workflowId: workflow?.id || null,
      workflowName: workflow?.featureName || null,
      parameterSchema: workflow?.params || [],
      parameters: sanitizeTaskParameters(workflow?.params || [], parameters),
      executionParameters: { ...parameters },
      status: 'running',
      stepIndex: 0,
      totalSteps: 0,
      logs: [],
      startedAt: new Date().toISOString(),
      stopped: false,
      pendingConfirmation: null,
    };

    this.tasks.set(task.id, task);
    this.#run(task, { apiKey, useModel, parseMode, capture }).catch((error) => {
      if (task.status === 'stopped') return;
      task.status = 'failed';
      task.error = error.message;
      task.finishedAt = new Date().toISOString();
      this.#log(task, `失败: ${error.message}`);
    });

    return this.snapshot(task.id);
  }

  snapshot(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    const capture =
      task.capture?.id && this.captureManager
        ? this.captureManager.snapshot(task.capture.id) || task.capture
        : task.capture;
    return {
      id: task.id,
      input: task.input,
      workflowId: task.workflowId,
      workflowName: task.workflowName,
      parameterSchema: task.parameterSchema,
      parameters: task.parameters,
      status: task.status,
      parsed: sanitizeParsedTask(task.parsed),
      stepIndex: task.stepIndex,
      totalSteps: task.totalSteps,
      logs: task.logs.slice(-200),
      error: task.error,
      pendingConfirmation: task.pendingConfirmation,
      capture,
      captureError: task.captureError,
      sentCount: task.sentCount,
      effectiveDurationMs: task.effectiveDurationMs,
      validationMode: task.validationMode,
      validationChecks: task.validationChecks,
      deviceSession: task.deviceSession,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
    };
  }

  currentSnapshot() {
    const tasks = [...this.tasks.values()].reverse();
    const active = tasks.find((task) => ['running', 'waiting_confirmation'].includes(task.status));
    return active ? this.snapshot(active.id) : this.snapshot(tasks[0]?.id);
  }

  continue(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'waiting_confirmation' || !task.pendingConfirmation) return false;
    task.pendingConfirmation.confirmed = true;
    task.status = 'running';
    this.#log(task, '已收到人工确认，继续执行');
    return true;
  }

  stop(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    task.stopped = true;
    this.#log(task, '收到停止请求');
    return true;
  }

  async #run(task, { apiKey, useModel, parseMode, capture }) {
    this.#log(task, '开始解析任务');
    task.parsed = applyWorkflowParameters(
      await this.#parse(task.input, { apiKey, useModel, parseMode }),
      {
        workflowId: task.workflowId,
        parameters: task.executionParameters,
      },
    );
    this.#log(task, `解析结果: ${JSON.stringify(sanitizeParsedTask(task.parsed))}`);

    const safety = evaluateSafety(task.parsed, task.input);
    if (!safety.allowed) {
      task.status = 'blocked';
      task.error = safety.reason;
      task.finishedAt = new Date().toISOString();
      this.#log(task, safety.reason);
      return;
    }

    let captureSession = null;
    let deviceLock = null;
    let outcome = 'completed';
    let runError = null;
    task.captureConfig = capture?.enabled ? capture : null;
    try {
      if (typeof this.adb.beginSession === 'function') {
        deviceLock = await this.adb.beginSession({ owner: `task:${task.id}` });
        task.deviceSession = sanitizeDeviceSession(deviceLock);
        this.#log(
          task,
          `已锁定设备 ${deviceLock.serial || deviceLock.provider || 'unknown'}`,
        );
      }
      this.#assertNotStopped(task);
      await this.#execute(task);
    } catch (error) {
      runError = error;
      outcome = task.stopped || error instanceof TaskStoppedError ? 'stopped' : 'failed';
    } finally {
      captureSession ||= task.captureSession;
      if (captureSession) {
        try {
          task.capture = await this.captureManager.stop(captureSession.id, { reason: outcome });
          this.#log(task, `采集已完成: ${task.capture.outputDir}`);
        } catch (error) {
          task.captureError = error.message;
          this.#log(task, `采集收尾失败: ${error.message}`);
        }
      }
      if (deviceLock && typeof this.adb.endSession === 'function') {
        try {
          await this.adb.endSession(deviceLock);
        } catch (error) {
          if (!runError) {
            runError = error;
            outcome = 'failed';
          }
          this.#log(task, `释放设备锁失败: ${error.message}`);
        }
      }
    }

    if (outcome === 'stopped') {
      task.status = 'stopped';
      task.finishedAt ||= new Date().toISOString();
      this.#log(task, '任务已停止');
      return;
    }

    if (runError) throw runError;

    task.status = 'completed';
    task.finishedAt = new Date().toISOString();
    this.#log(task, '任务完成');
  }

  async #startCapture(task, capture) {
    const app = this.#resolveApp(task.parsed?.appName);
    const deviceStatus = await this.adb.getDeviceStatus();
    return this.captureManager.start({
      taskId: task.id,
      appName: app.name,
      businessName: inferBusinessName(task.parsed),
      packageName: app.packageName,
      bundleName: app.harmonyBundleName,
      phoneIp: capture.phoneIp,
      interfaceName: capture.interfaceName,
      outputRoot: capture.outputRoot,
      deviceStatus,
      recordScreen: capture.recordScreen !== false,
      recordPortMapping: capture.recordPortMapping !== false,
      extractorScript: capture.extractorScript,
    });
  }

  async #parse(taskText, { apiKey, useModel, parseMode }) {
    const mode = parseMode || (useModel ? 'api' : 'rules');

    if (mode === 'api' && apiKey) {
      try {
        return await parseTaskWithModel({ taskText, apiKey, apps: this.apps });
      } catch (error) {
        return {
          ...parseTaskFallback(taskText, this.apps),
          modelError: error.message,
        };
      }
    }

    if (mode === 'api' && !apiKey) {
      return {
        ...parseTaskFallback(taskText, this.apps),
        modelError: 'API 模式需要在前端填写 API Key',
      };
    }

    if (mode === 'codex') {
      try {
        return await parseTaskWithCodexCli({ taskText, apps: this.apps });
      } catch (error) {
        return {
          ...parseTaskFallback(taskText, this.apps),
          codexError: error.message,
        };
      }
    }

    return parseTaskFallback(taskText, this.apps);
  }

  async #execute(task) {
    switch (task.parsed.intent) {
      case 'launch_app':
        return this.#launch(task);
      case 'watch_feed':
        return this.#watchFeed(task);
      case 'watch_live':
        return this.#watchLive(task);
      case 'live_entry':
        return this.#liveEntry(task);
      case 'play_tencent_video':
        return this.#playTencentVideo(task);
      case 'play_generic_media':
        return this.#playGenericMedia(task);
      case 'amap_navigation':
        return this.#amapNavigation(task);
      case 'wechat_channels_feed':
        return this.#wechatChannels(task);
      case 'wechat_send_messages':
        return this.#wechatMessages(task);
      case 'wechat_send_media':
        return this.#wechatMedia(task);
      case 'xunlei_upload_media':
        return this.#xunleiUpload(task);
      case 'xunlei_download':
        return this.#xunleiDownload(task);
      case 'app_store_download':
        return this.#appStoreDownload(task);
      case 'baidu_netdisk_download':
        return this.#baiduNetdiskDownload(task);
      case 'baidu_netdisk_upload':
        return this.#baiduNetdiskUpload(task);
      case 'wechat_voip_call':
      case 'qq_voip_call':
        return this.#wechatVoip(task);
      case 'welink_voip_call':
        return this.#welinkVoip(task);
      case 'dingtalk_voip_call':
      case 'wecom_voip_call':
        return this.#enterpriseVoip(task);
      case 'tencent_quick_meeting':
        return this.#tencentQuickMeeting(task);
      case 'dingtalk_quick_meeting':
      case 'dingtalk_join_meeting':
        return this.#dingtalkQuickMeeting(task);
      case 'feishu_quick_meeting':
      case 'feishu_join_meeting':
        return this.#feishuQuickMeeting(task);
      case 'tencent_join_meeting':
        return this.#tencentJoinMeeting(task);
      case 'ai_chat':
        return this.#aiChat(task);
      case 'doubao_chat':
        return this.#doubaoChat(task);
      case 'back':
        return this.#key(task, 'KEYCODE_BACK', '返回');
      case 'home':
        return this.#key(task, 'KEYCODE_HOME', '回到桌面');
      default:
        throw new Error(`unsupported intent: ${task.parsed.intent}`);
    }
  }

  async #launch(task) {
    const app = this.#resolveApp(task.parsed.appName);
    this.#log(task, `打开 ${app.name}`);
    await this.adb.launchPackage(app.packageName);
    await this.#ensureCapture(task);
  }

  async #watchFeed(task) {
    const app = this.#resolveApp(task.parsed.appName);
    if (app.skill !== 'short_video_feed' && app.id !== 'bilibili') {
      throw new Error(`${app.name} 暂未实现可自动浏览的 skill`);
    }

    const screen = await this.adb.getScreenSize().catch(() => null);
    const steps = buildShortVideoPlan({
      app,
      durationMs: task.parsed.durationMs,
      screen: screen || undefined,
    });

    await this.#runSteps(task, steps);
  }

  async #watchLive(task) {
    const app = this.#resolveApp(task.parsed.appName);
    const focus = await this.adb.getCurrentFocus?.().catch(() => null);
    if (focus?.packageName && focus.packageName !== app.packageName) {
      throw new Error(`请先手动进入${app.name}直播间，再启动直播切换任务`);
    }

    const screen = await this.adb.getScreenSize().catch(() => null);
    const steps = buildLiveStreamPlan({
      app,
      durationMs: task.parsed.durationMs,
      switchIntervalMs: task.parsed.switchIntervalMs,
      screen: screen || undefined,
    });

    await this.#runSteps(task, steps);
  }

  async #doubaoChat(task) {
    const app = this.#resolveApp(task.parsed.appName || '豆包');
    if (app.skill !== 'doubao_chat') {
      throw new Error('doubao_chat 只能用于豆包 App');
    }

    const deviceStatus = await this.adb.getDeviceStatus?.().catch(() => null);
    const screen = deviceStatus?.screen || (await this.adb.getScreenSize().catch(() => null));
    const steps = buildDoubaoChatPlan({
      app,
      durationMs: task.parsed.durationMs,
      intervalMs: task.parsed.intervalMs,
      messages: task.parsed.messages,
      platform: deviceStatus?.platform,
      screen: screen || undefined,
    });

    await this.#runSteps(task, steps);
  }

  async #playTencentVideo(task) {
    const app = this.#resolveApp(task.parsed.appName);
    if (app.id !== 'tencent-video') {
      throw new Error('play_tencent_video 只能用于腾讯视频 App');
    }
    const screen = await this.adb.getScreenSize().catch(() => null);
    const steps = buildTencentVideoPlaybackPlan({
      app,
      durationMs: task.parsed.durationMs,
      screen: screen || undefined,
    });

    await this.#runSteps(task, steps);
  }

  async #amapNavigation(task) {
    const app = this.#resolveApp(task.parsed.appName);
    if (app.id !== 'amap') {
      throw new Error('amap_navigation 只能用于高德地图 App');
    }
    const screen = await this.adb.getScreenSize().catch(() => null);
    const steps = buildAmapNavigationPlan({
      app,
      destination: task.parsed.destination,
      durationMs: task.parsed.durationMs,
      screen: screen || undefined,
    });

    await this.#runSteps(task, steps);
  }

  async #playGenericMedia(task) {
    const app = this.#resolveApp(task.parsed.appName);
    const screen = await this.adb.getScreenSize().catch(() => null);
    const steps = buildGenericMediaPlaybackPlan({
      app,
      durationMs: task.parsed.durationMs,
      screen: screen || undefined,
    });

    await this.#runSteps(task, steps);
  }

  async #wechatChannels(task) {
    const app = this.#resolveApp(task.parsed.appName);
    if (!['wechat', 'qq'].includes(app.id) || (task.parsed.intent === 'qq_voip_call') !== (app.id === 'qq')) {
      throw new Error('wechat_channels_feed 只能用于微信 App');
    }
    const screen = await this.adb.getScreenSize().catch(() => null);
    const steps = buildWechatChannelsPlan({
      app,
      durationMs: task.parsed.durationMs,
      screen: screen || undefined,
    });

    await this.#runSteps(task, steps);
  }

  async #wechatMessages(task) {
    const app = this.#resolveApp(task.parsed.appName || '微信');
    if (app.id !== 'wechat') {
      throw new Error('wechat_send_messages 只能用于微信 App');
    }
    if (task.parsed.targetMode && task.parsed.targetMode !== 'first') {
      throw new Error('微信发消息当前只支持聊天列表中的第一个会话');
    }

    const deviceStatus = await this.adb.getDeviceStatus?.().catch(() => null);
    const screen = deviceStatus?.screen || (await this.adb.getScreenSize().catch(() => null));
    const steps = buildWechatMessagesPlan({
      app,
      durationMs: task.parsed.durationMs,
      intervalMs: task.parsed.intervalMs,
      platform: deviceStatus?.platform,
      screen: screen || undefined,
    });

    await this.#runSteps(task, steps);
  }

  async #wechatMedia(task) {
    const app = this.#resolveApp(task.parsed.appName || '微信');
    if (app.id !== 'wechat') {
      throw new Error('wechat_send_media 只能用于微信 App');
    }
    if (task.parsed.targetMode && task.parsed.targetMode !== 'first') {
      throw new Error('微信发图/视频当前只支持聊天列表中的第一个会话');
    }

    const result = await this.wechatMediaExecutor({
      device: this.adb,
      app,
      sendMode: task.parsed.sendMode,
      sendCount: task.parsed.sendCount,
      durationMs: task.parsed.durationMs,
      intervalMs: task.parsed.intervalMs,
      startCapture: task.captureConfig?.enabled
        ? () => this.#ensureCapture(task)
        : null,
      sleep: (ms) => this.#sleep(ms, task),
      onStep: (stepIndex, label, totalSteps) => {
        this.#assertNotStopped(task);
        task.stepIndex = stepIndex;
        task.totalSteps = totalSteps;
        this.#log(task, label);
      },
    });
    task.validationMode = result.validationMode;
    task.validationChecks = result.validationChecks || [];
    task.sentCount = result.sentCount;
    task.effectiveDurationMs = result.effectiveDurationMs ?? null;
  }

  async #wechatVoip(task) {
    const app = this.#resolveApp(task.parsed.appName || '微信');
    if (app.id !== 'wechat') {
      throw new Error('wechat_voip_call 只能用于微信 App');
    }
    if (task.parsed.targetMode && task.parsed.targetMode !== 'first') {
      throw new Error('微信音视频通话当前只支持聊天列表中的第一个会话');
    }

    const executor = app.id === 'qq' ? executeQqVoipCall : this.wechatVoipExecutor;
    const result = await executor({
      device: this.adb,
      app,
      workflowId: task.workflowId,
      callType: task.parsed.callType,
      durationMs: task.parsed.durationMs,
      startCapture: task.captureConfig?.enabled
        ? () => this.#ensureCapture(task)
        : null,
      sleep: (ms) => this.#sleep(ms, task),
      onStep: (stepIndex, label, totalSteps) => {
        this.#assertNotStopped(task);
        task.stepIndex = stepIndex;
        task.totalSteps = totalSteps;
        this.#log(task, label);
      },
    });
    task.validationMode = result.validationMode;
    task.validationChecks = result.validationChecks || [];
    task.effectiveDurationMs = result.effectiveDurationMs ?? null;
  }

  async #welinkVoip(task) {
    const app = this.#resolveApp(task.parsed.appName || 'welink');
    if (app.id !== 'welink') throw new Error('welink_voip_call 只适用于 WeLink');
    const result = await this.welinkVoipExecutor({
      device: this.adb,
      app,
      callType: task.parsed.callType,
      camera: task.parsed.camera,
      shareScreen: task.parsed.shareScreen,
      durationMs: task.parsed.durationMs,
      startCapture: task.captureConfig?.enabled ? () => this.#ensureCapture(task) : null,
      sleep: (ms) => this.#sleep(ms, task),
      onStep: (index, label, total) => {
        this.#assertNotStopped(task);
        task.stepIndex = index;
        task.totalSteps = total;
        this.#log(task, label);
      },
    });
    task.validationMode = result.validationMode;
    task.validationChecks = result.validationChecks || [];
    task.effectiveDurationMs = result.effectiveDurationMs ?? null;
  }

  async #xunleiUpload(task) {
    const app = this.#resolveApp(task.parsed.appName || '迅雷');
    if (app.id !== 'xunlei') {
      throw new Error('xunlei_upload_media 只适用于迅雷 App');
    }
    const result = await this.xunleiUploadExecutor({
      device: this.adb,
      app,
      startCapture: task.captureConfig?.enabled
        ? () => this.#ensureCapture(task)
        : null,
      sleep: (ms) => this.#sleep(ms, task),
      onStep: (stepIndex, label, totalSteps) => {
        this.#assertNotStopped(task);
        task.stepIndex = stepIndex;
        task.totalSteps = totalSteps;
        this.#log(task, label);
      },
    });
    task.validationMode = result.validationMode;
    task.validationChecks = result.validationChecks || [];
    task.stepIndex = result.replayStepIndex || task.stepIndex;
  }

  async #xunleiDownload(task) {
    const app = this.#resolveApp(task.parsed.appName || '迅雷');
    if (app.id !== 'xunlei') {
      throw new Error('xunlei_download 只适用于迅雷 App');
    }
    const result = await this.xunleiDownloadExecutor({
      device: this.adb,
      app,
      magnetUrl: task.parsed.magnetUrl || DEFAULT_XUNLEI_MAGNET,
      durationMs: task.parsed.durationMs,
      startCapture: task.captureConfig?.enabled
        ? () => this.#ensureCapture(task)
        : null,
      sleep: (ms) => this.#sleep(ms, task),
      onStep: (stepIndex, label, totalSteps) => {
        this.#assertNotStopped(task);
        task.stepIndex = stepIndex;
        task.totalSteps = totalSteps;
        this.#log(task, label);
      },
    });
    task.validationMode = result.validationMode;
    task.validationChecks = result.validationChecks || [];
    task.effectiveDurationMs = result.effectiveDurationMs ?? null;
    task.stepIndex = result.replayStepIndex || task.stepIndex;
  }

  async #appStoreDownload(task) {
    const store = this.#resolveApp(task.parsed.appName || '应用市场');
    if (store.id !== 'app-store') {
      throw new Error('app_store_download 只适用于应用市场');
    }
    const targetApp = this.#resolveApp(task.parsed.targetApp || DEFAULT_APP_STORE_TARGET);
    if (!targetApp) throw new Error(`未找到目标应用 ${task.parsed.targetApp || DEFAULT_APP_STORE_TARGET}`);
    const result = await this.appStoreDownloadExecutor({
      device: this.adb,
      app: store,
      targetApp,
      durationMs: task.parsed.durationMs,
      startCapture: task.captureConfig?.enabled
        ? () => this.#ensureCapture(task)
        : null,
      sleep: (ms) => this.#sleep(ms, task),
      onStep: (stepIndex, label, total) => {
        this.#assertNotStopped(task);
        task.stepIndex = stepIndex;
        task.totalSteps = total;
        this.#log(task, label);
      },
    });
    task.validationMode = result.validationMode;
    task.validationChecks = result.validationChecks || [];
    task.effectiveDurationMs = result.effectiveDurationMs ?? null;
    task.stepIndex = result.replayStepIndex || task.stepIndex;
  }

  async #baiduNetdiskDownload(task) {
    const app = this.#resolveApp(task.parsed.appName || '百度网盘');
    if (app.id !== 'baidu-netdisk') {
      throw new Error('baidu_netdisk_download 只适用于百度网盘');
    }
    const result = await this.baiduNetdiskDownloadExecutor({
      device: this.adb,
      app,
      durationMs: task.parsed.durationMs,
      startCapture: task.captureConfig?.enabled ? () => this.#ensureCapture(task) : null,
      sleep: (ms) => this.#sleep(ms, task),
      onStep: (stepIndex, label, total) => {
        this.#assertNotStopped(task);
        task.stepIndex = stepIndex;
        task.totalSteps = total;
        this.#log(task, label);
      },
    });
    task.validationMode = result.validationMode;
    task.validationChecks = result.validationChecks || [];
    task.effectiveDurationMs = result.effectiveDurationMs ?? null;
    task.stepIndex = result.replayStepIndex || task.stepIndex;
  }

  async #baiduNetdiskUpload(task) {
    const app = this.#resolveApp(task.parsed.appName || '百度网盘');
    const result = await this.baiduNetdiskUploadExecutor({ device: this.adb, app, mediaType: task.parsed.mediaType, sleep: ms => this.#sleep(ms, task), onStep: (i, label, total) => { this.#assertNotStopped(task); task.stepIndex=i; task.totalSteps=total; this.#log(task,label); } });
    task.validationMode = result.validationMode; task.validationChecks = result.validationChecks || []; task.stepIndex = result.replayStepIndex || task.stepIndex;
  }

  async #tencentQuickMeeting(task) {
    return this.#tencentMeeting(task, {
      executor: this.tencentQuickMeetingExecutor,
      sourceWorkflowId: TENCENT_QUICK_MEETING_WORKFLOW_ID,
      workflowLabel: '快速会议',
    });
  }

  async #dingtalkQuickMeeting(task) {
    const executor = task.parsed.intent === 'dingtalk_join_meeting' ? executeDingtalkJoinMeeting : executeDingtalkQuickMeeting;
    const result = await executor({
      device: this.adb, app: this.#resolveApp(task.parsed.appName),
      meetingId: task.parsed.meetingId,
      meetingType: task.parsed.meetingType, camera: task.parsed.camera,
      shareScreen: task.parsed.shareScreen, durationMs: task.parsed.durationMs,
      sleep: ms => this.#sleep(ms, task),
      startCapture: task.captureConfig?.enabled ? () => this.#ensureCapture(task) : null,
      onStep: (index, label) => {
        this.#assertNotStopped(task);
        task.stepIndex = index;
        task.totalSteps = 5;
        this.#log(task, label);
      },
    });
    task.validationMode = result.validationMode;
    task.validationChecks = result.validationChecks;
    task.effectiveDurationMs = result.effectiveDurationMs;
  }

  async #enterpriseVoip(task) {
    const executor = task.parsed.intent === 'wecom_voip_call' ? executeWecomVoipCall : executeDingtalkVoipCall;
    const result = await executor({
      device: this.adb, app: this.#resolveApp(task.parsed.appName),
      callType: task.parsed.callType, durationMs: task.parsed.durationMs,
      camera: task.parsed.camera, shareScreen: task.parsed.shareScreen,
      sleep: ms => this.#sleep(ms, task),
      startCapture: task.captureConfig?.enabled ? () => this.#ensureCapture(task) : null,
      onStep: (index, label) => {
        this.#assertNotStopped(task);
        task.stepIndex = index;
        task.totalSteps = 5;
        this.#log(task, label);
      },
    });
    task.validationMode = result.validationMode;
    task.validationChecks = result.validationChecks;
    task.effectiveDurationMs = result.effectiveDurationMs;
  }

  async #feishuQuickMeeting(task) {
    const executor = task.parsed.intent === 'feishu_join_meeting' ? executeFeishuJoinMeeting : executeFeishuQuickMeeting;
    const result = await executor({
      device: this.adb, app: this.#resolveApp(task.parsed.appName),
      meetingId: task.parsed.meetingId,
      durationMs: task.parsed.durationMs, camera: task.parsed.camera, shareScreen: task.parsed.shareScreen,
      sleep: ms => this.#sleep(ms, task),
      startCapture: task.captureConfig?.enabled ? () => this.#ensureCapture(task) : null,
      onStep: (index, label) => {
        this.#assertNotStopped(task);
        task.stepIndex = index;
        task.totalSteps = 5;
        this.#log(task, label);
      },
    });
    task.validationMode = result.validationMode;
    task.validationChecks = result.validationChecks;
    task.effectiveDurationMs = result.effectiveDurationMs;
  }

  async #tencentJoinMeeting(task) {
    return this.#tencentMeeting(task, {
      executor: this.tencentJoinMeetingExecutor,
      sourceWorkflowId: TENCENT_QUICK_MEETING_WORKFLOW_ID,
      workflowLabel: '加入会议',
    });
  }

  async #tencentMeeting(
    task,
    { executor, sourceWorkflowId, workflowLabel },
  ) {
    const app = this.#resolveApp(task.parsed.appName || '腾讯会议');
    if (app.id !== 'tencent-meeting') {
      throw new Error(`${task.parsed.intent} 只能用于腾讯会议 App`);
    }
    if (
      task.parsed.shareScreen &&
      typeof this.workflowExecutionProvider !== 'function'
    ) {
      throw new Error('腾讯会议快捷任务尚未配置已验证录制资料');
    }

    const execution =
      typeof this.workflowExecutionProvider === 'function'
        ? await this.workflowExecutionProvider(sourceWorkflowId)
        : null;
    if (
      task.parsed.shareScreen &&
      (!execution || execution.validationStatus !== 'verified')
    ) {
      throw new Error(
        `腾讯会议${workflowLabel}缺少已验证共享屏幕录制，请先完成快速会议动作回放验证`,
      );
    }

    const recordedSteps = Array.isArray(execution?.steps)
      ? execution.steps
      : [];
    const sourceProfile =
      execution?.recordingProfile ||
      createDeviceProfile({
        status: { provider: 'hdc' },
        screen: execution?.screen,
      });
    task.totalSteps = task.parsed.shareScreen ? recordedSteps.length : 0;
    const meetingParameters = {
      duration:
        task.executionParameters.duration ||
        { amount: task.parsed.durationMs, unit: '毫秒' },
      camera: task.parsed.camera,
      shareScreen: task.parsed.shareScreen,
    };
    if (task.parsed.intent === 'tencent_join_meeting') {
      meetingParameters.meetingId = task.parsed.meetingId;
      meetingParameters.meetingPassword = task.parsed.meetingPassword;
    }

    const result = await executor({
      device: this.adb,
      app,
      parameters: meetingParameters,
      recordedSteps,
      sourceScreen: execution?.screen,
      executeStep: async (step, { targetScreen } = {}) => {
        this.#assertNotStopped(task);
        const currentScreen =
          targetScreen ||
          task.deviceSession?.screen ||
          (await this.adb.getScreenSize().catch(() => null));
        const targetProfile = createDeviceProfile({
          status: task.deviceSession || {},
          screen: currentScreen,
        });
        const point = resolveProfiledPoint(step, sourceProfile, targetProfile);
        if (step.type === 'tap') {
          await this.adb.tap(point);
          return;
        }
        if (step.type === 'long_press') {
          if (typeof this.adb.longPress !== 'function') {
            throw new Error('当前设备适配器不支持腾讯会议共享动作中的长按');
          }
          await this.adb.longPress({
            ...point,
            durationMs: step.durationMs,
          });
          return;
        }
        throw new Error(`腾讯会议录制包含不支持的动作类型: ${step.type}`);
      },
      startCapture: task.captureConfig?.enabled
        ? () => this.#ensureCapture(task)
        : null,
      sleep: (ms) => this.#sleep(ms, task),
      onStep: (stepIndex) => {
        this.#assertNotStopped(task);
        task.stepIndex = stepIndex;
        this.#log(
          task,
          `执行会议共享动作 ${stepIndex}/${Math.max(recordedSteps.length, stepIndex)}`,
        );
      },
      onStatus: (message) => {
        this.#assertNotStopped(task);
        this.#log(task, message);
      },
    });
    task.validationMode = result.validationMode;
    task.validationChecks = result.validationChecks || [];
    task.effectiveDurationMs = result.effectiveDurationMs ?? null;
    task.stepIndex = result.replayStepIndex || task.stepIndex;
  }

  async #liveEntry(task) {
    const app = this.#resolveApp(task.parsed.appName);
    if (app.id === 'jd' || app.id === 'yangshipin') {
      const executor = app.id === 'jd' ? executeJdLiveBrowse : executeYangshipinLiveBrowse;
      const result = await executor({
        device: this.adb, app, durationMs: task.parsed.durationMs,
        switchIntervalMs: task.parsed.switchIntervalMs,
        sleep: (ms) => this.#sleep(ms, task),
        startCapture: task.captureConfig?.enabled ? () => this.#ensureCapture(task) : null,
        onStep: (index, label, total) => {
          this.#assertNotStopped(task);
          task.stepIndex = index;
          task.totalSteps = total;
          this.#log(task, label);
        },
      });
      task.validationMode = result.validationMode;
      task.validationChecks = result.validationChecks;
      task.effectiveDurationMs = result.effectiveDurationMs;
      return;
    }
    if (task.workflowId === TAOBAO_LIVE_WORKFLOW_ID || app.id === 'taobao') {
      const result = await this.taobaoLiveExecutor({
        device: this.adb,
        app,
        durationMs: task.parsed.durationMs,
        switchIntervalMs: task.parsed.switchIntervalMs,
        startCapture: task.captureConfig?.enabled
          ? () => this.#ensureCapture(task)
          : null,
        sleep: (ms) => this.#sleep(ms, task),
        onStep: (stepIndex, label, totalSteps) => {
          this.#assertNotStopped(task);
          task.stepIndex = stepIndex;
          task.totalSteps = totalSteps;
          this.#log(task, label);
        },
      });
      task.validationMode = result.validationMode;
      task.validationChecks = result.validationChecks || [];
      task.effectiveDurationMs = result.effectiveDurationMs ?? null;
      task.stepIndex = result.replayStepIndex || task.stepIndex;
      return;
    }

    if (task.workflowId === IQIYI_LIVE_WORKFLOW_ID || app.id === 'iqiyi') {
      const result = await this.iqiyiLiveExecutor({
        device: this.adb,
        app,
        durationMs: task.parsed.durationMs,
        switchIntervalMs: task.parsed.switchIntervalMs,
        startCapture: task.captureConfig?.enabled
          ? () => this.#ensureCapture(task)
          : null,
        sleep: (ms) => this.#sleep(ms, task),
        onStep: (stepIndex, label, totalSteps) => {
          this.#assertNotStopped(task);
          task.stepIndex = stepIndex;
          task.totalSteps = totalSteps;
          this.#log(task, label);
        },
      });
      task.validationMode = result.validationMode;
      task.validationChecks = result.validationChecks || [];
      task.effectiveDurationMs = result.effectiveDurationMs ?? null;
      task.stepIndex = result.replayStepIndex || task.stepIndex;
      return;
    }

    if (task.workflowId === WEIBO_LIVE_WORKFLOW_ID || app.id === 'weibo') {
      const screen = await this.adb.getScreenSize().catch(() => null);
      const steps = buildWeiboLiveManualPlan({
        app,
        durationMs: task.parsed.durationMs,
        switchIntervalMs: task.parsed.switchIntervalMs,
        screen: screen || undefined,
      });
      await this.#runSteps(task, steps);
      return;
    }

    if (task.workflowId === DOUYU_LIVE_WORKFLOW_ID || app.id === 'douyu') {
      const result = await this.douyuLiveExecutor({
        device: this.adb,
        app,
        durationMs: task.parsed.durationMs,
        switchIntervalMs: task.parsed.switchIntervalMs,
        startCapture: task.captureConfig?.enabled
          ? () => this.#ensureCapture(task)
          : null,
        sleep: (ms) => this.#sleep(ms, task),
        onStep: (stepIndex, label, totalSteps) => {
          this.#assertNotStopped(task);
          task.stepIndex = stepIndex;
          task.totalSteps = totalSteps;
          this.#log(task, label);
        },
      });
      task.validationMode = result.validationMode;
      task.validationChecks = result.validationChecks || [];
      task.effectiveDurationMs = result.effectiveDurationMs ?? null;
      task.stepIndex = result.replayStepIndex || task.stepIndex;
      return;
    }

    if (task.workflowId === HUYA_LIVE_WORKFLOW_ID || app.id === 'huya') {
      const result = await this.huyaLiveExecutor({
        device: this.adb,
        app,
        durationMs: task.parsed.durationMs,
        switchIntervalMs: task.parsed.switchIntervalMs,
        startCapture: task.captureConfig?.enabled
          ? () => this.#ensureCapture(task)
          : null,
        sleep: (ms) => this.#sleep(ms, task),
        onStep: (stepIndex, label, totalSteps) => {
          this.#assertNotStopped(task);
          task.stepIndex = stepIndex;
          task.totalSteps = totalSteps;
          this.#log(task, label);
        },
      });
      task.validationMode = result.validationMode;
      task.validationChecks = result.validationChecks || [];
      task.effectiveDurationMs = result.effectiveDurationMs ?? null;
      task.stepIndex = result.replayStepIndex || task.stepIndex;
      return;
    }

    if (task.workflowId === BILIBILI_LIVE_WORKFLOW_ID || app.id === 'bilibili') {
      const result = await this.bilibiliLiveExecutor({
        device: this.adb,
        app,
        durationMs: task.parsed.durationMs,
        switchIntervalMs: task.parsed.switchIntervalMs,
        startCapture: task.captureConfig?.enabled
          ? () => this.#ensureCapture(task)
          : null,
        sleep: (ms) => this.#sleep(ms, task),
        onStep: (stepIndex, label, totalSteps) => {
          this.#assertNotStopped(task);
          task.stepIndex = stepIndex;
          task.totalSteps = totalSteps;
          this.#log(task, label);
        },
      });
      task.validationMode = result.validationMode;
      task.validationChecks = result.validationChecks || [];
      task.effectiveDurationMs = result.effectiveDurationMs ?? null;
      task.stepIndex = result.replayStepIndex || task.stepIndex;
      return;
    }

    if (task.workflowId === KUAISHOU_LIVE_WORKFLOW_ID || app.id === 'kuaishou') {
      const result = await this.kuaishouLiveExecutor({
        device: this.adb,
        app,
        durationMs: task.parsed.durationMs,
        switchIntervalMs: task.parsed.switchIntervalMs,
        startCapture: task.captureConfig?.enabled
          ? () => this.#ensureCapture(task)
          : null,
        sleep: (ms) => this.#sleep(ms, task),
        onStep: (stepIndex, label, totalSteps) => {
          this.#assertNotStopped(task);
          task.stepIndex = stepIndex;
          task.totalSteps = totalSteps;
          this.#log(task, label);
        },
      });
      task.validationMode = result.validationMode;
      task.validationChecks = result.validationChecks || [];
      task.effectiveDurationMs = result.effectiveDurationMs ?? null;
      task.stepIndex = result.replayStepIndex || task.stepIndex;
      return;
    }

    const screen = await this.adb.getScreenSize().catch(() => null);
    const steps = buildLiveEntryPlan({
      app,
      durationMs: task.parsed.durationMs,
      switchIntervalMs: task.parsed.switchIntervalMs,
      screen: screen || undefined,
    });

    await this.#runSteps(task, steps);
  }

  async #aiChat(task) {
    const app = this.#resolveApp(task.parsed.appName);
    const deviceStatus = await this.adb.getDeviceStatus?.().catch(() => null);
    const screen = deviceStatus?.screen || (await this.adb.getScreenSize().catch(() => null));
    const planOptions = {
      app,
      durationMs: task.parsed.durationMs,
      intervalMs: task.parsed.intervalMs,
      messages: task.parsed.messages,
      screen: screen || undefined,
    };
    let steps;
    if (app.skill === 'xiaoyi_chat') {
      steps = buildXiaoyiChatPlan({
        ...planOptions,
        platform: deviceStatus?.platform,
      });
    } else if (app.skill === 'deepseek_chat') {
      steps = buildDeepseekChatPlan({
        ...planOptions,
        platform: deviceStatus?.platform,
      });
    } else if (app.skill === 'qianwen_chat') {
      steps = buildQianwenChatPlan({
        ...planOptions,
        platform: deviceStatus?.platform,
      });
    } else {
      steps = buildAiChatPlan(planOptions);
    }

    await this.#runSteps(task, steps);
  }

  async #runSteps(task, steps) {
    task.totalSteps = steps.length;

    for (const [index, step] of steps.entries()) {
      this.#assertNotStopped(task);
      task.stepIndex = index + 1;
      const executableStep = withReferenceScreen(
        step,
        task.deviceSession?.screen,
      );
      if (!executableStep.silent) {
        this.#log(task, executableStep.label || executableStep.type);
      }
      await this.#executeStep(executableStep, task);
    }
  }

  async #key(task, code, label) {
    this.#log(task, label);
    await this.adb.keyevent(code);
  }

  async #executeStep(step, task) {
    switch (step.type) {
      case 'start_capture':
        await this.#ensureCapture(task);
        return;
      case 'launch_app':
        await this.adb.launchPackage(step.packageName);
        return;
      case 'start_activity':
        await this.adb.startActivity(step);
        return;
      case 'force_stop':
        await this.adb.forceStopPackage(step.packageName);
        return;
      case 'keyevent':
        await this.adb.keyevent(step.code);
        return;
      case 'open_home_app':
        await this.#openHomeApp(step, task);
        return;
      case 'wait':
        await this.#sleep(step.ms, task);
        return;
      case 'wait_for_screen_idle':
        await this.#waitForScreenIdle(step, task);
        return;
      case 'open_uri':
        await this.adb.openUri(step);
        return;
      case 'tap':
        await this.adb.tap(step);
        return;
      case 'tap_until_orientation':
        await this.#tapUntilOrientation(step, task);
        return;
      case 'swipe':
        await this.adb.swipe(step);
        return;
      case 'tap_resource':
        await this.adb.tapResource(step.resourceId, { optional: Boolean(step.optional) });
        return;
      case 'tap_text':
        await this.adb.tapText(step.texts || step.text, {
          optional: Boolean(step.optional),
          partial: Boolean(step.partial),
        });
        return;
      case 'tap_text_region':
        await this.adb.tapTextInRegion(step.texts || step.text, {
          optional: Boolean(step.optional),
          partial: Boolean(step.partial),
          region: step.region,
        });
        return;
      case 'tap_if_ui_text_matches':
        await this.#tapIfUiTextMatches(step);
        return;
      case 'tap_if_ui_text_not_matches':
        await this.#tapIfUiTextNotMatches(step);
        return;
      case 'assert_no_sensitive_prompt':
        await this.adb.assertNoSensitivePrompt();
        return;
      case 'assert_foreground_package':
        await this.#assertForegroundPackage(step);
        return;
      case 'assert_orientation':
        await this.#assertOrientation(step);
        return;
      case 'assert_media_playing':
        await this.#assertMediaPlaying(step);
        return;
      case 'assert_ui_text':
        if (step.retries || step.retryIntervalMs) {
          await this.#waitForUiText(step, task);
        } else {
          await this.#assertUiText(step);
        }
        return;
      case 'assert_ui_node':
        await this.#assertUiNode(step);
        return;
      case 'assert_ui_text_or_activity':
        await this.#assertUiTextOrActivity(step);
        return;
      case 'swipe_while_ui_text_matches':
        await this.#swipeWhileUiTextMatches(step, task);
        return;
      case 'swipe_if_ui_text_not_matches':
        await this.#swipeIfUiTextNotMatches(step);
        return;
      case 'tap_if_activity_not_matches':
        await this.#tapIfActivityNotMatches(step);
        return;
      case 'swipe_if_activity_not_matches':
        await this.#swipeIfActivityNotMatches(step);
        return;
      case 'assert_screen_changes':
        await this.#assertScreenChanges(step, task);
        return;
      case 'manual_confirm':
        await this.#manualConfirm(step, task);
        return;
      case 'input_text':
        await this.adb.inputText(step.text, {
          clearExisting: Boolean(step.clearExisting),
          x: step.x,
          y: step.y,
          target: step.target,
          anchor: step.anchor,
          referenceScreen: step.referenceScreen,
        });
        return;
      case 'input_key_text':
        await this.adb.inputKeyText(step.text, {
          clearExisting: Boolean(step.clearExisting),
          clearCharacters: step.clearCharacters,
        });
        return;
      case 'send_ui_message':
        await executeUiMessage({
          device: this.adb,
          message: step.text,
          inputResourceId: step.inputResourceId,
          sendResourceId: step.sendResourceId,
          attempts: step.attempts,
          readyChecks: step.readyChecks,
          confirmationChecks: step.confirmationChecks,
          pollMs: step.pollMs,
          focusWaitMs: step.focusWaitMs,
          confirmOnEditorClear: Boolean(step.confirmOnEditorClear),
          sleep: (ms) => this.#sleep(ms, task),
          onRetry: ({ nextAttempt, reason }) => {
            this.#log(
              task,
              `Retrying message send (${nextAttempt}/${step.attempts || 3}): ${reason}`,
            );
          },
        });
        return;
      case 'loop_text_messages':
        await this.#loopTextMessages(step, task);
        return;
      case 'complete':
        return;
      default:
        throw new Error(`unknown step type: ${step.type}`);
    }
  }

  async #ensureCapture(task) {
    if (!task.captureConfig?.enabled || task.captureSession) return;
    if (!this.captureManager) throw new Error('采集功能尚未配置');

    const captureSession = await this.#startCapture(task, task.captureConfig);
    task.captureSession = captureSession;
    task.capture = captureSession;
    this.#log(task, `采集已启动: ${captureSession.outputDir}`);
  }

  #resolveApp(appName) {
    const app = findAppByName(this.apps, appName);
    if (!app) throw new Error(`未找到应用: ${appName}`);
    if (!app.packageName) throw new Error(`${app.name} 缺少 packageName`);
    return app;
  }

  async #assertForegroundPackage(step) {
    const expected = step.packageName;
    const focus = await this.adb.getCurrentFocus?.().catch(() => null);
    if (expected && focus?.packageName !== expected) {
      throw new Error(`当前前台应用为 ${focus?.packageName || 'unknown'}，不是预期的 ${expected}`);
    }

    if (step.activityAny && !this.#matchesAny(focus?.activity || '', step.activityAny)) {
      throw new Error(step.message || `当前 Activity ${focus?.activity || 'unknown'} 不符合预期`);
    }
  }

  async #assertOrientation(step) {
    const orientation = await this.adb.getDisplayOrientation?.().catch(() => null);
    if (step.landscape && !orientation?.isLandscape) {
      if (step.optional) return;
      throw new Error(step.message || `屏幕未进入横屏全屏，当前方向 ${orientation?.raw || 'unknown'}`);
    }
  }

  async #assertMediaPlaying(step) {
    const state = await this.adb.getMediaPlaybackState?.(step.packageName).catch(() => null);
    if (state?.isPlaying) return;
    if (step.optional) return;
    const current = state?.stateName ? `${state.stateName}(${state.stateCode})` : 'unknown';
    throw new Error(step.message || `${step.packageName || '当前应用'} 未检测到播放状态，当前媒体状态 ${current}`);
  }

  async #tapUntilOrientation(step, task) {
    const attempts = Math.max(1, Number(step.attempts) || 1);
    const taps = step.taps?.length ? step.taps : [step];
    const waitMs = Math.max(200, Number(step.afterTapWaitMs) || 1000);

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const orientation = await this.adb.getDisplayOrientation?.().catch(() => null);
      if (step.landscape && orientation?.isLandscape) return;

      const tap = taps[attempt % taps.length];
      await this.adb.tap({
        ...tap,
        referenceScreen: tap.referenceScreen || step.referenceScreen,
      });
      await this.#sleep(waitMs, task);
    }

    const orientation = await this.adb.getDisplayOrientation?.().catch(() => null);
    if (step.landscape && orientation?.isLandscape) return;
    if (step.optional) return;
    throw new Error(step.message || `屏幕未进入目标方向，当前方向 ${orientation?.raw || 'unknown'}`);
  }

  async #openHomeApp(step, task) {
    if (
      typeof this.adb.getUiTextSnapshot !== 'function' ||
      typeof this.adb.tap !== 'function' ||
      typeof this.adb.swipe !== 'function'
    ) {
      throw new Error('当前设备适配器不支持动态桌面应用查找');
    }

    const screen =
      task.deviceSession?.screen ||
      (await this.adb.getScreenSize().catch(() => null));
    if (!screen?.width || !screen?.height) {
      throw new Error('无法获取屏幕尺寸，不能遍历鸿蒙桌面');
    }

    const maxPages = Math.max(1, Math.min(12, Number(step.maxPages) || 8));
    const settleMs = Math.max(250, Number(step.settleMs) || 500);
    const target = {
      resourceId: step.resourceId,
      texts: step.texts || step.text,
    };
    const successIds = Array.isArray(step.successIds)
      ? step.successIds.filter(Boolean)
      : [];

    const activateTarget = async (node) => {
      await this.adb.tap({ x: node.centerX, y: node.centerY });
      if (!successIds.length) return;

      await this.#sleep(Math.max(500, Number(step.activationCheckMs) || 1000), task);
      const snapshot = await this.adb.getUiTextSnapshot();
      const reachedTarget = successIds.some((resourceId) =>
        findHarmonyHomeTarget(snapshot.layout, { resourceId }),
      );
      if (reachedTarget) return;

      const retryNode = findHarmonyHomeTarget(snapshot.layout, target);
      if (retryNode) {
        await this.adb.tap({ x: retryNode.centerX, y: retryNode.centerY });
      }
    };

    const tryCurrentPage = async () => {
      this.#assertNotStopped(task);
      const snapshot = await this.adb.getUiTextSnapshot();
      let node = findHarmonyHomeTarget(snapshot.layout, target);
      if (node) {
        await activateTarget(node);
        return true;
      }

      for (const folder of findHarmonyHomeFolders(snapshot.layout)) {
        this.#assertNotStopped(task);
        await this.adb.tap({ x: folder.centerX, y: folder.centerY });
        await this.#sleep(settleMs, task);

        const folderSnapshot = await this.adb.getUiTextSnapshot();
        node = findHarmonyHomeTarget(folderSnapshot.layout, target);
        if (node) {
          await activateTarget(node);
          return true;
        }

        await this.adb.keyevent('KEYCODE_BACK');
        await this.#sleep(300, task);
      }
      return false;
    };

    if (await tryCurrentPage()) return;

    for (let page = 0; page < maxPages; page += 1) {
      await this.adb.swipe(buildHarmonyHomePageSwipe(screen, 'left'));
      await this.#sleep(settleMs, task);
      if (await tryCurrentPage()) return;
    }

    for (let page = 0; page < maxPages; page += 1) {
      await this.adb.swipe(buildHarmonyHomePageSwipe(screen, 'right'));
      await this.#sleep(settleMs, task);
      if (await tryCurrentPage()) return;
    }

    throw new Error(
      `遍历鸿蒙桌面后仍未找到应用资源: ${step.resourceId || step.texts || step.text}`,
    );
  }

  async #assertUiText(step) {
    let snapshot = null;
    try {
      snapshot = await this.adb.getUiTextSnapshot();
    } catch (error) {
      if (step.optional) return;
      throw error;
    }
    const text = snapshot.text || '';

    if (step.any && !this.#matchesAny(text, step.any)) {
      if (step.optional) return;
      throw new Error(step.message || `屏幕未出现预期内容: ${this.#describeMatchers(step.any)}`);
    }

    if (step.all && !this.#matchesAll(text, step.all)) {
      if (step.optional) return;
      throw new Error(step.message || `屏幕缺少预期内容: ${this.#describeMatchers(step.all)}`);
    }

    if (step.none && this.#matchesAny(text, step.none)) {
      if (step.optional) return;
      throw new Error(step.message || `屏幕出现了不应出现的内容: ${this.#describeMatchers(step.none)}`);
    }
  }

  async #waitForUiText(step, task) {
    const retries = Math.max(1, Math.min(30, Number(step.retries) || 1));
    const intervalMs = Math.max(100, Number(step.retryIntervalMs) || 500);
    let lastError = null;

    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        const snapshot = await this.adb.getUiTextSnapshot();
        const text = snapshot.text || '';
        const matches =
          (!step.any || this.#matchesAny(text, step.any)) &&
          (!step.all || this.#matchesAll(text, step.all)) &&
          (!step.none || !this.#matchesAny(text, step.none));
        if (matches) return;
        lastError = new Error(
          step.message || `屏幕未出现预期内容 ${this.#describeMatchers(step.any || step.all || step.none)}`,
        );
      } catch (error) {
        lastError = error;
      }

      if (attempt < retries - 1) await this.#sleep(intervalMs, task);
    }

    if (step.optional) return;
    throw lastError || new Error(step.message || '屏幕未出现预期内容');
  }

  async #assertUiNode(step) {
    if (typeof this.adb.findUiNode !== 'function') {
      if (step.optional) return;
      throw new Error('当前设备适配器不支持 UI 节点检测');
    }
    const node = await this.adb.findUiNode({
      types: step.types,
      ids: step.ids,
      keys: step.keys,
      clickable: step.clickable,
    });
    if (!node && !step.optional) {
      throw new Error(step.message || '屏幕未出现预期 UI 节点');
    }
  }

  async #loopTextMessages(step, task) {
    const messages = Array.isArray(step.messages)
      ? step.messages.map((message) => String(message || '').trim()).filter(Boolean)
      : [];
    if (!messages.length) throw new Error('循环发消息缺少消息列表');

    const durationMs = Math.max(1000, Number(step.durationMs) || 1000);
    const intervalMs = Math.max(3000, Number(step.intervalMs) || 8000);
    const input = step.input || {};
    const send = step.send || {};

    await this.adb.tap({
      ...input,
      referenceScreen: input.referenceScreen || step.referenceScreen,
    });
    await this.#sleep(600, task);

    const startedAt = Date.now();
    const deadline = startedAt + durationMs;
    let nextSendAt = startedAt;
    let sentCount = 0;

    while (sentCount === 0 || nextSendAt < deadline) {
      const waitMs = nextSendAt - Date.now();
      if (waitMs > 0) await this.#sleep(waitMs, task);
      this.#assertNotStopped(task);

      const message = messages[sentCount % messages.length];
      this.#log(task, `发送微信测试消息 ${sentCount + 1}`);
      await this.adb.inputText(message, { clearExisting: true });
      await this.#sleep(300, task);
      await this.adb.tap({
        ...send,
        referenceScreen: send.referenceScreen || step.referenceScreen,
      });
      await this.#sleep(600, task);

      if (sentCount === 0) {
        const snapshot = await this.adb.getUiTextSnapshot();
        const editor = await this.adb.findUiNode({
          types: step.editorTypes || ['RichEditor'],
          layout: snapshot.layout,
        });
        const editorText = String(editor?.attributes?.text || editor?.attributes?.originalText || '');
        if (!String(snapshot?.text || '').includes(message) || editorText) {
          throw new Error('微信首条测试消息未形成消息气泡，停止循环发送');
        }
      }

      sentCount += 1;
      nextSendAt = startedAt + sentCount * intervalMs;
    }

    this.#log(task, `微信循环发送结束，共发送 ${sentCount} 条`);
  }

  async #tapIfUiTextMatches(step) {
    let snapshot = null;
    try {
      snapshot = await this.adb.getUiTextSnapshot();
    } catch (error) {
      if (step.optional) return;
      throw error;
    }
    if (!this.#matchesAny(snapshot.text || '', step.matches || step.any || [])) return;
    await this.adb.tap(step);
  }

  async #tapIfUiTextNotMatches(step) {
    let snapshot = null;
    try {
      snapshot = await this.adb.getUiTextSnapshot();
    } catch (error) {
      if (step.optional) return;
      throw error;
    }
    if (this.#matchesAny(snapshot.text || '', step.matches || step.any || [])) return;
    await this.adb.tap(step);
  }

  async #assertUiTextOrActivity(step) {
    const focus = await this.adb.getCurrentFocus?.().catch(() => null);
    if (step.packageName && focus?.packageName !== step.packageName) {
      throw new Error(`当前前台应用为 ${focus?.packageName || 'unknown'}，不是预期的 ${step.packageName}`);
    }
    if (this.#matchesAny(focus?.activity || '', step.activityAny || [])) return;
    await this.#assertUiText(step);
  }

  async #swipeWhileUiTextMatches(step, task) {
    const maxSwipes = Number.isFinite(Number(step.maxSwipes)) ? Number(step.maxSwipes) : 3;
    for (let attempt = 0; attempt <= maxSwipes; attempt += 1) {
      const snapshot = await this.adb.getUiTextSnapshot();
      if (!this.#matchesAny(snapshot.text || '', step.matches || [])) return;

      if (attempt >= maxSwipes) {
        if (step.required === false) return;
        throw new Error(step.message || `连续 ${maxSwipes} 次跳过后仍未进入目标内容`);
      }

      this.#log(task, `${step.swipeLabel || '检测到非目标内容，跳过'} ${attempt + 1}/${maxSwipes}`);
      await this.adb.swipe(step);
      await this.#sleep(step.afterSwipeWaitMs || 1000, task);
    }
  }

  async #swipeIfUiTextNotMatches(step) {
    const focus = await this.adb.getCurrentFocus?.().catch(() => null);
    if (this.#matchesAny(focus?.activity || '', step.activityAny || [])) return;

    const snapshot = await this.adb.getUiTextSnapshot();
    if (this.#matchesAny(snapshot.text || '', step.matches || step.any || [])) return;

    await this.adb.swipe(step);
  }

  async #tapIfActivityNotMatches(step) {
    const focus = await this.adb.getCurrentFocus?.().catch(() => null);
    if (this.#matchesAny(focus?.activity || '', step.activityAny || [])) return;
    await this.adb.tap(step);
  }

  async #swipeIfActivityNotMatches(step) {
    const focus = await this.adb.getCurrentFocus?.().catch(() => null);
    if (this.#matchesAny(focus?.activity || '', step.activityAny || [])) return;
    await this.adb.swipe(step);
  }

  async #waitForScreenIdle(step, task) {
    const maxMs = Math.max(500, Number(step.maxMs) || 8000);
    const minMs = Math.min(maxMs, Math.max(0, Number(step.minMs) || 3000));
    const pollMs = Math.min(maxMs, Math.max(500, Number(step.pollMs) || 1000));
    const stablePolls = Math.max(1, Number(step.stablePolls) || 2);
    const changeRatio = Number.isFinite(Number(step.changeDiffRatio)) ? Number(step.changeDiffRatio) : 0.0005;
    const idleRatio = Number.isFinite(Number(step.idleDiffRatio)) ? Number(step.idleDiffRatio) : 0.00025;

    if (!this.adb.screenshotPng) {
      await this.#sleep(maxMs, task);
      return;
    }

    let previous = await this.adb.screenshotPng();
    let sawChange = false;
    let stableCount = 0;
    const startedAt = Date.now();
    const deadline = startedAt + maxMs;

    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await this.#sleep(Math.min(pollMs, remaining), task);

      const current = await this.adb.screenshotPng();
      const ratio = estimateBufferDifference(previous, current);
      previous = current;

      if (ratio >= changeRatio) {
        sawChange = true;
        stableCount = 0;
        continue;
      }

      if (sawChange && Date.now() - startedAt >= minMs && ratio <= idleRatio) {
        stableCount += 1;
        if (stableCount >= stablePolls) return;
      }
    }
  }

  async #assertScreenChanges(step, task) {
    if (!this.adb.screenshotPng) {
      if (step.optional) return;
      throw new Error('当前 ADB 实现不支持截图检测');
    }

    const first = await this.adb.screenshotPng();
    await this.#sleep(step.intervalMs || 1500, task);
    const second = await this.adb.screenshotPng();
    const ratio = estimateBufferDifference(first, second);
    const minimum = Number.isFinite(Number(step.minDiffRatio)) ? Number(step.minDiffRatio) : 0.001;

    if (ratio < minimum) {
      if (step.optional) return;
      throw new Error(step.message || `屏幕变化不足，疑似未播放或未进入动态内容，变化率 ${ratio.toFixed(5)}`);
    }
  }

  async #manualConfirm(step, task) {
    task.pendingConfirmation = {
      message: step.message || step.label || '请在手机上完成手动操作后点击继续。',
      confirmLabel: step.confirmLabel || '确认完成，继续',
      createdAt: new Date().toISOString(),
      confirmed: false,
    };
    task.status = 'waiting_confirmation';
    this.#log(task, task.pendingConfirmation.message);

    while (!task.pendingConfirmation.confirmed) {
      await this.#sleep(500, task);
    }

    task.pendingConfirmation = null;
    task.status = 'running';
  }

  #matchesAny(text, matchers = []) {
    return normalizeMatchers(matchers).some((matcher) => matcherMatches(text, matcher));
  }

  #matchesAll(text, matchers = []) {
    return normalizeMatchers(matchers).every((matcher) => matcherMatches(text, matcher));
  }

  #describeMatchers(matchers = []) {
    return normalizeMatchers(matchers).map((matcher) => matcher.toString()).join('/');
  }

  async #sleep(ms, task) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      this.#assertNotStopped(task);
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, end - Date.now())));
    }
  }

  #assertNotStopped(task) {
    if (task.stopped) {
      task.status = 'stopped';
      task.finishedAt = new Date().toISOString();
      throw new TaskStoppedError();
    }
  }

  #log(task, message) {
    task.logs.push({
      at: new Date().toISOString(),
      message,
    });
  }
}

function withReferenceScreen(step, screen) {
  if (!screen || step.referenceScreen) return step;
  return {
    ...step,
    referenceScreen: {
      width: Number(screen.width),
      height: Number(screen.height),
    },
  };
}

function sanitizeDeviceSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    provider: session.provider,
    platform: session.platform,
    serial: session.serial || '',
    model: session.model || '',
    screen: session.screen || null,
  };
}

class TaskStoppedError extends Error {
  constructor() {
    super('task stopped');
  }
}

export function inferBusinessName(parsed = {}) {
  switch (parsed.intent) {
    case 'watch_feed':
    case 'wechat_channels_feed':
      return '短视频';
    case 'wechat_send_messages':
    case 'wechat_send_media':
      return '传输';
    case 'xunlei_upload_media':
      return '上传下载';
    case 'xunlei_download':
      return '上传下载';
    case 'app_store_download':
      return '上传下载';
    case 'baidu_netdisk_download':
      return '上传下载';
    case 'wechat_voip_call':
    case 'qq_voip_call':
    case 'dingtalk_voip_call':
    case 'wecom_voip_call':
    case 'welink_voip_call':
      return 'VoIP';
    case 'tencent_quick_meeting':
    case 'tencent_join_meeting':
    case 'dingtalk_quick_meeting':
    case 'dingtalk_join_meeting':
    case 'feishu_quick_meeting':
    case 'feishu_join_meeting':
      return '会议';
    case 'watch_live':
    case 'live_entry':
      return '直播';
    case 'play_tencent_video':
    case 'play_generic_media':
      return '长视频';
    case 'ai_chat':
    case 'doubao_chat':
      return 'AI应用';
    case 'amap_navigation':
      return '导航';
    case 'launch_app':
      return '启动';
    default:
      return parsed.intent || '未分类';
  }
}

function sanitizeTaskParameters(schema, values) {
  const result = {};
  for (const parameter of schema) {
    if (!(parameter.id in (values || {}))) continue;
    result[parameter.id] = parameter.sensitive ? '[已隐藏]' : values[parameter.id];
  }
  return result;
}

function sanitizeParsedTask(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  return {
    ...parsed,
    ...(parsed.meetingPassword
      ? { meetingPassword: '[已隐藏]' }
      : {}),
      };
}

export function applyWorkflowParameters(
  parsed,
  { workflowId = null, parameters = {} } = {},
) {
  if (workflowId === XUNLEI_UPLOAD_MEDIA_WORKFLOW_ID) {
    return {
      ...parsed,
      intent: 'xunlei_upload_media',
      appName: '迅雷',
    };
  }
  if (workflowId === XUNLEI_DOWNLOAD_WORKFLOW_ID) {
    return {
      ...parsed,
      intent: 'xunlei_download',
      appName: '迅雷',
      magnetUrl: String(parameters.magnetUrl || parsed?.magnetUrl || DEFAULT_XUNLEI_MAGNET).trim(),
      durationMs: durationParameterToMs(parameters.duration, parsed?.durationMs ?? 30000),
    };
  }
  if (workflowId === APP_STORE_DOWNLOAD_WORKFLOW_ID) {
    return {
      ...parsed,
      intent: 'app_store_download',
      appName: '应用市场',
      targetApp: String(parameters.targetApp || parsed?.targetApp || DEFAULT_APP_STORE_TARGET).trim(),
      durationMs: durationParameterToMs(parameters.duration, parsed?.durationMs ?? 30000),
    };
  }
  if (workflowId === BAIDU_NETDISK_DOWNLOAD_WORKFLOW_ID) {
    return {
      ...parsed,
      intent: 'baidu_netdisk_download',
      appName: '百度网盘',
      durationMs: durationParameterToMs(parameters.duration, parsed?.durationMs ?? 30000),
    };
  }
  if (workflowId === BAIDU_NETDISK_UPLOAD_WORKFLOW_ID) {
    return { ...parsed, intent: 'baidu_netdisk_upload', appName: '百度网盘', mediaType: parameters.mediaType || 'image' };
  }
  if ([WELINK_AUDIO_CALL_WORKFLOW_ID, WELINK_VIDEO_CALL_WORKFLOW_ID].includes(workflowId)) {
    return {
      ...parsed,
      intent: 'welink_voip_call',
      appName: 'welink',
      targetMode: 'first',
      callType: workflowId === WELINK_VIDEO_CALL_WORKFLOW_ID ? 'video' : 'audio',
      durationMs: durationParameterToMs(parameters.duration, parsed?.durationMs ?? 30000),
      camera: Boolean(parameters.camera ?? parsed?.camera),
      shareScreen: Boolean(parameters.shareScreen ?? parsed?.shareScreen),
    };
  }
  if (['voip:dingtalk:audio-call', 'voip:dingtalk:video-call', 'voip:wecom:audio-call', 'voip:wecom:video-call'].includes(workflowId)) {
    const video = workflowId.endsWith(':video-call');
    const wecom = workflowId.startsWith('voip:wecom:');
    return { ...parsed, intent: wecom ? 'wecom_voip_call' : 'dingtalk_voip_call', appName: wecom ? '企业微信' : '钉钉', targetMode: 'first',
      callType: video ? 'video' : 'audio', durationMs: durationParameterToMs(parameters.duration, parsed?.durationMs ?? 30000),
      camera: video && Boolean(parameters.camera ?? parsed?.camera),
      shareScreen: video && Boolean(parameters.shareScreen ?? parsed?.shareScreen) };
  }
  if (workflowId === DINGTALK_QUICK_MEETING_WORKFLOW_ID) {
    const meetingType = parameters.meetingType ?? parsed?.meetingType ?? 'video';
    return { ...parsed, intent: 'dingtalk_quick_meeting', appName: '钉钉', meetingType,
      durationMs: durationParameterToMs(parameters.duration, parsed?.durationMs ?? 30000),
      camera: meetingType === 'video' && Boolean(parameters.camera ?? parsed?.camera),
      shareScreen: Boolean(parameters.shareScreen ?? parsed?.shareScreen) };
  }
  if ([FEISHU_QUICK_MEETING_WORKFLOW_ID, FEISHU_JOIN_MEETING_WORKFLOW_ID].includes(workflowId)) {
    return { ...parsed, intent: workflowId === FEISHU_JOIN_MEETING_WORKFLOW_ID ? 'feishu_join_meeting' : 'feishu_quick_meeting', appName: '飞书',
      meetingId: String(parameters.meetingId ?? parsed?.meetingId ?? '').replace(/[\s-]/g, ''),
      durationMs: durationParameterToMs(parameters.duration, parsed?.durationMs ?? 30000),
      camera: Boolean(parameters.camera ?? parsed?.camera), shareScreen: Boolean(parameters.shareScreen ?? parsed?.shareScreen) };
  }
  if (workflowId === DINGTALK_JOIN_MEETING_WORKFLOW_ID) {
    return { ...parsed, intent: 'dingtalk_join_meeting', appName: '钉钉', meetingType: 'video',
      meetingId: String(parameters.meetingId ?? parsed?.meetingId ?? '').replace(/[\s-]/g, ''),
      durationMs: durationParameterToMs(parameters.duration, parsed?.durationMs ?? 30000),
      camera: Boolean(parameters.camera ?? parsed?.camera),
      shareScreen: Boolean(parameters.shareScreen ?? parsed?.shareScreen) };
  }
  if (workflowId === 'short-video:bilibili:short-video-feed') {
    return { ...parsed, intent: 'watch_feed', appName: 'B站',
      durationMs: durationParameterToMs(parameters.duration, parsed?.durationMs ?? 300000) };
  }
  if (workflowId === TENCENT_QUICK_MEETING_WORKFLOW_ID) {
    const { reason: _unsupportedReason, ...parsedTask } = parsed || {};
    return {
      ...parsedTask,
      intent: 'tencent_quick_meeting',
      appName: '腾讯会议',
      durationMs: meetingDurationParameterToMs(parameters.duration, {
        defaultMs: parsed?.durationMs ?? 30 * 1000,
      }),
      camera: Boolean(parameters.camera ?? parsed?.camera),
      shareScreen: Boolean(parameters.shareScreen ?? parsed?.shareScreen),
    };
  }
  if (workflowId === TENCENT_JOIN_MEETING_WORKFLOW_ID) {
    const { reason: _unsupportedReason, ...parsedTask } = parsed || {};
    return {
      ...parsedTask,
      intent: 'tencent_join_meeting',
      appName: '腾讯会议',
      meetingId: String(parameters.meetingId ?? parsed?.meetingId ?? '').trim(),
      meetingPassword:
        String(
          parameters.meetingPassword ?? parsed?.meetingPassword ?? '',
        ).trim() || null,
      durationMs: meetingDurationParameterToMs(parameters.duration, {
        defaultMs: parsed?.durationMs ?? 30 * 1000,
      }),
      camera: Boolean(parameters.camera ?? parsed?.camera),
      shareScreen: Boolean(parameters.shareScreen ?? parsed?.shareScreen),
    };
  }
  if (['voip:qq:audio-call', 'voip:qq:video-call'].includes(workflowId)) {
    return { ...parsed, intent: 'qq_voip_call', appName: 'QQ', targetMode: 'first',
      callType: workflowId.endsWith(':video-call') ? 'video' : 'audio',
      durationMs: durationParameterToMs(parameters.duration, parsed?.durationMs ?? 30000) };
  }
  if (isWechatVoipWorkflowId(workflowId)) {
    return {
      ...parsed,
      intent: 'wechat_voip_call',
      appName: '微信',
      targetMode: 'first',
      callType: callTypeForWechatWorkflow(workflowId),
      durationMs: durationParameterToMs(
        parameters.duration,
        parsed?.durationMs ?? 30 * 1000,
      ),
    };
  }
  if (String(workflowId || '').startsWith('live:')) {
    const configuredSwitchIntervalMs = parameters.switchInterval
      ? durationParameterToMs(
          parameters.switchInterval,
          parsed?.switchIntervalMs ?? 3 * 60 * 1000,
        )
      : parsed?.switchIntervalMs ?? null;
    return {
      ...parsed,
      durationMs: durationParameterToMs(
        parameters.duration,
        parsed?.durationMs ?? 10 * 60 * 1000,
      ),
      switchIntervalMs:
        configuredSwitchIntervalMs === null
          ? null
          : Math.max(MIN_LIVE_SWITCH_INTERVAL_MS, configuredSwitchIntervalMs),
    };
  }
  if (workflowId !== WECHAT_MEDIA_WORKFLOW_ID) return parsed;

  const requestedMode = parameters.sendMode ?? parsed?.sendMode;
  const sendMode = requestedMode === 'duration' ? 'duration' : 'count';
  const intervalMs = durationParameterToMs(
    parameters.interval,
    parsed?.intervalMs ?? 8000,
  );
  return {
    ...parsed,
    intent: 'wechat_send_media',
    appName: '微信',
    targetMode: 'first',
    mediaIndex: 0,
    sendMode,
    sendCount:
      sendMode === 'count'
        ? positiveInteger(parameters.count ?? parsed?.sendCount, 3)
        : null,
    durationMs:
      sendMode === 'duration'
        ? durationParameterToMs(
            parameters.duration,
            parsed?.durationMs ?? 5 * 60 * 1000,
          )
        : null,
    intervalMs,
  };
}

function durationParameterToMs(value, fallbackMs) {
  if (!value || typeof value !== 'object') {
    return Math.max(1, Math.round(Number(fallbackMs) || 1));
  }
  const amount = Number(value.amount);
  const factors = {
    毫秒: 1,
    秒: 1000,
    分钟: 60 * 1000,
    小时: 60 * 60 * 1000,
  };
  const factor = factors[value.unit] || 1000;
  if (!Number.isFinite(amount) || amount <= 0) {
    return Math.max(1, Math.round(Number(fallbackMs) || 1));
  }
  return Math.max(1, Math.round(amount * factor));
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.max(1, Math.round(number))
    : fallback;
}

function normalizeMatchers(matchers) {
  if (!matchers) return [];
  return Array.isArray(matchers) ? matchers : [matchers];
}

function matcherMatches(text, matcher) {
  if (matcher instanceof RegExp) return matcher.test(text);
  return text.includes(String(matcher));
}

function estimateBufferDifference(first, second) {
  const a = Buffer.from(first || []);
  const b = Buffer.from(second || []);
  const length = Math.min(a.length, b.length);
  if (!length) return 0;

  const sampleCount = Math.min(200000, length);
  const stride = Math.max(1, Math.floor(length / sampleCount));
  let checked = 0;
  let different = Math.abs(a.length - b.length) > Math.max(128, length * 0.001) ? 1 : 0;

  for (let index = 0; index < length; index += stride) {
    checked += 1;
    if (a[index] !== b[index]) different += 1;
  }

  return checked > 0 ? different / checked : 0;
}
