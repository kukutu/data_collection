const state = {
  currentTaskId: null,
  pollTimer: null,
  apps: [],
  activeBuilder: null,
};

const SUPPORTED_LIVE_ENTRY_APP_IDS = new Set(['douyin', 'taobao', 'jd', 'wechat', 'xiaohongshu']);

const builders = {
  'short-video': {
    title: '短视频任务',
    verb: '刷',
    defaultDuration: 30,
    defaultUnit: '秒',
    appOptions: (apps) => [
      ...apps
        .filter((app) => app.installed && app.skill === 'short_video_feed')
        .map((app) => ({
          label: app.id === 'xiaohongshu' ? '小红书视频' : app.name,
          appName: app.id === 'xiaohongshu' ? '小红书视频' : app.name,
        })),
      ...apps
        .filter((app) => app.installed && app.id === 'wechat')
        .map(() => ({ label: '微信视频号', appName: '微信视频号' })),
    ],
    command: ({ duration, appName }) => `刷${duration}${appName}`,
    emptyMessage: '未检测到已安装且已实现的短视频 App。代码已实现：抖音、小红书视频、快手、西瓜视频、微信视频号；只有已安装 App 会显示。',
  },
  'long-video': {
    title: '长视频任务',
    defaultDuration: 5,
    defaultUnit: '分钟',
    appOptions: (apps) =>
      apps
        .filter((app) => app.installed && ['tencent-video', 'bilibili', 'youku'].includes(app.id))
        .map((app) => ({ label: app.name, appName: app.name })),
    command: ({ duration, appName }) => `看${duration}${appName}`,
    emptyMessage: '未检测到已安装且已实现的长视频 App。当前长视频已实现：腾讯视频、B站、优酷。',
  },
  live: {
    title: '直播任务',
    defaultDuration: 5,
    defaultUnit: '分钟',
    appOptions: (apps) =>
      apps
        .filter((app) => app.installed && SUPPORTED_LIVE_ENTRY_APP_IDS.has(app.id))
        .map((app) => ({ label: app.name, appName: app.name })),
    command: ({ duration, appName }) => `看${duration}${appName}直播`,
    emptyMessage: '未检测到已安装的已验证直播 App。当前支持：抖音、淘宝、京东、微信、小红书。',
  },
  navigation: {
    title: '导航任务',
    defaultDuration: 5,
    defaultUnit: '分钟',
    needsDestination: true,
    defaultDestination: '北京站',
    appOptions: (apps) =>
      apps
        .filter((app) => app.installed && app.id === 'amap')
        .map((app) => ({ label: app.name, appName: app.name })),
    command: ({ duration, appName, destination }) => `${appName}导航到${destination}${duration}`,
    emptyMessage: '未检测到已安装且已实现的导航 App。当前导航已实现：高德地图。',
  },
  'ai-chat': {
    title: 'AI 应用任务',
    defaultDuration: 5,
    defaultUnit: '分钟',
    appOptions: (apps) =>
      apps
        .filter((app) => app.installed && ['doubao', 'qianwen'].includes(app.id))
        .map((app) => ({ label: app.name, appName: app.name })),
    command: ({ duration, appName }) => `和${appName}聊天${duration}`,
    emptyMessage: '未检测到已安装且已实现的 AI 应用。当前 AI 应用已实现：豆包、千问。',
  },
};

const elements = {
  taskForm: document.querySelector('#taskForm'),
  taskText: document.querySelector('#taskText'),
  apiKey: document.querySelector('#apiKey'),
  parseMode: document.querySelector('#parseMode'),
  stopBtn: document.querySelector('#stopBtn'),
  logs: document.querySelector('#logs'),
  taskState: document.querySelector('#taskState'),
  deviceLine: document.querySelector('#deviceLine'),
  statusPill: document.querySelector('#statusPill'),
  quickTaskDialog: document.querySelector('#quickTaskDialog'),
  dialogTitle: document.querySelector('#dialogTitle'),
  dialogCloseBtn: document.querySelector('#dialogCloseBtn'),
  builderApp: document.querySelector('#builderApp'),
  builderDuration: document.querySelector('#builderDuration'),
  builderUnit: document.querySelector('#builderUnit'),
  builderDestinationWrap: document.querySelector('#builderDestinationWrap'),
  builderDestination: document.querySelector('#builderDestination'),
  builderMessage: document.querySelector('#builderMessage'),
  fillTaskBtn: document.querySelector('#fillTaskBtn'),
  runBuiltTaskBtn: document.querySelector('#runBuiltTaskBtn'),
  confirmDialog: document.querySelector('#confirmDialog'),
  confirmMessage: document.querySelector('#confirmMessage'),
  confirmStopBtn: document.querySelector('#confirmStopBtn'),
  continueBtn: document.querySelector('#continueBtn'),
};

elements.taskForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await startTask(elements.taskText.value);
});

elements.stopBtn.addEventListener('click', async () => {
  if (!state.currentTaskId) return;
  await fetch(`/api/tasks/${state.currentTaskId}/stop`, { method: 'POST' });
  closeConfirmDialog();
  await pollTask();
});

elements.continueBtn.addEventListener('click', async () => {
  if (!state.currentTaskId) return;
  elements.continueBtn.disabled = true;
  try {
    await fetch(`/api/tasks/${state.currentTaskId}/continue`, { method: 'POST' });
    closeConfirmDialog();
    await pollTask();
  } finally {
    elements.continueBtn.disabled = false;
  }
});

elements.confirmStopBtn.addEventListener('click', async () => {
  if (!state.currentTaskId) return;
  elements.confirmStopBtn.disabled = true;
  try {
    await fetch(`/api/tasks/${state.currentTaskId}/stop`, { method: 'POST' });
    closeConfirmDialog();
    await pollTask();
  } finally {
    elements.confirmStopBtn.disabled = false;
  }
});

