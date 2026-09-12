import { decodeRgbaPng } from './tencent-meeting.js';

export const FEISHU_QUICK_MEETING_WORKFLOW_ID = 'meeting:feishu:quick-meeting';
export const FEISHU_JOIN_MEETING_WORKFLOW_ID = 'meeting:feishu:join-meeting';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function nodes(layout, ancestors = []) {
  if (!layout) return [];
  const a = layout.attributes || {};
  return [{ ...a, ancestors }, ...(layout.children || []).flatMap(c => nodes(c, [...ancestors, a.id]))];
}

export function inspectFeishuMeeting(snapshot) {
  const list = nodes(snapshot?.layout);
  const hasId = id => list.some(n => n.id === id && n.visible !== 'false' && n.bounds !== '[0,0][0,0]');
  const values = snapshot?.values || [];
  return {
    active: hasId('inMeetingPage_root_container') && values.some(v => /^\d{2,}:\d{2}$/.test(v)),
    camera: hasId('camera_p_id') ? hasId('in_meeting_grid_swich_camera_id') || hasId('privacy_camera_icon') : null,
    sharing: values.includes('你正在共享屏幕') && values.includes('停止共享'),
    hangup: list.find(n => n.ancestors.includes('right_tool_bar_container') && n.backgroundColor?.toUpperCase() === '#FFF54A45'),
  };
}

export function inspectFeishuCameraPixels({ data, width, height, channels }, bounds, screen) {
  const b = bounds?.match(/-?\d+/g)?.map(Number);
  if (!b || b.length !== 4) throw new Error('未找到飞书摄像头按钮区域');
  const [x1, y1, x2, y2] = b.map((v, i) => Math.round(v * (i % 2 ? height / screen.height : width / screen.width)));
  let red = 0, gray = 0, total = 0;
  for (let y = Math.max(0, y1); y < Math.min(height, y2); y++) {
    for (let x = Math.max(0, x1); x < Math.min(width, x2); x++) {
      const offset = (y * width + x) * channels;
      const [r, g, b] = data.subarray(offset, offset + 3);
      total++;
      if (r > 180 && r > g * 1.5 && r > b * 1.5) red++;
      if (r > 35 && r < 150 && Math.abs(r - g) < 25 && Math.abs(g - b) < 25) gray++;
    }
  }
  if (total && red / total > 0.025) return false;
  if (total && gray / total > 0.04) return true;
  throw new Error('无法从飞书摄像头按钮确认开关状态');
}

async function readCameraPixels(device, snapshot, screen) {
  const icon = nodes(snapshot.layout).find(n => n.id === 'camera_p_id');
  return inspectFeishuCameraPixels(decodeRgbaPng(await device.screenshotPng()), icon?.bounds, screen);
}

export function executeFeishuQuickMeeting(options) {
  return executeFeishuMeeting({ ...options, joining: false });
}

export function executeFeishuJoinMeeting(options) {
  return executeFeishuMeeting({ ...options, joining: true });
}

