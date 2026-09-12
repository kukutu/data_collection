const MAX_DURATION_MS = 2 * 60 * 60 * 1000;

export const WELINK_AUDIO_CALL_WORKFLOW_ID = 'voip:welink:audio-call';
export const WELINK_VIDEO_CALL_WORKFLOW_ID = 'voip:welink:video-call';

export async function executeWelinkVoipCall({
  device,
  app,
  callType = 'audio',
  camera = false,
  shareScreen = false,
  durationMs = 30000,
  startCapture = null,
  sleep = wait,
  now = () => Date.now(),
  onStep = () => {},
} = {}) {
  if (app?.id !== 'welink' || !['audio', 'video'].includes(callType)) {
    throw new Error('WeLink 通话类型无效');
  }
  const effectiveDurationMs = Math.min(MAX_DURATION_MS, Math.max(1000, Number(durationMs) || 30000));
  const checks = [];
  let step = 0;
  let initiated = false;
  const stage = async (id, label, action) => {
    step += 1;
    onStep(step, label, 6);
    try {
      const value = await action();
      checks.push({ id, status: 'passed' });
      return value;
    } catch (error) {
      checks.push({ id, status: 'failed', detail: error.message });
      throw error;
    }
  };
  const snapshot = () => device.getUiTextSnapshot({ attempts: 2, timeoutMs: 8000 });
  const foreground = async () => {
    const focus = await device.getCurrentFocus?.().catch(() => null);
    const names = [app.packageName, app.harmonyBundleName].filter(Boolean);
    if (focus?.packageName && !names.includes(focus.packageName) && !names.includes(focus.bundleName)) {
      throw new Error('当前前台不是 WeLink');
    }
  };
  const tapNode = async (node) => {
    if (!node?.bounds) throw new Error('WeLink 目标控件不可用');
    await device.tap({ x: node.centerX, y: node.centerY });
  };
  const waitText = async (texts, predicate = () => true) => {
    const expected = Array.isArray(texts) ? texts : [texts];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = await snapshot();
      const node = flatten(current).find((candidate) =>
        expected.some((text) => candidate.textValues.some((value) => text instanceof RegExp ? text.test(value) : value === text)) && predicate(candidate, current),
      );
      if (node) return { node, snapshot: current };
      await sleep(400);
    }
    throw new Error(`WeLink 未出现控件: ${expected.join('/')}`);
  };
  const waitClickableWithText = async (text) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = await snapshot();
      const node = findClickableAncestor(current, text);
      if (node) return { node, snapshot: current };
      await sleep(400);
    }
    throw new Error(`WeLink 未出现可点击控件: ${text}`);
  };
  const tapMenuItem = async (node, label) => {
    const points = [
      [node.centerX, node.centerY],
      [node.centerX, node.bounds.y2 - 24],
      [node.centerX, node.bounds.y1 + 32],
    ];
    for (const [x, y] of points) {
      await device.tap({ x, y });
      await sleep(700);
      const current = await snapshot();
      if (!hasLayoutText(current, label) || isConnected(current)) return;
    }
    throw new Error(`WeLink 未触发${label}菜单项`);
  };
  const hangup = async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const current = await snapshot();
      const node = flatten(current).find((candidate) =>
        ['挂断', '结束通话', '结束会议'].some((text) => candidate.textValues.includes(text)) ||
        ['handup', 'HWMHeaderMenuItemHangup'].includes(candidate.id),
      );
      if (!node) {
        if (hasLayoutText(current, '消息') || hasLayoutText(current, '通讯录') ||
          flatten(current).some((candidate) => /^welink\.im_ChatDetail/.test(candidate.id))) return;
        if (isMeetingPage(current)) {
          const surface = flatten(current).find((candidate) => ['HWMVideoItem', 'maxVideo'].includes(candidate.id)) ||
            flatten(current).find((candidate) => candidate.id === 'meeting_page_root');
          await tapNode(surface || { bounds: { x1: 0, y1: 0, x2: 1280, y2: 2832 }, centerX: 640, centerY: 1400 });
          await sleep(500);
        }
      } else {
        await tapNode(node);
        await sleep(700);
        const leave = findClickableAncestor(await snapshot(), '离开会议');
        if (leave) {
          await tapNode(leave);
          await sleep(900);
        } else if (isMeetingPage(await snapshot())) {
          // The first tap can only reveal the end control on HarmonyOS.
          await tapNode(node);
          await sleep(700);
          const confirmedLeave = findClickableAncestor(await snapshot(), '离开会议');
          if (confirmedLeave) {
            await tapNode(confirmedLeave);
            await sleep(900);
          }
        }
      }
      await sleep(400);
    }
    throw new Error('WeLink 未确认通话正常结束');
  };

  try {
    await stage('first_contact_opened', '打开 WeLink 消息页首个联系人', async () => {
      await device.forceStopPackage?.(app.packageName);
      await device.launchPackage(app.packageName);
      await sleep(3000);
      await foreground();
      const current = await snapshot();
      const first = flatten(current).find((node) =>
        /^im_home_list_drawer/.test(node.id) && node.bounds.y1 > 600 && node.bounds.y1 < 1300,
      );
      // If the app restored the first conversation, reuse it; the name is intentionally not fixed.
      if (hasLayoutText(current, '发送') && findChatInput(current)) return;
      if (!first) throw new Error('未找到 WeLink 消息页首个联系人');
      await tapNode(first);
      await sleep(700);
    });

    await stage('call_started', `发起 WeLink ${callType === 'video' ? '视频' : '音频'}通话`, async () => {
      let current = await snapshot();
      if (!hasLayoutText(current, '发送')) {
        throw new Error('WeLink 当前未处于联系人聊天页');
      }
      const plusIcon = flatten(current).find((node) => node.id === 'im_chat_tool_bar_more');
      const plusCandidates = flatten(current).filter((node) =>
        node.bounds.x1 > 0.82 * 1280 && node.bounds.y1 > 0.45 * 2832 &&
        node.bounds.x2 <= 1280 && node.bounds.y2 <= 2832 &&
        String(node.clickable).toLowerCase() === 'true',
      ).sort((a, b) => b.centerX - a.centerX || b.centerY - a.centerY);
      const plus = plusIcon || plusCandidates[0];
      if (!plus) throw new Error('WeLink 消息页未找到右下角加号');
      await tapNode(plus);
      const menuLabel = callType === 'audio' ? '语音通话' : '视频会议';
      let menuItem;
      try {
        menuItem = await waitClickableWithText(menuLabel);
      } catch {
        // HarmonyOS occasionally drops the first tap while the chat toolbar settles.
        await device.tap({ x: 1182, y: 2643 });
        menuItem = await waitClickableWithText(menuLabel);
      }
      const knownMeetingCards = findMeetingCards(current).map((card) => card.key);
      if (callType === 'video') {
        await tapNode(menuItem.node);
        let card = null;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          current = await snapshot();
          if (isMeetingPage(current)) {
            card = { key: '__direct_meeting__' };
            break;
          }
          card = findMeetingCards(current).find((candidate) => !knownMeetingCards.includes(candidate.key));
          if (card) {
            await tapNode(card);
            break;
          }
          await sleep(500);
        }
        if (!card) throw new Error('WeLink 未找到刚创建的视频会议卡片');
        if (card.key !== '__direct_meeting__') {
          for (let attempt = 0; attempt < 20; attempt += 1) {
            current = await snapshot();
            if (isMeetingPage(current)) break;
            await sleep(500);
          }
        }
        if (!isMeetingPage(current)) throw new Error('WeLink 点击会议卡片后未进入视频会议');
      } else {
        await tapMenuItem(menuItem.node, menuLabel);
      }
      current = await snapshot();
      const currentAfterEntry = current;
      if (hasLayoutText(currentAfterEntry, 'WeLink拨打')) {
        const terminal = await waitText('软终端');
        await tapNode(terminal.node);
      }
      initiated = true;
    });

    await stage('call_connected', '等待 WeLink 通话接通', async () => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const current = await snapshot();
        if (isConnected(current)) {
          const cancel = findClickableAncestor(current, '取消');
          if (cancel && hasLayoutText(current, '是否需要查询未入会人员?')) {
            await tapNode(cancel);
            await sleep(500);
          }
          return current;
        }
        await sleep(800);
      }
      throw new Error('WeLink 等待通话接通超时');
    });

    await stage('options_applied', '设置 WeLink 视频和共享屏幕选项', async () => {
      let current = await snapshot();
      if (callType === 'video') {
        // Controls auto-hide on HarmonyOS. Only wake the surface when the
        // elapsed-time/hangup controls are absent; tapping an already visible
        // surface hides them again.
        if (!hasMeetingControls(current)) {
          const surface = flatten(current).find((node) => ['HWMVideoItem', 'maxVideo'].includes(node.id)) ||
            flatten(current).find((node) => node.id === 'meeting_page_root');
          await tapNode(surface || { bounds: { x1: 0, y1: 0, x2: 1280, y2: 2832 }, centerX: 640, centerY: 1400 });
          await sleep(500);
          current = await snapshot();
        }
      }
      if (camera) {
        const state = getCameraState(current);
        const toggle = findMeetingControl(current, '视频') || findAnyText(current, ['开启摄像头', '打开摄像头', '摄像头']);
        if (state !== true && toggle) {
          await tapNode(toggle);
          await sleep(700);
          current = await snapshot();
          const allowCamera = findPermissionButton(current, /相机|摄像头/);
          if (allowCamera) {
            await tapNode(allowCamera);
            await sleep(700);
            current = await snapshot();
          }
        }
        // Permission acceptance can hide the toolbar again. Reveal it once
        // before reading the camera button state, otherwise a successful
        // toggle is indistinguishable from a missing control.
        if (getCameraState(current) === null && isMeetingPage(current)) {
          const surface = flatten(current).find((node) => ['HWMVideoItem', 'maxVideo'].includes(node.id)) ||
            flatten(current).find((node) => node.id === 'meeting_page_root');
          await tapNode(surface || { bounds: { x1: 0, y1: 0, x2: 1280, y2: 2832 }, centerX: 640, centerY: 1400 });
          await sleep(500);
          current = await snapshot();
        }
        if (getCameraState(current) !== true) throw new Error('WeLink 摄像头状态未确认开启');
      }
      if (shareScreen) {
        current = await snapshot();
        if (isScreenSharing(current)) return;
        const sideItems = flatten(current).filter((node) => /^HWMSideMenuItem-/.test(node.id));
        const more = findMeetingControl(current, '更多');
        if (!sideItems.length && more) {
          await tapNode(more);
          await sleep(400);
          current = await snapshot();
        }
        const share = findMeetingControl(current, '共享屏幕') || findMeetingControl(current, '屏幕共享') ||
          findMeetingControl(current, '演示屏幕') || findMeetingControl(current, '屏幕演示') ||
          findAnyText(current, ['共享屏幕', '屏幕共享', '演示屏幕', '屏幕演示']);
        // This Harmony build exposes screen sharing as the first icon in the
        // side action list, without an accessibility label. The action is
        // accepted only after a sharing-active state is observed.
        const shareAction = share || flatten(current).find((node) => node.id === 'HWMSideMenuItem-91');
        if (!shareAction) throw new Error('WeLink 未找到共享屏幕控件');
        await tapNode(shareAction);
        for (let attempt = 0; attempt < 12; attempt += 1) {
          await sleep(700);
          current = await snapshot();
          const permission = findPermissionButton(current, /屏幕|投屏|录制/);
          if (permission) {
            await tapNode(permission);
            continue;
          }
          if (isScreenSharing(current)) break;
        }
        if (!isScreenSharing(current)) throw new Error('WeLink 共享屏幕未确认生效');
      }
    });

    await stage('duration_observed', '按设置时长保持 WeLink 通话', async () => {
      await startCapture?.();
      const started = now();
      while (now() - started < effectiveDurationMs) {
        await sleep(Math.min(5000, effectiveDurationMs - (now() - started)));
        if (!isConnected(await snapshot())) throw new Error('WeLink 通话中断');
      }
    });

    await stage('normal_hangup', '正常结束 WeLink 通话', hangup);
    initiated = false;
    return {
      validationMode: `welink_${callType}_call_v1`,
      validationChecks: checks,
      effectiveDurationMs,
    };
  } finally {
    if (initiated) {
      try {
        await hangup();
      } catch {
        // A failed screen-share transition can leave MeetingAbility without
        // controls. Reclaim only this app after the normal hangup attempts.
        await device.forceStopPackage?.(app.packageName).catch(() => {});
      }
    }
  }
}

