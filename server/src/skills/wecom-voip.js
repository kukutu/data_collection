const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function nodes(snapshot) {
  const result = [];
  function visit(n) {
    if (!n) return;
    const a = n.attributes || {};
    const b = a.bounds?.match(/-?\d+/g)?.map(Number);
    if (b?.length === 4 && b[2] > b[0] && b[3] > b[1] && a.visible !== 'false') {
      result.push({ ...a, box: { x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2, top: b[1], bottom: b[3], width: b[2] - b[0], height: b[3] - b[1] } });
    }
    for (const child of n.children || []) visit(child);
  }
  visit(snapshot?.layout);
  return result;
}

export function firstWecomConversation(snapshot) {
  return nodes(snapshot).filter(n => /^conv_item_/.test(n.id)).sort((a, b) => a.box.top - b.box.top)[0];
}

export function wecomCallButton(snapshot, label) {
  const all = nodes(snapshot), text = all.find(n => n.text === label);
  if (!text) return null;
  return all.filter(n => n.type === 'Button' && n.clickable === 'true' &&
    Math.abs(n.box.x - text.box.x) < n.box.width * 0.35 &&
    n.box.bottom <= text.box.top + 5 && text.box.top - n.box.bottom < n.box.height)
    .sort((a, b) => b.box.bottom - a.box.bottom)[0] || null;
}

export function inspectWecomCall(snapshot) {
  const values = snapshot?.values || [];
  return { connected: values.includes('挂断') && !values.includes('已挂断') && values.some(v => /^\d{2,}:\d{2}$/.test(v)),
    camera: values.includes('摄像头已开') ? true : values.includes('摄像头已关') ? false : null,
    sharing: values.includes('你正在演示屏幕') && values.includes('结束演示'),
    chat: nodes(snapshot).some(n => n.id === 'MsgBottomAdd'),
  };
}

