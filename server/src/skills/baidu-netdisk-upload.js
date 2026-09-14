import { startCaptureBeforeAction } from './capture-timing.js';

export const BAIDU_NETDISK_UPLOAD_WORKFLOW_ID =
  'upload-download:baidu-netdisk:upload-file';
export const BAIDU_NETDISK_UPLOAD_VALIDATION_MODE = 'baidu_netdisk_upload_v2';

export async function executeBaiduNetdiskUpload({
  device,
  app,
  mediaType = 'image',
  startCapture = null,
  sleep = wait,
  onStep = () => {},
}) {
  if (app?.id !== 'baidu-netdisk') throw new Error('百度网盘上传仅支持百度网盘');
  if (mediaType === 'video') throw new Error('百度网盘视频上传暂不支持（需要 VIP）');

  const screen = await device.getScreenSize();
  let step = 0;
  const stage = async (label, action) => {
    step += 1;
    onStep(step, label, 8);
    await action();
  };
  const snap = () => device.getUiTextSnapshot();
  const tapText = async (labels, minY = 0, { optional = false } = {}) => {
    const wanted = Array.isArray(labels) ? labels : [labels];
    let node;
    for (let attempt = 0; attempt < 12 && !node; attempt += 1) {
      node = flat(await snap()).find(
        (value) => value.y >= minY && wanted.includes(textOf(value)),
      );
      if (!node) await sleep(400);
    }
    if (!node) {
      if (optional) return false;
      throw new Error(`百度网盘未找到 ${wanted.join('/')}`);
    }
    await device.tap({ x: Math.round(node.x), y: Math.round(node.y) });
    await sleep(900);
    return true;
  };

  await stage('打开文件页', async () => {
    await device.forceStopPackage(app.packageName);
    await device.launchPackage(app.packageName);
    await sleep(1800);
    await device.tapText?.(['本次使用允许', '始终允许'], { optional: true });
    await sleep(400);
    await tapText('文件', screen.height * 0.8);
  });

  await stage('打开上传菜单', async () => {
    const node = flat(await snap())
      .filter(
        (value) =>
          value.clickable === 'true' &&
          value.y > screen.height * 0.72 &&
          value.y < screen.height * 0.89 &&
          value.x > screen.width * 0.8,
      )
      .sort((left, right) => right.y - left.y)[0];
    if (!node) throw new Error('百度网盘未找到右下角加号');
    await device.tap({ x: Math.round(node.x), y: Math.round(node.y) });
    await sleep(700);
  });

  await stage('选择上传类型', async () => {
    if (mediaType === 'image') {
      await tapText(['照片', '图片']);
    } else {
      await tapText(['其他文件', '文档']);
    }
  });

  await stage(`打开${mediaType === 'document' ? '文档' : '图片'}选择器`, async () => {
    await waitForSnapshot({
      device,
      predicate: (value) =>
        flat(value).some((node) => textOf(node) === '完成') &&
        flat(value).some((node) =>
          ['最近', '浏览', '所有图片', '已选 0/500'].includes(textOf(node)),
        ),
      timeoutMs: 10000,
      sleep,
      message: '百度网盘系统选择器未打开',
    });
    if (mediaType === 'image') await tapText('所有图片', 0, { optional: true });
  });

  await stage('全选待上传文件', async () => {
    if (mediaType === 'image') {
      await selectAllImages({ device, screen, sleep, snap, tapText });
    } else {
      await tapText('全选', 0, { optional: true });
      await selectFirstDocument({ device, screen, sleep, snap });
    }
    await startCaptureBeforeAction(startCapture, sleep);
    await tapText('完成', screen.height * 0.75);
  });

  await stage('等待上传完成', () => sleep(3000));

  await stage('打开最近文件', async () => {
    const node = flat(await snap()).find(
      (value) => value.y < screen.height * 0.18 && value.x > screen.width * 0.86,
    );
    if (!node) throw new Error('百度网盘未找到右上角更多');
    await device.tap({ x: Math.round(node.x), y: Math.round(node.y) });
    await sleep(500);
    await tapText('最近文件');
  });

  await stage('选择并删除上传内容', async () => {
    const node = flat(await snap()).find(
      (value) => value.y < screen.height * 0.18 && value.x > screen.width * 0.86,
    );
    if (!node) throw new Error('百度网盘未找到选择按钮');
    await device.tap({ x: Math.round(node.x), y: Math.round(node.y) });
    await sleep(500);
    await tapText('全选');
    await tapText('删除', screen.height * 0.7);
    await sleep(500);
    const confirm = flat(await snap()).find((value) => textOf(value) === '确定');
    if (confirm) {
      await device.tap({ x: Math.round(confirm.x), y: Math.round(confirm.y) });
      await sleep(900);
    }
    const afterDelete = await snap();
    if (hasSecurityVerification(afterDelete)) {
      throw new Error('百度网盘出现安全验证，需手动完成后才能确认删除上传内容');
    }
  });

  return {
    validationMode: BAIDU_NETDISK_UPLOAD_VALIDATION_MODE,
    validationChecks: Array.from({ length: step }, (_, index) => ({
      status: 'passed',
      step: index + 1,
    })),
    replayStepIndex: step,
  };
}

