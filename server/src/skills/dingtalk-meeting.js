import { openDingtalkFirstConversation, dingtalkNodes } from './dingtalk-call-entry.js';

export const DINGTALK_QUICK_MEETING_WORKFLOW_ID = 'meeting:dingtalk:quick-meeting';
export const DINGTALK_JOIN_MEETING_WORKFLOW_ID = 'meeting:dingtalk:join-meeting';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function inspectDingtalkMeeting(snapshot) {
  const values = snapshot?.values || [];
  return {
    active: (values.includes('结束') || values.includes('离开')) && values.some(v => /^\d{2,}:\d{2}/.test(v)),
    camera: values.includes('关摄像头') ? true : values.includes('开摄像头') ? false : null,
    sharing: values.some(v => /停止共享|结束共享|正在共享(?:手机)?屏幕|你\s*正在共享/.test(v)),
    loggedOut: values.some(v => /服务协议、隐私权政策/.test(v)) && values.includes('下一步'),
  };
}

export function executeDingtalkQuickMeeting(options) {
  return executeDingtalkMeeting({ ...options, joining: false });
}

export function executeDingtalkJoinMeeting(options) {
  return executeDingtalkMeeting({ ...options, joining: true });
}

export function executeDingtalkVideoCall(options) {
  return executeDingtalkMeeting({ ...options, joining: false, calling: true, meetingType: 'video' });
}