export function isConnected(snapshot) {
  const nodes = flatten(snapshot);
  const meeting = nodes.some((node) => node.id === 'meeting_page_root') &&
    (nodes.some((node) => node.id === 'HWMVideoItem') ||
      nodes.some((node) => node.id === 'confTimeSection-ElapsedTime' &&
        node.textValues.some((text) => /^\d{1,2}:\d{2}$/.test(text))));
  const classic = nodes.some((node) => node.textValues.some((text) => /挂断|结束通话|结束会议/.test(text))) &&
    nodes.some((node) => node.textValues.some((text) => /^\d{1,2}:\d{2}$/.test(text)));
  return meeting || classic;
}

export function hasMeetingControls(snapshot) {
  const nodes = flatten(snapshot);
  return nodes.some((node) => node.id === 'HWMHeaderMenuItemHangup') &&
    nodes.some((node) => node.id === 'confTimeSection-ElapsedTime');
}

export function getCameraState(snapshot) {
  const nodes = flatten(snapshot);
  if (nodes.some((node) => node.id === 'HWMConfCtrlMenuItem-2-0')) return true;
  if (nodes.some((node) => node.id === 'HWMConfCtrlMenuItem-2-1')) return false;
  return null;
}

export function isScreenSharing(snapshot) {
  const values = snapshot?.values || [];
  return values.some((value) => /正在共享屏幕|停止共享|共享屏幕中|正在投屏/.test(value));
}

