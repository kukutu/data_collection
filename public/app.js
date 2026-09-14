const state = {
  currentTaskId: null,
  pollTimer: null,
  apps: [],
  workflows: [],
  activeWorkflowId: null,
  activeWorkflowCategoryId: null,
  recordingId: null,
  recordingPollTimer: null,
  recordings: [],
};

const CAPTURE_STORAGE_KEY = 'phone-controller-capture-settings';

const elements = {
  taskForm: document.querySelector('#taskForm'),
  taskText: document.querySelector('#taskText'),
  apiKey: document.querySelector('#apiKey'),
  parseMode: document.querySelector('#parseMode'),
  captureEnabled: document.querySelector('#captureEnabled'),
  captureFields: document.querySelector('#captureFields'),
  captureInterface: document.querySelector('#captureInterface'),
  capturePhoneIp: document.querySelector('#capturePhoneIp'),
  captureOutputRoot: document.querySelector('#captureOutputRoot'),
  captureRecordScreen: document.querySelector('#captureRecordScreen'),
  captureRecordPortMapping: document.querySelector('#captureRecordPortMapping'),
  captureExtractorScript: document.querySelector('#captureExtractorScript'),
  recordingApp: document.querySelector('#recordingApp'),
  recordingFeature: document.querySelector('#recordingFeature'),
  recordingParameters: document.querySelector('#recordingParameters'),
  recordingParameterHint: document.querySelector('#recordingParameterHint'),
  startRecordingBtn: document.querySelector('#startRecordingBtn'),
  stopRecordingBtn: document.querySelector('#stopRecordingBtn'),
  repairRecordingBtn: document.querySelector('#repairRecordingBtn'),
  replayRecordingBtn: document.querySelector('#replayRecordingBtn'),
  recordingState: document.querySelector('#recordingState'),
  recordingMessage: document.querySelector('#recordingMessage'),
  recordingOutput: document.querySelector('#recordingOutput'),
  stopBtn: document.querySelector('#stopBtn'),
  logs: document.querySelector('#logs'),
  taskState: document.querySelector('#taskState'),
  captureResult: document.querySelector('#captureResult'),
  captureState: document.querySelector('#captureState'),
  captureOutput: document.querySelector('#captureOutput'),
  deviceLine: document.querySelector('#deviceLine'),
  statusPill: document.querySelector('#statusPill'),
  quickTaskDialog: document.querySelector('#quickTaskDialog'),
  dialogTitle: document.querySelector('#dialogTitle'),
  dialogCloseBtn: document.querySelector('#dialogCloseBtn'),
  builderApp: document.querySelector('#builderApp'),
  builderFunction: document.querySelector('#builderFunction'),
  builderParameters: document.querySelector('#builderParameters'),
  builderMessage: document.querySelector('#builderMessage'),
  fillTaskBtn: document.querySelector('#fillTaskBtn'),
  runBuiltTaskBtn: document.querySelector('#runBuiltTaskBtn'),
  appCatalog: document.querySelector('#appCatalog'),
  confirmDialog: document.querySelector('#confirmDialog'),
  confirmMessage: document.querySelector('#confirmMessage'),
  confirmStopBtn: document.querySelector('#confirmStopBtn'),
  continueBtn: document.querySelector('#continueBtn'),
};

elements.taskForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await startTask(elements.taskText.value);
});

elements.captureEnabled.addEventListener('change', updateCaptureFields);

elements.recordingApp.addEventListener('change', () => {
  resetRecordingView();
  populateRecordingFeatures();
});
elements.recordingFeature.addEventListener('change', () => {
  resetRecordingView();
  renderRecordingParameters();
});
elements.startRecordingBtn.addEventListener('click', startRecording);
elements.stopRecordingBtn.addEventListener('click', stopRecording);
elements.repairRecordingBtn.addEventListener('click', repairRecording);
elements.replayRecordingBtn.addEventListener('click', replayRecording);

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

elements.dialogCloseBtn.addEventListener('click', () => {
  elements.quickTaskDialog.close();
});
elements.builderApp.addEventListener('change', populateBuilderFunctions);
elements.builderFunction.addEventListener('change', renderBuilderParameters);

elements.fillTaskBtn.addEventListener('click', () => {
  const command = buildWorkflowCommandFromDialog();
  if (!command) return;
  elements.taskText.value = command;
  elements.quickTaskDialog.close();
  elements.taskText.focus();
});

elements.runBuiltTaskBtn.addEventListener('click', async () => {
  const command = buildWorkflowCommandFromDialog();
  if (!command) return;
  const workflow = getWorkflow(elements.builderFunction.value);
  const parameters = readParameterValues(elements.builderParameters, workflow);
  elements.taskText.value = command;
  elements.quickTaskDialog.close();
  await startTask(command, { workflowId: workflow.id, parameters });
});

