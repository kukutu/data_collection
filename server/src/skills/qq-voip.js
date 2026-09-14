import { startCaptureBeforeAction } from './capture-timing.js';

const HANGUP_ID = 'dav_id_5003:16064';
const TIMER_ID = 'dav_id_5003:16406';
const CAMERA_REVERSE_ID = 'dav_id_5003:16250_camera_reverse';

function nodes(snapshot) {
  const out = [];
  function visit(n, parents = []) {
    if (!n) return;
    const a = n.attributes || n;
    const b = String(a.bounds).match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    const item = { id: a.id || '', text: a.text || a.description || '', parents,
      bounds: b ? { x: +b[1], y: +b[2], w: +b[3] - +b[1], h: +b[4] - +b[2] } : null };
    out.push(item);
    (n.children || []).forEach(c => visit(c, [...parents, item]));
  }
  visit(snapshot?.layout);
  return out;
}

export function inspectQqCall(snapshot) {
  const all = nodes(snapshot);
  const timer = all.find(n => (n.id === TIMER_ID || n.parents.some(p => p.id === TIMER_ID)) &&
    /^\d{2,}:\d{2}(?::\d{2})?$/.test(n.text))?.text || '';
  return { active: all.some(n => n.id === HANGUP_ID),
    connected: /^\d{2,}:\d{2}(?::\d{2})?$/.test(timer), timer,
    video: all.some(n => n.id === CAMERA_REVERSE_ID) };
}

export function firstQqConversation(snapshot, screen) {
  return nodes(snapshot).filter(n => n.id === 'msg_time').map(n =>
    [...n.parents].reverse().find(p => p.bounds && p.bounds.w >= screen.width * 0.9 &&
      p.bounds.h < screen.height * 0.2 && p.bounds.y >= screen.height * 0.13))
    .filter(Boolean).sort((a, b) => a.bounds.y - b.bounds.y)[0] || null;
}

export async function executeQqVoipCall({ device, app, callType, durationMs = 30000,
  startCapture, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now,
  onStep = () => {} }) {
  if (app?.id !== 'qq' || !['audio', 'video'].includes(callType)) throw new Error('QQ 通话类型无效');
  if (!Number.isFinite(Number(durationMs)) || Number(durationMs) <= 0) throw new Error('QQ 通话时长无效');
  const effectiveDurationMs = Math.min(7200000, Math.max(1000, Number(durationMs)));
  const screen = await device.getScreenSize();
  const checks = [];
  let step = 0, initiated = false;
  const report = text => onStep(++step, text, 5);
  const snapshot = () => device.getUiTextSnapshot({ attempts: 2, timeoutMs: 8000 });
  const foreground = async () => {
    const f = await device.getCurrentFocus();
    if (![app.packageName, app.harmonyBundleName].includes(f?.bundleName || f?.packageName)) throw new Error('QQ 已离开前台');
  };
  const tapNode = async n => {
    if (!n?.bounds || n.bounds.w <= 0 || n.bounds.h <= 0) throw new Error('QQ 目标控件不可用');
    await foreground();
    await device.tap({ x: Math.round(n.bounds.x + n.bounds.w / 2), y: Math.round(n.bounds.y + n.bounds.h / 2) });
  };
  const controls = async () => {
    await foreground();
    let s = await snapshot();
    if (!inspectQqCall(s).active && !nodes(s).some(n => n.id === 'aio_root')) {
      await device.tap({ x: Math.round(screen.width * 0.39), y: Math.round(screen.height * 0.46) });
      s = await snapshot();
    }
    return s;
  };
  const hangup = async () => {
    for (let i = 0; i < 3; i++) {
      const s = await controls();
      if (nodes(s).some(n => n.id === 'aio_root')) return;
      const button = nodes(s).find(n => n.id === HANGUP_ID);
      if (button) await tapNode(button);
      // Cleanup must still run after TaskManager cancellation.
      await new Promise(r => setTimeout(r, 500));
    }
    const s = await snapshot();
    if (!nodes(s).some(n => n.id === 'aio_root')) throw new Error('QQ 未确认正常挂断，请检查手机');
  };
  try {
    report('打开 QQ 消息页第一个会话');
    await device.launchPackage(app.packageName);
    await sleep(2000);
    let home;
    for (let i = 0; i < 4; i++) {
      await foreground();
      home = await snapshot();
      if (inspectQqCall(home).active) throw new Error('QQ 已存在通话');
      if (firstQqConversation(home, screen)) break;
      const messages = nodes(home).find(n => n.text === '消息' && n.bounds?.y > screen.height * 0.9);
      if (messages) await tapNode(messages); else await device.keyevent('BACK');
      await sleep(700);
    }
    await tapNode(firstQqConversation(home, screen));
    await sleep(1200);
    const chat = await snapshot();
    if (!nodes(chat).some(n => n.id === 'aio_root')) throw new Error('QQ 第一个会话未打开');
    report(`发起 QQ ${callType === 'video' ? '视频' : '语音'}通话`);
    const label = callType === 'video' ? '视频通话' : '语音通话';
    if (!nodes(chat).some(n => n.text === label)) await tapNode(nodes(chat).find(n => n.id === 'plus'));
    await sleep(500);
    const menu = await snapshot();
    const option = nodes(menu).find(n => n.text === label);
    if (!option) throw new Error('QQ 第一个会话没有所需的单人通话入口');
    await startCaptureBeforeAction(startCapture, sleep);
    await tapNode(option);
    initiated = true;
    report('等待对方接听并确认通话类型');
    let connected = false;
    for (let i = 0; i < 15; i++) {
      let s = await snapshot();
      const values = nodes(s).map(n => n.text);
      if (values.some(t => /允许.*QQ.*访问你的(麦克风|相机|摄像头)/.test(t))) {
        await tapNode(nodes(s).find(n => n.text === '允许'));
        await sleep(500);
      } else {
        s = await controls();
        const state = inspectQqCall(s);
        if (state.connected) {
          if (state.video !== (callType === 'video')) throw new Error('QQ 通话类型与请求不符');
          connected = true;
          break;
        }
        if (nodes(s).some(n => n.id === 'aio_root')) throw new Error('QQ 呼叫已结束或被拒绝');
      }
      await sleep(1000);
    }
    if (!connected) throw new Error('QQ 通话未接听，停止测试');
    checks.push({ id: 'call_connected', status: 'passed', detail: callType });
    report('按设置时长保持 QQ 通话');
    const deadline = now() + effectiveDurationMs;
    while (now() < deadline) {
      await sleep(Math.min(5000, deadline - now()));
      if (!inspectQqCall(await controls()).connected) throw new Error('QQ 通话提前结束');
    }
    report('正常挂断 QQ 通话');
    await hangup();
    initiated = false;
    checks.push({ id: 'duration_observed', status: 'passed' }, { id: 'normal_hangup', status: 'passed' });
    return { validationMode: 'qq_voip_call_v1', validationChecks: checks, effectiveDurationMs };
  } finally {
    if (initiated) await hangup();
  }
}
