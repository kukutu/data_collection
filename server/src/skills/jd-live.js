export function jdRoomId(s) {
  return texts(s).map(v => v.match(/^京东直播\s+(\d+)$/)?.[1]).find(Boolean) || null;
}
export function isJdLiveRoom(s) {
  const t = texts(s);
  return Boolean(jdRoomId(s)) && t.some(v => /聊天框|聊一聊/.test(v)) &&
    t.some(v => /观看/.test(v)) && !t.some(v => /拖动进度|倍速 x|直播已结束/.test(v));
}
function nodes(s) {
  const out = [];
  function visit(n) { if (!n) return; out.push(n.attributes || n); (n.children || []).forEach(visit); }
  visit(s?.layout);
  return out;
}
function texts(s) {
  return [...(s?.values || []), ...nodes(s).flatMap(a => [a.text, a.description, a.originalText])].filter(Boolean);
}
function target(s, pattern, screen, min, max) {
  for (const a of nodes(s)) {
    if (![a.text, a.description].some(v => pattern.test(v || ''))) continue;
    const b = String(a.bounds).match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    if (!b) continue;
    const x = (+b[1] + +b[3]) / 2, y = (+b[2] + +b[4]) / 2;
    if (x >= 0 && x < screen.width && y >= screen.height * min && y <= screen.height * max) return { x, y };
  }
  return null;
}
export async function executeJdLiveBrowse({ device, app, durationMs = 300000, switchIntervalMs = 180000,
  sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, startCapture, onStep = () => {} }) {
  const duration = Number(durationMs), interval = Number(switchIntervalMs ?? 180000);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(interval) || interval <= 0) throw new Error('京东直播时间参数无效');
  const screen = await device.getScreenSize();
  const checks = [];
  let step = 0;
  const report = label => onStep(++step, label, 6);
  const foreground = async () => {
    const f = await device.getCurrentFocus();
    if (![app.packageName, app.harmonyBundleName].includes(f?.bundleName || f?.packageName)) throw new Error('京东已离开前台');
  };
  const snapshot = async () => {
    let s = await device.getUiTextSnapshot({ attempts: 2, timeoutMs: 5000 });
    if (jdRoomId(s) && texts(s).includes('领取并使用')) {
      await foreground();
      await device.keyevent('BACK');
      await sleep(400);
      s = await device.getUiTextSnapshot({ attempts: 2, timeoutMs: 5000 });
      if (texts(s).includes('领取并使用')) throw new Error('京东优惠券弹窗未关闭');
    }
    return s;
  };
  const tap = (x, y) => device.tap({ x: Math.round(screen.width * x), y: Math.round(screen.height * y) });
  const poll = async (predicate, message) => {
    for (let i = 0; i < 6; i++) {
      await foreground();
      const s = await snapshot();
      if (predicate(s)) return s;
      await sleep(800);
    }
    throw new Error(message);
  };
  report('打开京东并进入底部逛页面');
  await device.forceStopPackage(app.packageName);
  await device.launchPackage(app.packageName);
  await sleep(5000);
  await foreground();
  const browse = target(await snapshot(), /^(逛|逛逛)$/, screen, 0.9, 0.98);
  if (browse) await device.tap(browse); else await tap(0.3, 0.943);
  await sleep(3000);
  report('点击逛页面顶部直播');
  let channel;
  for (let i = 0; i < 2; i++) {
    await foreground();
    const live = target(await snapshot(), /^直播$/, screen, 0.04, 0.12);
    if (!live) throw new Error('未找到京东顶部直播入口');
    await device.tap(live);
    await sleep(3500);
    channel = await snapshot();
    if (texts(channel).some(v => /看讲解|观看|直播间/.test(v))) break;
  }
  report('进入京东真实直播间');
  // Top preview avoids the product-explanation replay cards below it.
  if (!isJdLiveRoom(channel)) await tap(0.31, 0.177);
  await poll(isJdLiveRoom, '京东未进入真实直播间');
  checks.push({ id: 'live_room', status: 'passed' });
  report('验证京东直播动态画面');
  const first = await device.screenshotPng();
  await sleep(1500);
  if (Buffer.from(first).equals(Buffer.from(await device.screenshotPng()))) throw new Error('京东直播画面未变化');
  checks.push({ id: 'motion', status: 'passed' });
  await poll(isJdLiveRoom, '京东直播状态已变化');
  if (startCapture) await startCapture();
  report('按时长和间隔浏览京东直播');
  const effectiveDurationMs = Math.min(7200000, Math.max(1000, duration));
  const deadline = now() + effectiveDurationMs;
  let switchCount = 0;
  while (now() < deadline) {
    await sleep(Math.min(Math.max(1000, interval), deadline - now()));
    if (deadline - now() < 6000) break;
    const before = jdRoomId(await poll(isJdLiveRoom, '京东已离开直播间'));
    await device.swipe({ x1: Math.round(screen.width * 0.5), y1: Math.round(screen.height * 0.60),
      x2: Math.round(screen.width * 0.5), y2: Math.round(screen.height * 0.177), durationMs: 460 });
    await poll(s => isJdLiveRoom(s) && jdRoomId(s) !== before, '京东上滑未切换直播间');
    switchCount++;
  }
  if (now() < deadline) await sleep(deadline - now());
  await poll(isJdLiveRoom, '京东直播结束校验失败');
  report('京东直播浏览完成');
  checks.push({ id: 'duration_observed', status: 'passed', detail: `成功切换 ${switchCount} 次` });
  return { validationMode: 'jd_live_browse_v1', validationChecks: checks, effectiveDurationMs, replayStepIndex: step, switchCount };
}