async function startTask(taskText, workflowPayload = {}) {
  const capture = readCaptureSettings();
  if (capture.enabled && (!capture.interfaceName || !capture.outputRoot)) {
    elements.taskState.textContent = '请填写采集网卡和保存目录';
    return;
  }
  saveCaptureSettings(capture);

  const response = await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      taskText,
      workflowId: workflowPayload.workflowId || null,
      parameters: workflowPayload.parameters || {},
      apiKey: elements.apiKey.value.trim(),
      parseMode: elements.parseMode.value,
      useModel: elements.parseMode.value === 'api',
      capture,
    }),
  });
  const task = await response.json();
  if (!response.ok || !task.id) {
    elements.taskState.textContent = '启动失败';
    elements.logs.textContent = task.error || `HTTP ${response.status}`;
    return;
  }
  state.currentTaskId = task.id;
  renderTask(task);
  startPolling();
}

function getWorkflow(workflowId) {
  return state.workflows.find((workflow) => workflow.id === workflowId) || null;
}

function getWorkflowsForApp(appId, categoryId = '') {
  return state.workflows.filter(
    (workflow) => workflow.appId === appId && (!categoryId || workflow.categoryId === categoryId),
  );
}

function getParameterDefaults(workflow) {
  return Object.fromEntries(
    (workflow?.params || []).map((parameter) => {
      if (parameter.type === 'duration') {
        return [
          parameter.id,
          {
            amount: parameter.defaultValue ?? 30,
            unit: parameter.defaultUnit || parameter.units?.[0] || '秒',
          },
        ];
      }
      return [parameter.id, parameter.defaultValue ?? (parameter.type === 'boolean' ? false : '')];
    }),
  );
}

function renderParameterFields(container, workflow) {
  if (!container) return;
  if (!workflow?.params?.length) {
    container.replaceChildren();
    return;
  }

  const defaults = getParameterDefaults(workflow);
  container.replaceChildren(
    ...workflow.params.map((parameter) => {
      const field = document.createElement('label');
      field.className = 'parameter-field';
      field.dataset.paramId = parameter.id;
      field.dataset.paramType = parameter.type;

      const title = document.createElement('span');
      title.textContent = `${parameter.label}${parameter.required ? ' *' : ''}`;
      field.append(title);

      const value = defaults[parameter.id];
      if (parameter.type === 'duration') {
        const controls = document.createElement('div');
        controls.className = 'duration-control';

        const amount = document.createElement('input');
        amount.type = 'number';
        amount.min = String(parameter.min || 1);
        amount.step = '1';
        amount.value = String(value.amount);
        amount.dataset.role = 'amount';
        amount.setAttribute('aria-label', parameter.label);

        const unit = document.createElement('select');
        unit.dataset.role = 'unit';
        for (const optionValue of parameter.units || ['秒', '分钟', '小时']) {
          const option = document.createElement('option');
          option.value = optionValue;
          option.textContent = optionValue;
          option.selected = optionValue === value.unit;
          unit.append(option);
        }
        controls.append(amount, unit);
        field.append(controls);
      } else if (parameter.type === 'boolean') {
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.checked = Boolean(value);
        toggle.dataset.role = 'value';
        toggle.setAttribute('aria-label', parameter.label);
        field.classList.add('parameter-toggle');
        field.append(toggle);
      } else if (parameter.type === 'select') {
        const select = document.createElement('select');
        select.dataset.role = 'value';
        for (const optionValue of parameter.options || []) {
          const option = document.createElement('option');
          option.value = optionValue.value ?? optionValue;
          option.textContent = optionValue.label ?? optionValue;
          option.selected = option.value === String(value);
          select.append(option);
        }
        field.append(select);
      } else if (parameter.type === 'number') {
        const input = document.createElement('input');
        input.type = 'number';
        input.min = String(parameter.min ?? 1);
        if (parameter.max != null) input.max = String(parameter.max);
        input.step = String(parameter.step ?? 1);
        input.value = String(value);
        input.dataset.role = 'value';
        input.setAttribute('aria-label', parameter.label);
        field.append(input);
      } else {
        const input = document.createElement('input');
        input.type = parameter.sensitive ? 'password' : 'text';
        input.value = String(value || '');
        input.placeholder = parameter.placeholder || '';
        input.dataset.role = 'value';
        input.autocomplete = parameter.sensitive ? 'new-password' : 'off';
        field.append(input);
      }
      return field;
    }),
  );
  for (const input of container.querySelectorAll('input, select')) {
    input.addEventListener('change', () => updateParameterVisibility(container, workflow));
  }
  updateParameterVisibility(container, workflow);
}

function readParameterValues(container, workflow) {
  const values = {};
  for (const parameter of workflow?.params || []) {
    const field = [...(container?.querySelectorAll('.parameter-field') || [])].find(
      (candidate) => candidate.dataset.paramId === parameter.id,
    );
    if (!field) continue;
    if (parameter.type === 'duration') {
      values[parameter.id] = {
        amount: Number(field.querySelector('[data-role="amount"]')?.value),
        unit: field.querySelector('[data-role="unit"]')?.value || '秒',
      };
    } else if (parameter.type === 'boolean') {
      values[parameter.id] = Boolean(field.querySelector('[data-role="value"]')?.checked);
    } else if (parameter.type === 'number') {
      values[parameter.id] = Number(field.querySelector('[data-role="value"]')?.value);
    } else {
      values[parameter.id] = field.querySelector('[data-role="value"]')?.value || '';
    }
  }
  return values;
}

