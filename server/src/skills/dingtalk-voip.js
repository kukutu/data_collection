import { dingtalkNodes, tapDingtalkNode, openDingtalkFirstConversation } from './dingtalk-call-entry.js';
import { startCaptureBeforeAction } from './capture-timing.js';
import { executeDingtalkVideoCall } from './dingtalk-meeting.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function inspectDingtalkAudioCall(snapshot) {
  const all = dingtalkNodes(snapshot);
  const label = all.find(n => n.text === '挂断');
  const parent = label?.parents.at(-1);
  const button = parent?.node.children?.flatMap(n => dingtalkNodes({ layout: n }))
    .find(n => n.clickable === 'true');
  return { hangup: button, connected: Boolean(label) && snapshot.values.some(v => /^\d{2,}:\d{2}$/.test(v)),
    chat: all.some(n => n.id === 'chat_bar_menu_tele') };
}

export async function executeDingtalkVoipCall(options) {
  const { device, app, callType, durationMs = 30000, startCapture,
    sleep = pause, now = Date.now, onStep = () => {} } = options;
  if (app?.id !== 'dingtalk' || !['audio', 'video'].includes(callType)) throw new Error('钉钉通话类型无效');
  if (callType === 'video') return executeDingtalkVideoCall(options);
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('钉钉通话时长无效');
  const effectiveDurationMs = Math.min(durationMs, 7200000);
  const snapshot = () => device.getUiTextSnapshot({ attempts: 2, timeoutMs: 8000 });
  const foreground = async () => {
    const f = await device.getCurrentFocus();
    if (![app.packageName, app.harmonyBundleName].includes(f.packageName)) throw new Error('已离开钉钉');
  };
  let initiated = false, failure;
  const hangup = async () => {
    for (let i = 0; i < 6; i++) {
      await foreground();
      const state = inspectDingtalkAudioCall(await snapshot());
      if (state.chat) { initiated = false; return; }
      if (state.hangup) await tapDingtalkNode(device, state.hangup);
      await pause(500);
    }
    throw new Error('未确认钉钉语音通话正常挂断');
  };
  try {
    onStep(1, '打开钉钉消息页第一个会话');
    await device.launchPackage(app.packageName);
    await sleep(1500);
    await foreground();
    await openDingtalkFirstConversation({ device, sleep });
    const s = await snapshot();
    const entry = dingtalkNodes(s).find(n => n.text === '语音通话');
    if (!entry) throw new Error('未找到语音通话入口');
    await startCaptureBeforeAction(startCapture, sleep);
    await tapDingtalkNode(device, entry);
    initiated = true;
    onStep(2, '等待对方接听钉钉语音通话');
    let connected = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      await foreground();
      const state = inspectDingtalkAudioCall(await snapshot());
      if (state.connected) { connected = true; break; }
      if (state.chat) throw new Error('对方未接听或通话已结束');
    }
    if (!connected) throw new Error('等待接听超时');
    onStep(3, '钉钉语音已接通，开始计时和采集');
    const started = now();
    while (now() - started < effectiveDurationMs) {
      await sleep(Math.min(5000, effectiveDurationMs - (now() - started)));
      await foreground();
      if (!inspectDingtalkAudioCall(await snapshot()).connected) throw new Error('钉钉语音通话已中断');
    }
    onStep(4, '正常挂断钉钉语音通话');
    await hangup();
    return { validationMode: 'dingtalk_audio_call_v1', effectiveDurationMs,
      validationChecks: ['call_connected', 'duration_observed', 'normal_hangup'].map(id => ({ id, status: 'passed' })) };
  } catch (error) { failure = error; throw error; }
  finally {
    if (initiated) {
      try { await hangup(); } catch (error) {
        if (failure) throw new AggregateError([failure, error], `${failure.message}；挂断失败：${error.message}`);
        throw error;
      }
    }
  }
}