async function executeFeishuMeeting({
  device, app, durationMs = 30000, camera = false, shareScreen = false,
  joining = false, meetingId = '',
  startCapture, sleep = pause, now = Date.now, onStep = () => {}, inspectCamera = readCameraPixels,
}) {
  if (app?.id !== 'feishu') throw new Error('飞书会议只能用于飞书');
  meetingId = String(meetingId).replace(/[\s-]/g, '');
  if (joining && !/^\d{9}$/.test(meetingId)) throw new Error('请输入9位飞书会议号');
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('无效的会议时长');
  durationMs = Math.min(durationMs, 7200000);
  const screen = await device.getScreenSize();
  const snapshot = () => device.getUiTextSnapshot({ attempts: 2, timeoutMs: 8000 });
  const foreground = async () => {
    const focus = await device.getCurrentFocus();
    if (![app.packageName, app.harmonyBundleName].filter(Boolean).includes(focus.packageName)) {
      throw new Error('当前已离开飞书，停止会议操作');
    }
  };
  const tapNode = async node => {
    const b = node?.bounds?.match(/-?\d+/g)?.map(Number);
    if (!b || b.length !== 4 || b[2] <= b[0] || b[3] <= b[1]) throw new Error('无法定位飞书会议控件');
    await device.tap({ x: Math.round((b[0] + b[2]) / 2), y: Math.round((b[1] + b[3]) / 2) });
  };
  const tapText = async (text, s) => {
    const target = nodes(s.layout).find(n => n.text === text && n.visible !== 'false');
    if (!target) throw new Error(`未找到飞书控件：${text}`);
    await tapNode(target);
  };
  const waitText = async text => {
    for (let i = 0; i < 8; i++) {
      const s = await snapshot();
      if (s.values.includes(text)) { await tapText(text, s); return; }
      await sleep(500);
    }
    throw new Error(`飞书页面未出现：${text}`);
  };
  let entered = false, failure;
  const finish = async () => {
    let lastReadError;
    for (let i = 0; i < 6; i++) {
      await foreground();
      let s;
      try { s = await snapshot(); } catch (error) {
        lastReadError = error;
        await pause(500);
        continue;
      }
      const state = inspectFeishuMeeting(s);
      if (s.values.includes('发起会议') && !nodes(s.layout).some(n => n.id === 'inMeetingPage_root_container')) {
        entered = false;
        return;
      }
      if (joining && s.values.includes('离开会议')) await tapText('离开会议', s);
      else if (!joining && s.values.includes('结束会议')) await tapText('结束会议', s);
      else if (joining && s.values.includes('结束会议')) throw new Error('未找到仅离开会议选项，不会结束其他人的会议');
      else if (state.hangup) await tapNode(state.hangup);
      else if (s.values.includes('取消')) await tapText('取消', s);
      await pause(500);
    }
    throw new Error(`未确认飞书会议正常结束，请检查手机${lastReadError ? '（页面读取失败）' : ''}`);
  };
  try {
    onStep(1, '打开飞书视频会议');
    await device.launchPackage(app.packageName);
    await sleep(1800);
    await foreground();
    let s = await snapshot();
    if (nodes(s.layout).some(n => n.id === 'inMeetingPage_root_container')) throw new Error('飞书已有会议，请先手动结束');
    if (!s.values.includes('发起会议')) {
      await waitText('更多');
      await waitText('视频会议');
    }
    if (joining) {
      await waitText('加入会议');
      await device.tapResource('number_input');
      await device.inputText(meetingId, { clearExisting: true });
      s = await snapshot();
      if (!nodes(s.layout).some(n => n.id === 'number_input' && n.text.replace(/\s/g, '') === meetingId)) {
        throw new Error('飞书会议号输入未生效');
      }
    } else await waitText('发起会议');
    onStep(2, joining ? '加入飞书会议并等待连接' : '开始飞书会议并等待连接');
    entered = true;
    await waitText(joining ? '加入会议' : '开始会议');
    let connected = false;
    for (let i = 0; i < 15; i++) {
      await sleep(800);
      await foreground();
      s = await snapshot();
      if (inspectFeishuMeeting(s).active && inspectFeishuMeeting(s).camera !== null) { connected = true; break; }
    }
    if (!connected) throw new Error('飞书会议未连接成功');
    onStep(3, '设置飞书摄像头和共享屏幕');
    if (await inspectCamera(device, s, screen) !== Boolean(camera)) {
      await tapNode(nodes(s.layout).find(n => n.id === 'camera_p_id'));
      await sleep(800);
      s = await snapshot();
    }
    if (await inspectCamera(device, s, screen) !== Boolean(camera)) throw new Error('飞书摄像头设置未生效');
    if (shareScreen) {
      await waitText('更多');
      await waitText('共享');
      await waitText('共享手机屏幕');
      let shared = false;
      for (let i = 0; i < 12; i++) {
        await sleep(700);
        s = await snapshot();
        if (s.values.includes('允许“飞书”使用你的屏幕？') && s.values.includes('允许')) {
          await tapText('允许', s);
          continue;
        }
        if (inspectFeishuMeeting(s).sharing) { shared = true; break; }
      }
      if (!shared) throw new Error('未确认飞书屏幕共享成功，请检查授权提示');
    }
    await foreground();
    s = await snapshot();
    const verified = inspectFeishuMeeting(s);
    if (!verified.active || (shareScreen && !verified.sharing) ||
        await inspectCamera(device, s, screen) !== Boolean(camera)) {
      throw new Error('采集前飞书会议参数状态验证失败');
    }
    onStep(4, '飞书会议状态已就绪，开始计时和采集');
    await startCapture?.();
    const started = now();
    while (now() - started < durationMs) {
      await sleep(Math.min(5000, durationMs - (now() - started)));
      await foreground();
      s = await snapshot();
      const state = inspectFeishuMeeting(s);
      if (!state.active) throw new Error('飞书会议已中断');
      if (shareScreen && !state.sharing) throw new Error('飞书屏幕共享已中断');
      if (await inspectCamera(device, s, screen) !== Boolean(camera)) throw new Error('飞书摄像头状态已改变');
    }
    onStep(5, joining ? '仅自己离开飞书会议' : '正常结束飞书会议');
    await finish();
    return { validationMode: joining ? 'feishu_join_meeting_v1' : 'feishu_quick_meeting_v1', effectiveDurationMs: durationMs,
      validationChecks: ['meeting_connected', 'options_applied', 'duration_observed', 'normal_end'].map(id => ({ id, status: 'passed' })) };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (entered) {
      try { await finish(); } catch (error) {
        if (failure) throw new AggregateError([failure, error], `${failure.message}；会议清理失败：${error.message}`);
        throw error;
      }
    }
  }
}