function validateWorkflowParameters(workflow, values, messageElement) {
  for (const parameter of workflow?.params || []) {
    if (!isParameterVisible(parameter, values)) continue;
    const value = values[parameter.id];
    if (parameter.type === 'duration' && (!Number.isFinite(value?.amount) || value.amount <= 0)) {
      messageElement.textContent = `${parameter.label}必须大于 0`;
      return false;
    }
    if (
      parameter.type === 'number' &&
      (!Number.isFinite(value) || value < Number(parameter.min ?? 1))
    ) {
      messageElement.textContent = `${parameter.label}必须不小于 ${parameter.min ?? 1}`;
      return false;
    }
    if (parameter.required && parameter.type !== 'boolean') {
      const empty = parameter.type === 'duration' ? !value?.amount : !String(value || '').trim();
      if (empty) {
        messageElement.textContent = `${parameter.label}不能为空`;
        return false;
      }
    }
  }
  return true;
}

function formatParameterValue(parameter, value) {
  if (parameter.type === 'duration') return `${Math.round(value.amount)}${value.unit}`;
  if (parameter.type === 'boolean') return value ? '开启' : '关闭';
  return String(value ?? '').trim();
}

function buildWorkflowCommand(workflow, values) {
  if (!workflow) return '';
  const replacements = {
    appName: workflow.appName,
    functionName: workflow.featureName,
  };
  for (const parameter of workflow.params || []) {
    replacements[parameter.id] = formatParameterValue(parameter, values[parameter.id]);
  }
  const commandTemplate =
    workflow.commandTemplatesByMode?.[values.sendMode] || workflow.commandTemplate;
  return String(commandTemplate || '').replace(
    /\{([A-Za-z0-9_-]+)\}/g,
    (_, key) => replacements[key] ?? '',
  );
}

function isParameterVisible(parameter, values) {
  const condition = parameter?.visibleWhen;
  if (!condition) return true;
  return values?.[condition.parameterId] === condition.equals;
}

function updateParameterVisibility(container, workflow) {
  if (!container || !workflow) return;
  const values = readParameterValues(container, workflow);
  for (const parameter of workflow.params || []) {
    const field = [...container.querySelectorAll('.parameter-field')].find(
      (candidate) => candidate.dataset.paramId === parameter.id,
    );
    if (field) field.hidden = !isParameterVisible(parameter, values);
  }
}

async function openWorkflow(workflowId) {
  const workflow = getWorkflow(workflowId);
  if (!workflow) return;

  state.activeWorkflowId = workflow.id;
  state.activeWorkflowCategoryId = workflow.categoryId;
  elements.dialogTitle.textContent = `${workflow.appName} · ${workflow.featureName}`;
  if (!elements.quickTaskDialog.open) elements.quickTaskDialog.showModal();
  populateBuilderApps(workflow.categoryId, workflow.appId);
  populateBuilderFunctions(workflow.id);
  renderBuilderParameters();
}

function populateBuilderApps(categoryId = state.activeWorkflowCategoryId, preferredAppId = '') {
  const appIds = [...new Set(
    state.workflows
      .filter((workflow) => workflow.categoryId === categoryId)
      .map((workflow) => workflow.appId),
  )];
  elements.builderApp.replaceChildren(
    ...appIds.map((appId) => {
      const option = document.createElement('option');
      option.value = appId;
      option.textContent = state.apps.find((app) => app.id === appId)?.name || appId;
      return option;
    }),
  );
  if (appIds.includes(preferredAppId)) elements.builderApp.value = preferredAppId;
  elements.builderApp.disabled = appIds.length === 0;
}

function populateBuilderFunctions(preferredWorkflowId = '') {
  const appId = elements.builderApp.value;
  const workflows = getWorkflowsForApp(appId, state.activeWorkflowCategoryId);
  elements.builderFunction.replaceChildren(
    ...workflows.map((workflow) => {
      const option = document.createElement('option');
      option.value = workflow.id;
      option.textContent = workflow.featureName;
      return option;
    }),
  );
  if (workflows.some((workflow) => workflow.id === preferredWorkflowId)) {
    elements.builderFunction.value = preferredWorkflowId;
  }
  if (!elements.builderFunction.value && workflows.length) {
    elements.builderFunction.value = workflows[0].id;
  }
  state.activeWorkflowId = elements.builderFunction.value || null;
  renderBuilderParameters();
}

function renderBuilderParameters() {
  const workflow = getWorkflow(elements.builderFunction.value);
  renderParameterFields(elements.builderParameters, workflow);
  const hasWorkflow = Boolean(workflow);
  const ready = hasWorkflow && workflow.installed && workflow.status === 'verified';
  elements.fillTaskBtn.disabled = !hasWorkflow;
  elements.runBuiltTaskBtn.disabled = !ready;
  elements.builderMessage.textContent = !hasWorkflow
    ? '没有可配置的功能'
    : ready
      ? ''
      : '此功能尚未验证，当前只能生成任务文本，不能直接执行';
}