function findPermissionButton(snapshot, subject) {
  const nodes = flatten(snapshot);
  const hasPrompt = nodes.some((node) => node.textValues.some((value) => subject.test(value)));
  if (!hasPrompt) return null;
  return nodes.find((node) => node.textValues.some((value) => /^(允许|开始投屏|开始录制)$/.test(value)) &&
    String(node.clickable).toLowerCase() === 'true') || null;
}

function findMeetingControl(snapshot, text) {
  const visit = (node, ancestors = []) => {
    if (!node || typeof node !== 'object') return null;
    const attributes = node.attributes || node;
    const path = [...ancestors, attributes];
    const hasLabel = [attributes.text, attributes.originalText, attributes.description, attributes.contentDescription]
      .filter(Boolean).map(String).includes(text) ||
      (node.children || []).some((child) => containsExactText(child, text));
    if (hasLabel) {
      const candidate = [...path].reverse().find((entry) =>
        String(entry.clickable).toLowerCase() === 'true' &&
        (String(entry.id || '').startsWith('HWM') || parseBounds(entry.bounds)?.y1 > 2300),
      );
      const bounds = parseBounds(candidate?.bounds);
      if (candidate && bounds) {
        return {
          ...candidate,
          id: candidate.id || '',
          bounds,
          centerX: Math.round((bounds.x1 + bounds.x2) / 2),
          centerY: Math.round((bounds.y1 + bounds.y2) / 2),
          textValues: [candidate.text, candidate.originalText, candidate.description, candidate.contentDescription]
            .filter(Boolean).map(String),
        };
      }
    }
    for (const child of node.children || []) {
      const match = visit(child, path);
      if (match) return match;
    }
    return null;
  };
  return visit(snapshot?.layout);
}

