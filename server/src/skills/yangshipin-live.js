import { execFile } from 'node:child_process';
import { config } from '../config.js';

async function playerPixels(buffer) {
  return new Promise((resolve, reject) => {
    const child = execFile(config.capture.ffmpegPath, [
      '-v', 'error', '-i', 'pipe:0', '-vf', 'crop=iw*0.96:ih*0.25:iw*0.02:ih*0.105,scale=64:36',
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ], { encoding: 'buffer', windowsHide: true, timeout: 10000 }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(buffer);
  });
}

function entries(snapshot) {
  const out = [];
  function visit(node, parents = []) {
    if (!node) return;
    const a = node.attributes || node;
    const match = String(a.bounds).match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    const bounds = match ? { x: +match[1], y: +match[2], w: +match[3] - +match[1], h: +match[4] - +match[2] } : null;
    const item = {
      text: String(a.text || a.description || a.originalText || a.hint || '').replace(/\s/g, ''),
      bounds,
      parents,
      type: a.type,
      clickable: String(a.clickable) === 'true',
    };
    out.push(item);
    (node.children || []).forEach(child => visit(child, [...parents, item]));
  }
  visit(snapshot?.layout);
  return out;
}

export function yangshipinLiveTabPoint(snapshot, screen) {
  const height = Number(screen?.height) || 2832;
  const item = entries(snapshot).find(n =>
    n.text === '直播' && n.bounds &&
    n.bounds.y >= height * 0.05 && n.bounds.y <= height * 0.2,
  );
  return item
    ? { x: Math.round(item.bounds.x + item.bounds.w / 2), y: Math.round(item.bounds.y + item.bounds.h / 2) }
    : null;
}

export function yangshipinLiveEntryCardPoint(snapshot, screen) {
  const width = Number(screen?.width) || 1280;
  const height = Number(screen?.height) || 2832;
  const candidates = entries(snapshot)
    .filter(n => n.clickable && n.bounds &&
      n.bounds.w >= width * 0.55 && n.bounds.h >= height * 0.15 &&
      n.bounds.h <= height * 0.4 && n.bounds.y >= height * 0.12 &&
      n.bounds.y <= height * 0.65)
    .sort((left, right) => left.bounds.y - right.bounds.y || left.bounds.x - right.bounds.x);
  const card = candidates.find((candidate, index) =>
    candidates.slice(0, index).every(previous =>
      Math.abs(previous.bounds.x - candidate.bounds.x) >= 20 ||
      Math.abs(previous.bounds.y - candidate.bounds.y) >= 20,
    ),
  );
  return card
    ? {
        x: Math.round(card.bounds.x + card.bounds.w / 2),
        y: Math.round(card.bounds.y + card.bounds.h / 2),
      }
    : null;
}

export function isYangshipinLiveRoom(snapshot) {
  const e = entries(snapshot);
  return e.some(n => /人次观看/.test(n.text)) && e.some(n => /我来说几句/.test(n.text)) &&
    e.some(n => n.text === '评论') && !e.some(n => n.text === '更多直播' && n.bounds && n.bounds.w > n.bounds.h);
}

export function yangshipinLiveCards(snapshot, screen) {
  const e = entries(snapshot);
  if (!e.some(n => n.text === '更多直播' && n.bounds?.y < screen.height * 0.12 && n.bounds.w > screen.width * 0.12)) return [];
  return e.filter(n => n.text.length > 6 && !/人次观看/.test(n.text) && n.bounds &&
    n.bounds.x > screen.width * 0.3 && n.bounds.w > screen.width * 0.5 &&
    n.bounds.h > screen.height * 0.025 && n.bounds.y > screen.height * 0.15 &&
    n.bounds.y + n.bounds.h < screen.height * 0.93).map(n => ({
      title: n.text,
      x: Math.round(n.bounds.x + n.bounds.w / 2),
      y: Math.round(n.bounds.y - screen.height * 0.07),
    }));
}

export async function executeYangshipinLiveBrowse({ device, app, durationMs = 300000,
  switchIntervalMs = 180000, startCapture, sleep = ms => new Promise(r => setTimeout(r, ms)),
  now = Date.now, onStep = () => {} }) {
  const duration = Number(durationMs), interval = Number(switchIntervalMs ?? 180000);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(interval) || interval <= 0) throw new Error('央视频直播时间参数无效');
  const screen = await device.getScreenSize();
  const checks = [];
  let index = 0;
  const report = label => onStep(++index, label, 4);
  const foreground = async () => {
    const f = await device.getCurrentFocus();
    if (![app.packageName, app.harmonyBundleName].includes(f?.bundleName || f?.packageName)) throw new Error('央视频已离开前台');
  };
  const snapshot = () => device.getUiTextSnapshot({ attempts: 2, timeoutMs: 8000 });
  const poll = async (predicate, message) => {
    for (let i = 0; i < 8; i++) {
      await foreground();
      const s = await snapshot().catch(() => null);
      if (s && predicate(s)) return s;
      await sleep(1000);
    }
    throw new Error(message);
  };
  const clickText = async (s, text, condition = () => true) => {
    const n = entries(s).find(n => n.text === text && n.bounds && condition(n));
    if (!n) throw new Error(`央视频未找到${text}`);
    await foreground();
    await device.tap({ x: Math.round(n.bounds.x + n.bounds.w / 2), y: Math.round(n.bounds.y + n.bounds.h / 2) });
  };
  const author = s => entries(s).find(n => n.bounds?.y > screen.height * 0.05 &&
    n.bounds.y < screen.height * 0.1 && n.bounds.x > screen.width * 0.2 &&
    n.text && !/关注|观看/.test(n.text))?.text;
  const motion = async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(3000);
      const a = await playerPixels(await device.screenshotPng());
      await sleep(1800);
      const b = await playerPixels(await device.screenshotPng());
      if (!a.length || a.length !== b.length) throw new Error('央视频播放器截图解码失败');
      let difference = 0, lit = 0;
      for (let i = 0; i < a.length; i++) {
        difference += Math.abs(a[i] - b[i]);
        if (b[i] > 30) lit++;
      }
      if (lit / b.length >= 0.05 && difference / a.length >= 0.8) return;
    }
    throw new Error('央视频播放器持续黑屏或画面未变化');
  };
  report('打开央视频首页中部直播');
  await device.forceStopPackage(app.packageName);
  await device.launchPackage(app.packageName);
  await sleep(5000);
  const homeSnapshot = await poll(s => entries(s).some(n => /热门赛事|热门看点/.test(n.text)) && entries(s).some(n => n.text === '首页'), '央视频首页未加载完成');
  const television = entries(homeSnapshot).find(n =>
    n.text === '电视' && n.bounds && n.bounds.y > screen.height * 0.9,
  );
  if (!television) throw new Error('央视频未找到底部电视入口');
  if (television) {
    await foreground();
    await device.tap({
      x: Math.round(television.bounds.x + television.bounds.w / 2),
      y: Math.round(television.bounds.y + television.bounds.h / 2),
    });
    await sleep(800);
  }
  const liveTab = await poll(s => Boolean(yangshipinLiveTabPoint(s, screen)), '央视频未找到顶部直播频道');
  await device.tap(yangshipinLiveTabPoint(liveTab, screen));
  const livePage = await poll(
    s => isYangshipinLiveRoom(s) || Boolean(yangshipinLiveEntryCardPoint(s, screen)),
    '央视频直播频道未加载完成',
  );
  if (!isYangshipinLiveRoom(livePage)) {
    const liveCard = yangshipinLiveEntryCardPoint(livePage, screen);
    if (!liveCard) throw new Error('央视频未找到中部直播卡片');
    await device.tap(liveCard);
  }
  let room = await poll(isYangshipinLiveRoom, '未进入央视频真实直播间');
  report('确认央视频直播画面与直播控件');
  await motion();
  room = await poll(isYangshipinLiveRoom, '央视频直播状态变化');
  checks.push({ id: 'live_room', status: 'passed' }, { id: 'motion', status: 'passed' });
  if (startCapture) await startCapture();
  report('按设置间隔通过右侧更多直播切换');
  const effectiveDurationMs = Math.min(7200000, Math.max(1000, duration));
  const deadline = now() + effectiveDurationMs;
  let selectedTitle = '', switchCount = 0;
  while (now() < deadline) {
    await sleep(Math.min(Math.max(1000, interval), deadline - now()));
    if (deadline - now() < 10000) break;
    room = await poll(isYangshipinLiveRoom, '央视频已离开直播间');
    const before = author(room);
    const handle = entries(room).find(n => n.clickable && n.type === 'Row' && n.bounds &&
      n.bounds.x > screen.width * 0.93 && n.bounds.y > screen.height * 0.4 &&
      n.bounds.y < screen.height * 0.7 && n.bounds.h > screen.height * 0.05 && n.bounds.w < screen.width * 0.1);
    if (handle) {
      await foreground();
      await device.tap({ x: Math.round(handle.bounds.x + handle.bounds.w / 2), y: Math.round(handle.bounds.y + handle.bounds.h / 2) });
    } else await clickText(room, '更多直播', n => n.bounds.x > screen.width * 0.85);
    const sidebar = await poll(s => yangshipinLiveCards(s, screen).length > 0, '央视频更多直播列表未打开');
    const card = yangshipinLiveCards(sidebar, screen).find(c => c.title !== selectedTitle);
    if (!card) throw new Error('央视频没有可切换的其他直播');
    await device.tap({ x: card.x, y: card.y });
    await sleep(2500);
    room = await poll(isYangshipinLiveRoom, '央视频未切换到直播页');
    if (author(room) === before) {
      await clickText(room, '简介');
      await poll(s => entries(s).some(n => n.text === card.title), '央视频切换后的标题与所选直播不一致');
      await clickText(await snapshot(), '评论');
      room = await poll(isYangshipinLiveRoom, '央视频未恢复直播评论页');
    }
    await motion();
    selectedTitle = card.title;
    switchCount++;
  }
  if (now() < deadline) await sleep(deadline - now());
  await poll(isYangshipinLiveRoom, '央视频直播结束校验失败');
  report('央视频直播浏览完成');
  checks.push({ id: 'duration_observed', status: 'passed', detail: `成功切换 ${switchCount} 次` });
  return { validationMode: 'yangshipin_live_browse_v1', validationChecks: checks, effectiveDurationMs, switchCount };
}