function buildWorkflowCommandFromDialog() {
  const workflow = getWorkflow(elements.builderFunction.value);
  if (!workflow) return '';
  const values = readParameterValues(elements.builderParameters, workflow);
  if (!validateWorkflowParameters(workflow, values, elements.builderMessage)) return '';
  return buildWorkflowCommand(workflow, values);
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
    await Promise.all([refreshDevice(), refreshApps()]);
  }
}

function renderTask(task) {
  const repeatProgress =
    Number(task.repeatCount) > 1
      ? ` · 第 ${task.repeatIndex || 0}/${task.repeatCount} 次`
      : '';
  elements.taskState.textContent = `${task.status || 'unknown'} ${task.stepIndex || 0}/${task.totalSteps || 0}${repeatProgress}`;
  elements.confirmMessage.textContent = task.pendingConfirmation?.message || '';
  elements.continueBtn.textContent =
    task.pendingConfirmation?.confirmLabel || '确认完成，继续';
  setConfirmDialogOpen(task.status === 'waiting_confirmation');
  elements.logs.textContent = (task.logs || [])
    .map((entry) => `${new Date(entry.at).toLocaleTimeString()}  ${entry.message}`)
    .join('\n');
  elements.logs.scrollTop = elements.logs.scrollHeight;
  renderCapture(task);
}

function renderCapture(task) {
  const capture = task.capture;
  const captures = Array.isArray(task.captures) ? task.captures : [];
  const captureError = task.captureError;
  elements.captureResult.hidden = !capture && !captureError;
  if (!capture && !captureError) return;

  if (captureError) {
    elements.captureState.textContent = '收尾失败';
    elements.captureOutput.textContent = captureError;
    return;
  }

  const errorCount = captures.length
    ? captures.reduce((total, item) => total + (item.errors?.length || 0), 0)
    : capture.errors?.length || 0;
  const screenMode =
    capture.screenRecordingMode === 'harmony_system'
      ? '系统录屏'
      : capture.screenRecordingMode === 'screenshot_fallback'
        ? '截图回退'
        : '录屏';
  const componentText = capture.components
    ? [
        `PCAP ${capture.components.tshark}`,
        `端口 ${capture.components.portMapping}`,
        `${screenMode} ${capture.components.screen?.status || capture.components.screen}`,
      ].join(' · ')
    : '';
  const repeatState =
    Number(task.repeatCount) > 1
      ? ` · 已完成 ${captures.length}/${task.repeatCount} 次采集`
      : '';
  const outputDirs =
    captures.length > 1
      ? captures.map((item, index) => `第 ${index + 1} 次: ${item.outputDir}`).join('\n')
      : capture.outputDir;
  elements.captureState.textContent = `${capture.status || 'unknown'}${repeatState}${errorCount ? ` · ${errorCount} 个错误` : ''}`;
  elements.captureOutput.textContent = [outputDirs, componentText].filter(Boolean).join('\n');
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
    ? `${device.provider?.toUpperCase() || 'DEVICE'} · ${device.model || device.platform || '设备'} · ${device.serial} · ${device.focus?.packageName || '无前台应用'}`
    : '未检测到 ADB 或 HDC 设备';
}

async function refreshApps() {
  const [appsResponse, workflowsResponse] = await Promise.all([
    fetch('/api/apps'),
    fetch('/api/workflows'),
  ]);
  state.apps = await appsResponse.json();
  state.workflows = workflowsResponse.ok ? await workflowsResponse.json() : [];
  populateRecordingApps();
  renderAppCatalog();
}

function populateRecordingApps() {
  if (!elements.recordingApp) return;
  const previous = elements.recordingApp.value;
  const appIds = new Set(state.workflows.map((workflow) => workflow.appId));
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '请选择 App';
  placeholder.disabled = true;
  const options = state.apps
    .filter((app) => app.installed && appIds.has(app.id))
    .map((app) => {
      const option = document.createElement('option');
      option.value = app.id;
      option.textContent = app.name;
      return option;
    });
  elements.recordingApp.replaceChildren(placeholder, ...options);
  if (options.some((option) => option.value === previous)) {
    elements.recordingApp.value = previous;
  } else {
    elements.recordingApp.value = '';
  }
  populateRecordingFeatures();
  updateRecordingButtons();
}

function populateRecordingFeatures() {
  if (!elements.recordingFeature) return;
  const previous = elements.recordingFeature.value;
  const workflows = getWorkflowsForApp(elements.recordingApp.value);
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = elements.recordingApp.value ? '请选择功能' : '请先选择 App';
  placeholder.disabled = true;
  elements.recordingFeature.replaceChildren(
    placeholder,
    ...workflows.map((workflow) => {
      const option = document.createElement('option');
      option.value = workflow.id;
      option.textContent = `${workflow.categoryLabel} / ${workflow.featureName}`;
      return option;
    }),
  );
  if (workflows.some((workflow) => workflow.id === previous)) {
    elements.recordingFeature.value = previous;
  } else {
    elements.recordingFeature.value = '';
  }
  renderRecordingParameters();
}