function containsExactText(node, text) {
  if (!node || typeof node !== 'object') return false;
  const attributes = node.attributes || node;
  if ([attributes.text, attributes.originalText, attributes.description, attributes.contentDescription]
    .filter(Boolean).map(String).includes(text)) return true;
  return (node.children || []).some((child) => containsExactText(child, text));
}

function isMeetingPage(snapshot) {
  return flatten(snapshot).some((node) => node.id === 'meeting_page_root');
}

function findAnyText(snapshot, texts) {
  return flatten(snapshot).find((node) => texts.some((text) => node.textValues.includes(text))) || null;
}

function hasText(snapshot, text) {
  return (snapshot?.values || []).includes(text);
}

function hasLayoutText(snapshot, text) {
  return flatten(snapshot).some((node) => node.textValues.includes(text));
}

function findChatInput(snapshot) {
  return flatten(snapshot).find((node) =>
    /im_chat_input_area|输入消息|请输入/.test(`${node.id} ${node.textValues.join(' ')}`),
  ) || null;
}

function findClickableAncestor(snapshot, text) {
  const visit = (node) => {
    if (!node || typeof node !== 'object') return null;
    const attributes = node.attributes || node;
    const children = node.children || [];
    const ownText = [attributes.text, attributes.originalText, attributes.description, attributes.contentDescription]
      .filter(Boolean).map(String).includes(text);
    const containsText = ownText || children.some((child) => containsTextInTree(child, text));
    // Descend first so a page-level clickable container cannot mask the actual control.
    for (const child of children) {
      const match = visit(child);
      if (match) return match;
    }
    if (containsText && String(attributes.clickable).toLowerCase() === 'true') {
      const bounds = parseBounds(attributes.bounds);
      if (bounds) {
        return {
          ...attributes,
          id: attributes.id || '',
          bounds,
          centerX: Math.round((bounds.x1 + bounds.x2) / 2),
          centerY: Math.round((bounds.y1 + bounds.y2) / 2),
          textValues: [attributes.text, attributes.originalText, attributes.description, attributes.contentDescription].filter(Boolean).map(String),
        };
      }
    }
    return null;
  };
  return visit(snapshot?.layout);
}