document.querySelectorAll('[data-command]').forEach((button) => {
  button.addEventListener('click', () => {
    elements.taskText.value = button.dataset.command;
    elements.taskText.focus();
  });
});

document.querySelectorAll('[data-builder]').forEach((button) => {
  button.addEventListener('click', async () => {
    await openBuilder(button.dataset.builder);
  });
});

elements.dialogCloseBtn.addEventListener('click', () => {
  elements.quickTaskDialog.close();
});

elements.fillTaskBtn.addEventListener('click', () => {
  const command = buildCommandFromDialog();
  if (!command) return;
  elements.taskText.value = command;
  elements.quickTaskDialog.close();
  elements.taskText.focus();
});

elements.runBuiltTaskBtn.addEventListener('click', async () => {
  const command = buildCommandFromDialog();
  if (!command) return;
  elements.taskText.value = command;
  elements.quickTaskDialog.close();
  await startTask(command);
});

async function startTask(taskText) {
  const response = await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      taskText,
      apiKey: elements.apiKey.value.trim(),
      parseMode: elements.parseMode.value,
      useModel: elements.parseMode.value === 'api',
    }),
  });
  const task = await response.json();
  state.currentTaskId = task.id;
  renderTask(task);
  startPolling();
}

async function openBuilder(builderId) {
  const builder = builders[builderId];
  if (!builder) return;

  state.activeBuilder = builderId;
  await refreshApps();

  const apps = builder.appOptions(state.apps);
  elements.dialogTitle.textContent = builder.title;
  elements.builderDuration.value = builder.defaultDuration;
  elements.builderUnit.value = builder.defaultUnit;
  elements.builderDestination.value = builder.defaultDestination || '';
  elements.builderDestinationWrap.hidden = !builder.needsDestination;
  elements.builderApp.replaceChildren(
    ...apps.map((app) => {
      const option = document.createElement('option');
      option.value = app.appName;
      option.textContent = app.label;
      return option;
    }),
  );

  const hasApps = apps.length > 0;
  elements.builderApp.disabled = !hasApps;
  elements.builderDuration.disabled = !hasApps;
  elements.builderUnit.disabled = !hasApps;
  elements.builderDestination.disabled = !hasApps;
  elements.fillTaskBtn.disabled = !hasApps;
  elements.runBuiltTaskBtn.disabled = !hasApps;
  elements.builderMessage.textContent = hasApps ? '' : builder.emptyMessage;
  if (hasApps && builder.warning) elements.builderMessage.textContent = builder.warning;

  elements.quickTaskDialog.showModal();
}

function buildCommandFromDialog() {
  const builder = builders[state.activeBuilder];
  if (!builder || !elements.builderApp.value) return '';

  const amount = Number(elements.builderDuration.value);
  if (!Number.isFinite(amount) || amount <= 0) {
    elements.builderMessage.textContent = '时长必须大于 0。';
    elements.builderDuration.focus();
    return '';
  }

  const duration = `${Math.round(amount)}${elements.builderUnit.value}`;
  const destination = elements.builderDestination.value.trim();
  if (builder.needsDestination && !destination) {
    elements.builderMessage.textContent = '目的地不能为空。';
    elements.builderDestination.focus();
    return '';
  }

  return builder.command({
    duration,
    appName: elements.builderApp.value,
    destination,
  });
}

function startPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(pollTask, 1000);
  pollTask();
}

async function pollTask() {
  if (!state.currentTaskId) return;
  const response = await fetch(`/api/tasks/${state.currentTaskId}`);
  const task = await response.json();
  renderTask(task);

  if (['completed', 'failed', 'blocked', 'stopped'].includes(task.status)) {
    clearInterval(state.pollTimer);
    await refreshDevice();
  }
}

function renderTask(task) {
  elements.taskState.textContent = `${task.status || 'unknown'} ${task.stepIndex || 0}/${task.totalSteps || 0}`;
  elements.confirmMessage.textContent = task.pendingConfirmation?.message || '';
  setConfirmDialogOpen(task.status === 'waiting_confirmation');
  elements.logs.textContent = (task.logs || [])
    .map((entry) => `${new Date(entry.at).toLocaleTimeString()}  ${entry.message}`)
    .join('\n');
  elements.logs.scrollTop = elements.logs.scrollHeight;
}

function setConfirmDialogOpen(open) {
  if (!elements.confirmDialog) return;
  if (open && !elements.confirmDialog.open) {
    elements.confirmDialog.showModal();
  }
  if (!open && elements.confirmDialog.open) {
    elements.confirmDialog.close();
  }
}

function closeConfirmDialog() {
  setConfirmDialogOpen(false);
}

async function refreshDevice() {
  const response = await fetch('/api/device');
  const device = await response.json();

  elements.statusPill.classList.toggle('connected', Boolean(device.connected));
  elements.statusPill.textContent = device.connected ? '已连接' : '未连接';
  elements.deviceLine.textContent = device.connected
    ? `${device.model || 'Android'} · ${device.serial} · ${device.focus?.packageName || '无前台应用'}`
    : '未检测到 ADB 设备';
}

async function refreshApps() {
  const response = await fetch('/api/apps');
  state.apps = await response.json();
}

async function resumeCurrentTask() {
  const response = await fetch('/api/tasks/current');
  const task = await response.json();
  if (!task?.id || !['running', 'waiting_confirmation'].includes(task.status)) return;
  state.currentTaskId = task.id;
  renderTask(task);
  startPolling();
}

await Promise.all([refreshDevice(), refreshApps()]);
await resumeCurrentTask();
setInterval(refreshDevice, 5000);