export async function executeWecomVoipCall({ device, app, callType, camera = false, shareScreen = false,
  durationMs = 30000, startCapture, sleep = pause, now = Date.now, onStep = () => {} }) {
  if (app?.id !== 'wecom' || !['audio', 'video'].includes(callType)) throw new Error('企业微信通话类型无效');
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('企业微信通话时长无效');
  durationMs = Math.min(durationMs, 7200000);
  camera = callType === 'video' && Boolean(camera);
  shareScreen = callType === 'video' && Boolean(shareScreen);
  const snapshot = () => device.getUiTextSnapshot({ attempts: 2, timeoutMs: 8000 });
  const foreground = async () => {
    const f = await device.getCurrentFocus();
    if (![app.packageName, app.harmonyBundleName].filter(Boolean).includes(f.packageName)) throw new Error('当前已离开企业微信');
  };
  const tap = async n => {
    if (!n?.box) throw new Error('企业微信目标控件不可用');
    await device.tap({ x: Math.round(n.box.x), y: Math.round(n.box.y) });
  };
  const waitTap = async (text, last = false) => {
    for (let i = 0; i < 6; i++) {
      const matches = nodes(await snapshot()).filter(n => n.text === text);
      if (matches.length) return tap(last ? matches.at(-1) : matches[0]);
      await sleep(400);
    }
    throw new Error(`未出现企业微信控件：${text}`);
  };
  const permission = async s => {
    if (s.values.some(v => /^允许“企业微信”访问你的(?:麦克风|相机|摄像头)？$/.test(v))) {
      await tap(nodes(s).find(n => n.text === '允许'));
      return true;
    }
    return false;
  };
  let initiated = false, failure;
  const hangup = async () => {
    for (let i = 0; i < 8; i++) {
      await foreground();
      let s;
      try { s = await snapshot(); } catch { await pause(500); continue; }
      if (inspectWecomCall(s).chat || firstWecomConversation(s)) { initiated = false; return; }
      if (s.values.includes('不允许')) await tap(nodes(s).find(n => n.text === '不允许'));
      else if (!s.values.includes('已挂断')) {
        const button = wecomCallButton(s, '挂断');
        if (button) await tap(button);
      }
      await pause(600);
    }
    throw new Error('未确认企业微信通话正常挂断，请检查手机');
  };
  try {
    onStep(1, '打开企业微信消息页第一个会话');
    await device.launchPackage(app.packageName);
    await sleep(1800);
    let opened = false;
    for (let i = 0; i < 5; i++) {
      await foreground();
      const s = await snapshot();
      if (s.values.includes('挂断')) throw new Error('企业微信已有通话，请先手动结束');
      const first = firstWecomConversation(s);
      if (first) { await tap(first); opened = true; break; }
      const messageTab = nodes(s).filter(n => n.text === '消息').sort((a, b) => b.box.top - a.box.top)[0];
      if (messageTab) await tap(messageTab);
      else await device.keyevent('BACK');
      await sleep(500);
    }
    if (!opened) throw new Error('未找到企业微信第一个会话');
    await sleep(600);
    let s = await snapshot();
    const plus = nodes(s).find(n => n.id === 'MsgBottomAdd');
    if (!plus) throw new Error('消息页第一个会话无法发起通话');
    await tap(plus);
    await waitTap('语音通话');
    initiated = true;
    await waitTap(callType === 'audio' ? '语音通话' : '视频通话', true);
    onStep(2, '等待对方接听企业微信通话');
    let connected = false;
    for (let i = 0; i < 30; i++) {
      await sleep(800);
      s = await snapshot();
      if (await permission(s)) continue;
      await foreground();
      if (inspectWecomCall(s).connected) { connected = true; break; }
      if (s.values.includes('已挂断') || inspectWecomCall(s).chat) throw new Error('对方未接听或通话已结束');
    }
    if (!connected) throw new Error('企业微信等待接听超时');
    onStep(3, '设置企业微信摄像头和共享屏幕');
    // Video answer transitions can still rearrange the controls after the timer appears.
    await sleep(1500);
    s = await snapshot();
    for (let attempt = 0; inspectWecomCall(s).camera !== camera && attempt < 2; attempt++) {
      await tap(wecomCallButton(s, camera ? '摄像头已关' : '摄像头已开'));
      for (let i = 0; i < 4; i++) {
        await sleep(600);
        s = await snapshot();
        if (await permission(s)) continue;
        if (inspectWecomCall(s).camera === camera) break;
      }
    }
    if (inspectWecomCall(s).camera !== camera) throw new Error('企业微信摄像头设置未生效');
    if (shareScreen) {
      await tap(wecomCallButton(s, '演示屏幕'));
      let shared = false;
      for (let i = 0; i < 12; i++) {
        await sleep(600);
        s = await snapshot();
        if (s.values.includes('允许“企业微信”使用你的屏幕？')) {
          await tap(nodes(s).find(n => n.text === '允许'));
          continue;
        }
        if (inspectWecomCall(s).sharing) { shared = true; break; }
      }
      if (!shared) throw new Error('企业微信屏幕共享未确认成功');
    }
    await foreground();
    s = await snapshot();
    const ready = inspectWecomCall(s);
    if (!ready.connected || ready.camera !== camera || (shareScreen && !ready.sharing)) throw new Error('企业微信采集前通话状态异常');
    onStep(4, '企业微信通话已就绪，开始计时和采集');
    await startCapture?.();
    const started = now();
    while (now() - started < durationMs) {
      await sleep(Math.min(5000, durationMs - (now() - started)));
      await foreground();
      const current = inspectWecomCall(await snapshot());
      if (!current.connected || current.camera !== camera || (shareScreen && !current.sharing)) throw new Error('企业微信通话或所选功能已中断');
    }
    onStep(5, '正常挂断企业微信通话');
    await hangup();
    return { validationMode: `wecom_${callType}_call_v1`, effectiveDurationMs: durationMs,
      validationChecks: ['call_connected', 'options_applied', 'duration_observed', 'normal_hangup'].map(id => ({ id, status: 'passed' })) };
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
