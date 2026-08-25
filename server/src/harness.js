import { randomUUID } from 'node:crypto';

import { findAppByName } from './app-registry.js';
import { parseTaskWithCodexCli, parseTaskWithModel } from './llm.js';
import { parseTaskFallback } from './task-parser.js';
import { evaluateSafety } from './safety.js';
import { buildAiChatPlan } from './skills/ai-chat.js';
import { buildDoubaoChatPlan } from './skills/doubao-chat.js';
import { buildLiveStreamPlan } from './skills/live-stream.js';
import { buildShortVideoPlan } from './skills/short-video.js';
import { buildAmapNavigationPlan } from './skills/amap-navigation.js';
import { buildGenericMediaPlaybackPlan } from './skills/generic-media.js';
import { buildLiveEntryPlan } from './skills/live-entry.js';
import { buildTencentVideoPlaybackPlan } from './skills/tencent-video.js';
import { buildWechatChannelsPlan } from './skills/wechat-channels.js';

export class TaskManager {
  constructor({ adb, apps }) {
    this.adb = adb;
    this.apps = apps;
    this.tasks = new Map();
  }

  start({ taskText, apiKey, useModel = false, parseMode }) {
    const task = {
      id: randomUUID(),
      input: taskText,
      status: 'running',
      stepIndex: 0,
      totalSteps: 0,
      logs: [],
      startedAt: new Date().toISOString(),
      stopped: false,
      pendingConfirmation: null,
    };

    this.tasks.set(task.id, task);
    this.#run(task, { apiKey, useModel, parseMode }).catch((error) => {
      if (task.status === 'stopped') return;
      task.status = 'failed';
      task.error = error.message;
      this.#log(task, `失败: ${error.message}`);
    });

    return this.snapshot(task.id);
  }

  snapshot(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    return {
      id: task.id,
      input: task.input,
      status: task.status,
      parsed: task.parsed,
      stepIndex: task.stepIndex,
      totalSteps: task.totalSteps,
      logs: task.logs.slice(-200),
      error: task.error,
      pendingConfirmation: task.pendingConfirmation,
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

  async #run(task, { apiKey, useModel, parseMode }) {
    this.#log(task, '开始解析任务');
    task.parsed = await this.#parse(task.input, { apiKey, useModel, parseMode });
    this.#log(task, `解析结果: ${JSON.stringify(task.parsed)}`);

    const safety = evaluateSafety(task.parsed, task.input);
    if (!safety.allowed) {
      task.status = 'blocked';
      task.error = safety.reason;
      task.finishedAt = new Date().toISOString();
      this.#log(task, safety.reason);
      return;
    }

    await this.#execute(task);

    if (task.status !== 'stopped') {
      task.status = 'completed';
      task.finishedAt = new Date().toISOString();
      this.#log(task, '任务完成');
    }
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
  }

  async #watchFeed(task) {
    const app = this.#resolveApp(task.parsed.appName);
    if (app.skill !== 'short_video_feed') {
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

    const steps = buildDoubaoChatPlan({
      app,
      durationMs: task.parsed.durationMs,
      intervalMs: task.parsed.intervalMs,
      messages: task.parsed.messages,
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
    if (app.id !== 'wechat') {
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

  async #liveEntry(task) {
    const app = this.#resolveApp(task.parsed.appName);
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
    const screen = await this.adb.getScreenSize().catch(() => null);
    const steps = buildAiChatPlan({
      app,
      durationMs: task.parsed.durationMs,
      intervalMs: task.parsed.intervalMs,
      messages: task.parsed.messages,
      screen: screen || undefined,
    });

    await this.#runSteps(task, steps);
  }

  async #runSteps(task, steps) {
    task.totalSteps = steps.length;

    for (const [index, step] of steps.entries()) {
      this.#assertNotStopped(task);
      task.stepIndex = index + 1;
      if (!step.silent) {
        this.#log(task, step.label || step.type);
      }
      await this.#executeStep(step, task);
    }
  }

  async #key(task, code, label) {
    this.#log(task, label);
    await this.adb.keyevent(code);
  }

  async #executeStep(step, task) {
    switch (step.type) {
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
        await this.#assertUiText(step);
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
        await this.adb.inputText(step.text);
        return;
      case 'complete':
        return;
      default:
        throw new Error(`unknown step type: ${step.type}`);
    }
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
      await this.adb.tap(tap);
      await this.#sleep(waitMs, task);
    }

    const orientation = await this.adb.getDisplayOrientation?.().catch(() => null);
    if (step.landscape && orientation?.isLandscape) return;
    if (step.optional) return;
    throw new Error(step.message || `屏幕未进入目标方向，当前方向 ${orientation?.raw || 'unknown'}`);
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

class TaskStoppedError extends Error {
  constructor() {
    super('task stopped');
  }
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