function resetRecordingView() {
  stopRecordingPolling();
  state.recordingId = null;
  elements.recordingState.textContent = '未录制';
  elements.recordingState.dataset.validationStatus = 'unverified';
  elements.recordingState.dataset.validationSource = '';
  elements.recordingState.dataset.recordingQuality = '';
  elements.recordingMessage.textContent = '';
  elements.recordingOutput.textContent = '';
  updateRecordingButtons();
}

function renderRecordingParameters() {
  const workflow = getWorkflow(elements.recordingFeature.value);
  renderParameterFields(elements.recordingParameters, workflow, 'recording');
  elements.recordingParameterHint.textContent = workflow
    ? workflow.status === 'verified'
      ? '此功能已验证；带持续时间的回放测试会缩短为 5 秒，不修改正式任务参数。'
      : '录制后需回放验证；带持续时间的功能会用 5 秒短时测试，通过后才开放执行。'
    : '';
  updateRecordingButtons();
}

async function startRecording() {
  const appId = elements.recordingApp.value;
  const workflow = getWorkflow(elements.recordingFeature.value);
  if (!appId || !workflow) {
    elements.recordingMessage.textContent = '请选择 App 和功能';
    return;
  }
  const parameters = readParameterValues(elements.recordingParameters, workflow);
  if (!validateWorkflowParameters(workflow, parameters, elements.recordingMessage)) {
    return;
  }

  resetRecordingView();
  elements.startRecordingBtn.disabled = true;
  elements.recordingMessage.textContent = '正在启动设备动作录制...';
  try {
    const response = await fetch('/api/recordings/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId,
        workflowId: workflow.id,
        featureName: workflow.featureName,
        parameters,
      }),
    });
    const recording = await response.json();
    if (!response.ok || !recording.id) {
      throw new Error(recording.error || `HTTP ${response.status}`);
    }
    state.recordingId = recording.id;
    renderRecording(recording);
    startRecordingPolling();
  } catch (error) {
    elements.recordingMessage.textContent = `录制启动失败: ${error.message}`;
    updateRecordingButtons();
  }
}

async function stopRecording() {
  if (!state.recordingId) return;
  elements.stopRecordingBtn.disabled = true;
  elements.recordingMessage.textContent = '正在整理动作轨迹...';
  try {
    const response = await fetch(`/api/recordings/${state.recordingId}/stop`, { method: 'POST' });
    const recording = await response.json();
    if (!response.ok) throw new Error(recording.error || `HTTP ${response.status}`);
    renderRecording(recording);
    stopRecordingPolling();
    await refreshRecordings();
  } catch (error) {
    elements.recordingMessage.textContent = `录制结束失败: ${error.message}`;
    updateRecordingButtons();
  }
}