async function executeDingtalkMeeting({
  device, app, meetingType = 'video', camera = false, shareScreen = false,
  joining = false, meetingId = '', calling = false,
  durationMs = 30000, startCapture, sleep = pause, now = Date.now, onStep = () => {},
}) {
  if (app?.id !== 'dingtalk') throw new Error('钉钉会议只能用于钉钉');
  meetingId = String(meetingId).replace(/[\s-]/g, '');
  if (joining && !/^\d{6,12}$/.test(meetingId)) throw new Error('请输入有效的钉钉会议号');
  if (!['audio', 'video'].includes(meetingType)) throw new Error('无效的会议类型');
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('无效的会议时长');
  durationMs = Math.min(durationMs, 2 * 60 * 60 * 1000);
  camera = meetingType === 'video' && Boolean(camera);
  const screen = await device.getScreenSize();
  let entered = false;
  let failure;
  const snapshot = () => device.getUiTextSnapshot({ attempts: 2, timeoutMs: 8000 });
  const has = (s, text) => s.values.includes(text);
  const peerConnected = s => Number(s.values[s.values.indexOf('成员') + 1]) >= 2;
  const tapSnapshot = async (s, text) => {
    let target;
    const visit = node => {
      const a = node?.attributes;
      if (a?.text === text && a.bounds) target = a;
      for (const child of node?.children || []) visit(child);
    };
    visit(s.layout);
    if (!target) return device.tapText(text);
    const b = target.bounds.match(/-?\d+/g)?.map(Number);
    if (!b || b.length !== 4) throw new Error(`无法定位控件：${text}`);
    await device.tap({ x: Math.round((b[0] + b[2]) / 2), y: Math.round((b[1] + b[3]) / 2) });
  };
  const foreground = async () => {
    const focus = await device.getCurrentFocus();
    if (![app.packageName, app.harmonyBundleName].filter(Boolean).includes(focus.packageName)) {
      throw new Error('已离开钉钉，停止会议操作');
    }
  };
  const controls = async () => {
    await foreground();
    let s = await snapshot();
    if (inspectDingtalkMeeting(s).loggedOut) throw new Error('钉钉已退出登录，请手动重新登录');
    if (!dingtalkNodes(s).some(n => n.id === 'chat_bar_menu_tele') && !has(s, '结束') && !has(s, '离开') && !has(s, '仅自己离开') && !has(s, '发起会议') && !has(s, '进入会议')) {
      await device.tap({ x: Math.round(screen.width * 0.5), y: Math.round(screen.height * 0.45) });
      s = await snapshot();
    }
    return s;
  };
  const endMeeting = async () => {
    for (let i = 0; i < 6; i++) {
      let s = await controls();
      if (calling && dingtalkNodes(s).some(n => n.id === 'chat_bar_menu_tele')) { entered = false; return; }
      if (has(s, '发起会议') && !has(s, '结束') && !has(s, '离开')) { entered = false; return; }
      if (joining && has(s, '仅自己离开')) await tapSnapshot(s, '仅自己离开');
      else if (!joining && has(s, '全员结束会议')) await tapSnapshot(s, '全员结束会议');
      else if (has(s, '取消') && (has(s, '选择共享内容') || has(s, '发起屏幕共享'))) {
        await tapSnapshot(s, '取消');
      } else if (joining && has(s, '离开')) await tapSnapshot(s, '离开');
      else if (has(s, '结束') && !has(s, '全员结束会议')) await tapSnapshot(s, '结束');
      await pause(500);
    }
    throw new Error('未确认钉钉会议正常结束，请检查手机');
  };
  try {
    onStep(1, calling ? '打开钉钉消息页第一个会话' : '进入钉钉会议页面');
    await device.launchPackage(app.packageName);
    await sleep(1800);
    let s = await snapshot();
    if (inspectDingtalkMeeting(s).loggedOut) throw new Error('请先手动登录钉钉');
    if (has(s, '结束') || has(s, '离开') || has(s, '会议信息')) throw new Error('钉钉已有会议，请先手动结束');
    if (calling) {
      await openDingtalkFirstConversation({ device, sleep });
      entered = true;
      await device.tapText('视频会议');
      onStep(2, '等待对方接听钉钉视频通话');
    } else {
      if (!has(s, '发起会议')) {
        await device.tapText('更多');
        await sleep(500);
        await device.tapText('会议');
        await sleep(800);
      }
      if (joining) {
        await device.tapText('加入会议');
        await device.tapResource('tele_join_conf_room_code_input');
        await device.inputText(meetingId, { clearExisting: true });
        s = await snapshot();
        if (!s.values.some(v => v.replace(/\s/g, '') === meetingId)) throw new Error('会议号输入未生效');
      } else {
        await device.tapText('发起会议');
        await device.tapText(meetingType === 'video' ? '视频会议' : '语音会议');
      }
      await sleep(700);
      s = await snapshot();
      if (!has(s, '进入会议')) throw new Error('未找到钉钉会议准备页');
      onStep(2, '进入会议并等待连接');
      // Mark before the tap so cancellation during entry still attempts normal cleanup.
      entered = true;
      await device.tapText('进入会议');
    }
    let ready = false;
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      s = await controls();
      if (inspectDingtalkMeeting(s).active && (!calling || peerConnected(s))) { ready = true; break; }
    }
    if (!ready) throw new Error('钉钉会议未连接成功');
    onStep(3, '设置摄像头和共享屏幕');
    if (meetingType === 'video') {
      let state = inspectDingtalkMeeting(s);
      for (let attempt = 0; state.camera === null && attempt < 4; attempt++) {
        await sleep(600);
        s = await controls();
        state = inspectDingtalkMeeting(s);
      }
      if (state.camera === null && (!joining || camera)) throw new Error('当前会议无法设置摄像头');
      if (state.camera !== null) {
        if (state.camera !== camera) await tapSnapshot(s, camera ? '开摄像头' : '关摄像头');
        s = await controls();
        if (inspectDingtalkMeeting(s).camera !== camera) throw new Error('摄像头设置未生效');
      }
    }
    if (shareScreen) {
      let opened = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        s = await controls();
        if (!inspectDingtalkMeeting(s).active) throw new Error('共享前会议状态异常');
        await tapSnapshot(s, '共享');
        await sleep(700);
        s = await snapshot();
        if (has(s, '共享屏幕')) {
          await tapSnapshot(s, '共享屏幕');
          opened = true;
          break;
        }
      }
      if (!opened) throw new Error('钉钉共享菜单未展开');
      let shared = false;
      for (let i = 0; i < 12; i++) {
        await sleep(800);
        s = await snapshot();
        if (inspectDingtalkMeeting(s).loggedOut) throw new Error('开启共享后钉钉退出登录，停止任务');
        if (s.values.some(v => /共享屏幕有风险/.test(v)) && has(s, '确定')) {
          await tapSnapshot(s, '确定');
          continue;
        }
        if (has(s, '发起屏幕共享') && has(s, '我知道了')) {
          await tapSnapshot(s, '我知道了');
          continue;
        }
        if (has(s, '选择共享内容') && has(s, '开始共享') &&
            s.values.some(v => /钉钉.*投射\/录制/.test(v))) {
          await tapSnapshot(s, '开始共享');
          continue;
        }
        if (inspectDingtalkMeeting(s).sharing) { shared = true; break; }
      }
      if (!shared) throw new Error('未确认屏幕共享成功，请检查系统共享授权提示');
    }
    onStep(4, '会议状态已就绪，开始计时和采集');
    await startCapture?.();
    const started = now();
    while (now() - started < durationMs) {
      await sleep(Math.min(5000, durationMs - (now() - started)));
      s = await controls();
      if (!inspectDingtalkMeeting(s).active) throw new Error('钉钉会议已中断');
      if (calling && !peerConnected(s)) throw new Error('对方已离开钉钉视频通话');
      if (shareScreen && !inspectDingtalkMeeting(s).sharing) throw new Error('钉钉屏幕共享已中断');
    }
    onStep(5, joining ? '仅自己离开钉钉会议' : '正常结束钉钉会议');
    await endMeeting();
    return { validationMode: calling ? 'dingtalk_video_call_v1' : joining ? 'dingtalk_join_meeting_v1' : 'dingtalk_quick_meeting_v1', effectiveDurationMs: durationMs,
      validationChecks: ['meeting_connected', 'options_applied', 'duration_observed', 'normal_end'].map(id => ({ id, status: 'passed' })) };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (entered) {
      try { await endMeeting(); } catch (error) {
        if (failure) throw new AggregateError([failure, error], `${failure.message}；会议清理失败：${error.message}`);
        throw error;
      }
    }
  }
}