async function selectAllImages({ device, screen, sleep, snap, tapText }) {
  if (await tapText('全选', 0, { optional: true })) return;

  // Harmony's current photo picker has no textual 全选 button. It exposes
  // one Checkbox per visible image instead, so select every unchecked media
  // checkbox from the UI tree before confirming.
  for (let pass = 0; pass < 100; pass += 1) {
    const snapshot = await snap();
    const checkbox = flat(snapshot)
      .filter((node) =>
        String(node.type).toLowerCase() === 'checkbox' &&
        node.y > screen.height * 0.25 &&
        node.y < screen.height * 0.88 &&
        node.x < screen.width * 0.8 &&
        String(node.checked) !== 'true',
      )
      .sort((left, right) => left.y - right.y || left.x - right.x)[0];
    if (!checkbox) return;
    await device.tap({ x: Math.round(checkbox.x), y: Math.round(checkbox.y) });
    await sleep(250);
  }
}

async function selectFirstDocument({ device, screen, sleep, snap }) {
  const snapshot = await snap();
  const checkbox = flat(snapshot)
    .filter((node) =>
      String(node.type).toLowerCase() === 'checkbox' &&
      node.y > screen.height * 0.25 &&
      node.y < screen.height * 0.88,
    )
    .sort((left, right) => left.y - right.y || left.x - right.x)[0];
  if (!checkbox) throw new Error('系统文件选择器未找到可选择文档');
  await device.tap({ x: Math.round(checkbox.x), y: Math.round(checkbox.y) });
  await sleep(300);
}

function textOf(node) {
  return [
    node.text,
    node.originalText,
    node.description,
    node.contentDescription,
    node.label,
  ].filter(Boolean).map(String)[0] || '';
}

function hasSecurityVerification(snapshot) {
  return (snapshot?.values || []).some((value) =>
    /安全验证|验证码|滑块|人机验证/.test(String(value)),
  );
}

function flat(snapshot) {
  const output = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    const attributes = node.attributes || node;
    const match = String(attributes.bounds || '').match(
      /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/,
    );
    if (match) {
      output.push({
        ...attributes,
        x: (+match[1] + +match[3]) / 2,
        y: (+match[2] + +match[4]) / 2,
      });
    }
    (node.children || []).forEach(visit);
  };
  visit(snapshot?.layout || snapshot);
  return output;
}

async function waitForSnapshot({ device, predicate, timeoutMs, sleep, message }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await device.getUiTextSnapshot();
    if (predicate(snapshot)) return snapshot;
    await sleep(350);
  }
  throw new Error(message);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