async function replayRecording() {
  if (!state.recordingId) return;
  const workflow = getWorkflow(elements.recordingFeature.value);
  const parameters = workflow ? readParameterValues(elements.recordingParameters, workflow) : {};
  if (workflow && !validateWorkflowParameters(workflow, parameters, elements.recordingMessage)) return;
  const hasDuration = workflow?.params?.some(
    (parameter) =>
      parameter.type === 'duration' &&
      parameter.id === 'duration' &&
      isParameterVisible(parameter, parameters),
  );
  elements.replayRecordingBtn.disabled = true;
  elements.recordingMessage.textContent = hasDuration
    ? '正在进行 5 秒短时回放验证...'
    : '正在回放轨迹...';
  try {
    const response = await fetch(`/api/recordings/${state.recordingId}/replay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        speed: 1,
        source: 'auto',
        parameters,
        validationDurationMs: hasDuration ? 5000 : null,
      }),
    });
    const recording = await response.json();
    if (!response.ok) throw new Error(recording.error || `HTTP ${response.status}`);
    renderRecording(recording);
    startRecordingPolling();
  } catch (error) {
    elements.recordingMessage.textContent = `回放启动失败: ${error.message}`;
    updateRecordingButtons();
  }
}

async function repairRecording() {
  if (!state.recordingId) return;
  const apiKey = elements.apiKey.value.trim();
  if (!apiKey) {
    elements.recordingMessage.textContent = '模型纠正需要先填写 API Key';
    return;
  }

  elements.repairRecordingBtn.disabled = true;
  elements.recordingMessage.textContent = '正在根据动作轨迹生成修正版...';
  try {
    const response = await fetch(`/api/recordings/${state.recordingId}/repair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
    const recording = await response.json();
    if (!response.ok) throw new Error(recording.error || `HTTP ${response.status}`);
    renderRecording(recording);
  } catch (error) {
    elements.recordingMessage.textContent = `模型纠正失败: ${error.message}`;
    updateRecordingButtons();
  }
}

function startRecordingPolling() {
  clearInterval(state.recordingPollTimer);
  state.recordingPollTimer = setInterval(pollRecording, 500);
  pollRecording();
}

function stopRecordingPolling() {
  clearInterval(state.recordingPollTimer);
  state.recordingPollTimer = null;
}

async function pollRecording() {
  if (!state.recordingId) return;
  try {
    const response = await fetch(`/api/recordings/${state.recordingId}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const recording = await response.json();
    renderRecording(recording);
    if (
      ['stopped', 'failed', 'replayed', 'replay_failed'].includes(recording.status) &&
      !recording.active
    ) {
      stopRecordingPolling();
      await refreshRecordings();
    }
  } catch (error) {
    stopRecordingPolling();
    elements.recordingMessage.textContent = `读取录制状态失败: ${error.message}`;
    updateRecordingButtons();
  }
}

async function refreshRecordings() {
  try {
    const response = await fetch('/api/recordings');
    if (!response.ok) return;
    state.recordings = await response.json();
  } catch {
    // Recording history is optional.
  }
}

function renderRecording(recording) {
  if (!recording || !elements.recordingState) return;
  state.recordingId = recording.id || state.recordingId;
  const workflow = getWorkflow(recording.workflowId);
  if (workflow) {
    elements.recordingApp.value = workflow.appId;
    populateRecordingFeatures();
    elements.recordingFeature.value = workflow.id;
    renderRecordingParameters();
    applyParameterValues(elements.recordingParameters, workflow, recording.parameters);
  }
  const statusLabels = {
    starting: '启动中',
    recording: '录制中',
    stopping: '整理中',
    stopped: '已保存',
    failed: '失败',
    replaying: '回放中',
    replayed: '回放完成',
    replay_failed: '回放失败',
  };
  const statusLabel =
    recording.validationStatus === 'verified' && recording.status === 'replayed'
      ? recording.validationSource === 'workflow_skill'
        ? 'Skill 验证通过'
        : '轨迹验证通过'
      : recording.status === 'stopped' && recording.validationStatus !== 'verified'
        ? '待回放验证'
        : statusLabels[recording.status] || recording.status || '未知';
  elements.recordingState.textContent = statusLabel;
  elements.recordingState.dataset.validationStatus = recording.validationStatus || 'unverified';
  elements.recordingState.dataset.validationSource = recording.validationSource || '';
  elements.recordingState.dataset.recordingQuality = recording.recordingQuality || '';
  const stepCount = Number(recording.stepCount ?? recording.steps?.length ?? 0);
  const parts = [`动作 ${stepCount} 步`];
  if (Number(recording.semanticStepCount) > stepCount) {
    parts.push(`语义轨迹 ${recording.semanticStepCount} 步`);
  }
  const currentWorkflowName = workflow?.featureName || recording.workflowName;
  if (currentWorkflowName) parts.unshift(currentWorkflowName);
  if (recording.timelineQuality) {
    const timelineLabels = {
      exact: '时间轴完整',
      approximate: '时间轴已稳定修复',
      missing: '时间轴缺失',
      empty: '无动作',
    };
    parts.push(timelineLabels[recording.timelineQuality] || recording.timelineQuality);
  }
  if (recording.recordingQuality) {
    const qualityLabels = {
      good: '动作采集可用',
      review_required: '动作采集待检查',
      unusable: '动作采集不可用',
    };
    const score = Number.isFinite(recording.qualityScore)
      ? ` ${recording.qualityScore} 分`
      : '';
    parts.push(`${qualityLabels[recording.recordingQuality] || recording.recordingQuality}${score}`);
  }
  if (Number(recording.remoteStepCount) || Number(recording.streamStepCount)) {
    parts.push(
      `双路动作 ${Number(recording.remoteStepCount) || 0}/${Number(recording.streamStepCount) || 0}，合并 ${Number(recording.mergedStepCount) || 0}，拒绝 ${Number(recording.rejectedStepCount) || 0}`,
    );
  }
  for (const issue of recording.qualityIssues || []) {
    parts.push(`质量问题: ${issue}`);
  }
  if (Number(recording.contextCount) > 0) {
    parts.push(`界面诊断 ${recording.contextCount} 个`);
  }
  if (Number(recording.recordedLayoutCount) > 0) {
    parts.push(`逐动作布局 ${recording.recordedLayoutCount} 个`);
  }
  if (recording.integrityStatus) {
    const integrityLabels = {
      complete: '证据完整',
      incomplete: '证据待补',
      unusable: '证据不可用',
    };
    parts.push(
      integrityLabels[recording.integrityStatus] || recording.integrityStatus,
    );
  }
  for (const issue of recording.integrityIssues || []) {
    if (!recording.qualityIssues?.includes(issue)) parts.push(issue);
  }
  if (Number(recording.replayStats?.attempts) > 0) {
    const attempts = Number(recording.replayStats.attempts);
    const passed = Number(recording.replayStats.passed);
    const rate = Number.isFinite(recording.replayStats.successRate)
      ? ` ${Math.round(recording.replayStats.successRate * 100)}%`
      : '';
    parts.push(`回归 ${passed}/${attempts}${rate}`);
  }
  if (Number(recording.replayRecoveryLog?.length) > 0) {
    parts.push(`自动恢复 ${recording.replayRecoveryLog.length} 次`);
  }
  if (recording.validationSource === 'workflow_skill') {
    const skillLabels = {
      verified: '通过',
      failed: '失败',
      running: '进行中',
      unverified: '待验证',
      not_run: '未运行',
    };
    parts.push(
      `Skill 验证 ${skillLabels[recording.skillValidationStatus] || recording.skillValidationStatus || '待验证'}`,
    );
  }
  if (recording.correctionStatus === 'completed') {
    parts.push(`修正版 ${recording.correctedStepCount || 0} 步`);
    if (Number.isFinite(recording.correctionConfidence)) {
      parts.push(`置信度 ${Math.round(recording.correctionConfidence * 100)}%`);
    }
  } else if (recording.correctionStatus === 'repairing') {
    parts.push('模型纠正中');
  } else if (recording.correctionError) {
    parts.push(recording.correctionError);
  }
  if (Number(recording.effectiveDurationMs) > 0) {
    parts.push(`本次验证 ${formatDurationMs(recording.effectiveDurationMs)}`);
  }
  if (recording.diagnostics?.length) {
    parts.push(recording.diagnostics.at(-1));
  }
  if (recording.outputDir) parts.push(recording.outputDir);
  if (recording.error) parts.push(recording.error);
  elements.recordingMessage.textContent = parts.join('\n');
  elements.recordingOutput.textContent = recording.trajectoryFile
    ? [
        `轨迹文件: ${recording.trajectoryFile}`,
        `Skill 草稿: ${recording.skillFile || ''}`,
        recording.contextFile ? `界面诊断: ${recording.contextFile}` : '',
        recording.rawLiveFile ? `实时原始日志: ${recording.rawLiveFile}` : '',
        recording.rawRemoteFile ? `远端原始日志: ${recording.rawRemoteFile}` : '',
        recording.correctedSkillFile ? `修正版 Skill: ${recording.correctedSkillFile}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';
  updateRecordingButtons(recording);
}

function formatDurationMs(value) {
  const milliseconds = Math.max(0, Number(value) || 0);
  if (milliseconds % 60000 === 0) return `${milliseconds / 60000} 分钟`;
  if (milliseconds % 1000 === 0) return `${milliseconds / 1000} 秒`;
  return `${milliseconds}ms`;
}

function applyParameterValues(container, workflow, values = {}) {
  for (const parameter of workflow?.params || []) {
    if (!(parameter.id in values)) continue;
    const field = [...(container?.querySelectorAll('.parameter-field') || [])].find(
      (candidate) => candidate.dataset.paramId === parameter.id,
    );
    if (!field || parameter.sensitive) continue;
    const value = values[parameter.id];
    if (parameter.type === 'duration') {
      const amount = field.querySelector('[data-role="amount"]');
      const unit = field.querySelector('[data-role="unit"]');
      if (amount && Number.isFinite(Number(value?.amount))) amount.value = value.amount;
      if (unit && value?.unit) unit.value = value.unit;
    } else if (parameter.type === 'boolean') {
      const input = field.querySelector('[data-role="value"]');
      if (input) input.checked = Boolean(value);
    } else {
      const input = field.querySelector('[data-role="value"]');
      if (input) input.value = String(value ?? '');
    }
  }
  updateParameterVisibility(container, workflow);
}

function updateRecordingButtons(recording = null) {
  const status = recording?.status || '';
  const active =
    Boolean(recording?.active) ||
    ['starting', 'recording', 'stopping', 'replaying'].includes(status) ||
    recording?.correctionStatus === 'repairing';
  const hasSteps = Number(recording?.stepCount ?? recording?.steps?.length ?? 0) > 0;
  const replayAvailable = Boolean(recording?.replayAvailable) || hasSteps;
  elements.recordingApp.disabled = active;
  elements.recordingFeature.disabled = active || !elements.recordingApp.value;
  elements.startRecordingBtn.disabled =
    active || !elements.recordingApp.value || !elements.recordingFeature.value;
  elements.stopRecordingBtn.disabled = !['starting', 'recording'].includes(status);
  elements.repairRecordingBtn.disabled = active || !hasSteps;
  elements.replayRecordingBtn.disabled = active || !replayAvailable;
}

async function refreshCaptureConfig() {
  let serverConfig = {};
  try {
    const response = await fetch('/api/capture/config');
    if (response.ok) serverConfig = await response.json();
  } catch {
    serverConfig = {};
  }

  let savedConfig = {};
  try {
    savedConfig = JSON.parse(localStorage.getItem(CAPTURE_STORAGE_KEY) || '{}');
  } catch {
    savedConfig = {};
  }

  applyCaptureSettings({
    enabled: true,
    interfaceName: 'WLAN3',
    outputRoot: 'D:\\andorid_adb\\data_collect',
    recordScreen: true,
    recordPortMapping: true,
    ...serverConfig,
    ...savedConfig,
  });
}

function applyCaptureSettings(capture) {
  elements.captureEnabled.checked = capture.enabled !== false;
  elements.captureInterface.value = capture.interfaceName || '';
  elements.capturePhoneIp.value = capture.phoneIp || '';
  elements.captureOutputRoot.value = capture.outputRoot || '';
  elements.captureRecordScreen.checked = capture.recordScreen !== false;
  elements.captureRecordPortMapping.checked = capture.recordPortMapping !== false;
  elements.captureExtractorScript.value = capture.extractorScript || '';
  updateCaptureFields();
}

function readCaptureSettings() {
  return {
    enabled: elements.captureEnabled.checked,
    interfaceName: elements.captureInterface.value.trim(),
    phoneIp: elements.capturePhoneIp.value.trim(),
    outputRoot: elements.captureOutputRoot.value.trim(),
    recordScreen: elements.captureRecordScreen.checked,
    recordPortMapping: elements.captureRecordPortMapping.checked,
    extractorScript: elements.captureExtractorScript.value.trim(),
  };
}

function saveCaptureSettings(capture) {
  try {
    localStorage.setItem(CAPTURE_STORAGE_KEY, JSON.stringify(capture));
  } catch {
    // Browser storage is optional.
  }
}

function updateCaptureFields() {
  const disabled = !elements.captureEnabled.checked;
  elements.captureFields.classList.toggle('disabled', disabled);
  for (const input of elements.captureFields.querySelectorAll('input')) {
    input.disabled = disabled;
  }
}

function renderAppCatalog() {
  if (!elements.appCatalog) return;

  const categories = [];
  const categoryMap = new Map();
  for (const workflow of state.workflows) {
    let category = categoryMap.get(workflow.categoryId);
    if (!category) {
      category = {
        id: workflow.categoryId,
        label: workflow.categoryLabel || workflow.categoryId,
        workflows: [],
      };
      categoryMap.set(category.id, category);
      categories.push(category);
    }
    category.workflows.push(workflow);
  }

  elements.appCatalog.replaceChildren(
    ...categories.map((category) => {
      const section = document.createElement('section');
      section.className = 'catalog-group';

      const heading = document.createElement('div');
      heading.className = 'catalog-heading';

      const title = document.createElement('h3');
      title.textContent = category.label;

      const count = document.createElement('span');
      const appCount = new Set(category.workflows.map((workflow) => workflow.appId)).size;
      count.textContent = `${appCount} 个应用 · ${category.workflows.length} 个功能`;
      heading.append(title, count);

      const grid = document.createElement('div');
      grid.className = 'app-grid';

      const workflowGroups = [];
      const workflowGroupMap = new Map();
      for (const workflow of category.workflows) {
        let group = workflowGroupMap.get(workflow.appId);
        if (!group) {
          group = { appId: workflow.appId, workflows: [] };
          workflowGroupMap.set(workflow.appId, group);
          workflowGroups.push(group);
        }
        group.workflows.push(workflow);
      }

      for (const group of workflowGroups) {
        const app = state.apps.find((candidate) => candidate.id === group.appId);
        const firstWorkflow = group.workflows[0];
        const readyWorkflows = group.workflows.filter(
          (workflow) => workflow.status === 'verified',
        );
        const displayName = app?.name || firstWorkflow.appName || group.appId;
        const ready = Boolean(app?.installed && readyWorkflows.length);
        const preferredWorkflow = readyWorkflows[0] || firstWorkflow;
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'app-chip';
        chip.disabled = !ready;
        chip.dataset.ready = String(ready);
        chip.title = ready
          ? `配置${displayName} · ${group.workflows.length} 个功能`
          : app?.installed
            ? '等待你确认测试成功'
            : '设备未安装';

        const name = document.createElement('span');
        name.textContent = displayName;
        name.className = 'app-chip-name';

        const meta = document.createElement('span');
        meta.className = 'app-chip-meta';
        const flow = document.createElement('small');
        flow.className = 'app-chip-flow';
        flow.textContent = group.workflows
          .map((workflow) => workflow.featureName)
          .join(' / ');
        meta.append(flow);

        const status = document.createElement('small');
        status.textContent = !app?.installed
          ? '未安装'
          : readyWorkflows.length === group.workflows.length
            ? '已验证'
            : readyWorkflows.length
              ? `${readyWorkflows.length}/${group.workflows.length} 已验证`
              : '待确认';
        meta.append(status);
        chip.append(name, meta);

        if (ready) {
          chip.addEventListener('click', () => openWorkflow(preferredWorkflow.id));
        }

        grid.append(chip);
      }

      section.append(heading, grid);
      return section;
    }),
  );
}

async function resumeCurrentTask() {
  const response = await fetch('/api/tasks/current');
  const task = await response.json();
  if (!task?.id || !['running', 'waiting_confirmation'].includes(task.status)) return;
  state.currentTaskId = task.id;
  renderTask(task);
  startPolling();
}

await Promise.all([refreshDevice(), refreshApps(), refreshCaptureConfig(), refreshRecordings()]);
await resumeCurrentTask();
setInterval(refreshDevice, 5000);