function containsTextInTree(node, text) {
  if (!node || typeof node !== 'object') return false;
  const attributes = node.attributes || node;
  if ([attributes.text, attributes.originalText, attributes.description, attributes.contentDescription]
    .filter(Boolean).map(String).some((value) => value === text || value.includes(text))) return true;
  return (node.children || []).some((child) => containsTextInTree(child, text));
}

function findMeetingCards(snapshot) {
  const result = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    const attributes = node.attributes || node;
    const bounds = parseBounds(attributes.bounds);
    if (bounds && bounds.x2 - bounds.x1 <= 1000 && bounds.y2 - bounds.y1 <= 600 &&
      String(attributes.clickable).toLowerCase() === 'true' && containsTextInTree(node, '会议ID')) {
      const texts = collectTexts(node).filter((text) => text.includes('会议ID'));
      result.push({
        ...attributes,
        bounds,
        centerX: Math.round((bounds.x1 + bounds.x2) / 2),
        centerY: Math.round((bounds.y1 + bounds.y2) / 2),
        textValues: [],
        key: texts.join('|'),
      });
      return;
    }
    for (const child of node.children || []) visit(child);
  };
  visit(snapshot?.layout);
  return result.sort((a, b) => a.bounds.y2 - b.bounds.y2);
}

function collectTexts(node) {
  if (!node || typeof node !== 'object') return [];
  const attributes = node.attributes || node;
  return [attributes.text, attributes.originalText].filter(Boolean).map(String)
    .concat((node.children || []).flatMap((child) => collectTexts(child)));
}

function parseBounds(value) {
  const match = String(value || '').match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  return match ? { x1: Number(match[1]), y1: Number(match[2]), x2: Number(match[3]), y2: Number(match[4]) } : null;
}

function flatten(snapshot) {
  const result = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    const attributes = node.attributes || node;
    const match = String(attributes.bounds || '').match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    if (match) {
      const bounds = { x1: Number(match[1]), y1: Number(match[2]), x2: Number(match[3]), y2: Number(match[4]) };
      result.push({
        ...attributes,
        id: attributes.id || '',
        bounds,
        centerX: Math.round((bounds.x1 + bounds.x2) / 2),
        centerY: Math.round((bounds.y1 + bounds.y2) / 2),
        textValues: [attributes.text, attributes.originalText, attributes.description, attributes.contentDescription].filter(Boolean).map(String),
      });
    }
    for (const child of node.children || []) visit(child);
  };
  visit(snapshot?.layout);
  return result;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
