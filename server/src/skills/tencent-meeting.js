import { inflateSync } from 'node:zlib';

const TENCENT_MEETING_BUNDLE = 'com.tencent.meeting.app';
const SHARE_DIALOG_BUNDLE = 'SCBSysDialogDefault48';
const DEFAULT_SCREEN = { width: 1256, height: 2760 };
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const WAIT_CHUNK_MS = 60 * 1000;

const DEFAULT_TIMINGS = {
  afterOverlayDismissMs: 300,
  afterStopMs: 500,
  afterLaunchMs: 2500,
  afterRecoveryDismissMs: 500,
  afterQuickMeetingTapMs: 1200,
  afterJoinMeetingTapMs: 1200,
  afterMeetingIdInputMs: 500,
  afterPasswordInputMs: 500,
  afterCameraTapMs: 500,
  afterEnterMeetingMs: 1800,
  afterPermissionChoiceMs: 300,
  afterPermissionConfirmMs: 1000,
  stateTimeoutMs: 30000,
  pollIntervalMs: 300,
  shareStepDelayMs: 700,
  shareDialogTimeoutMs: 2000,
  afterShareConfirmMs: 1200,
  afterEndDialogMs: 800,
  afterEndConfirmMs: 2000,
};

export const TENCENT_QUICK_MEETING_WORKFLOW_ID =
  'meeting:tencent-meeting:quick-meeting';
export const TENCENT_JOIN_MEETING_WORKFLOW_ID =
  'meeting:tencent-meeting:join-meeting';

export function durationParameterToMs(
  value,
  { defaultMs = 30 * 1000, maxMs = MAX_DURATION_MS } = {},
) {
  if (value === undefined || value === null || value === '') return defaultMs;

  const amount = Number(
    value && typeof value === 'object' && 'amount' in value ? value.amount : value,
  );
  const unit =
    value && typeof value === 'object' && value.unit ? String(value.unit) : '秒';
  const factors = {
    毫秒: 1,
    秒: 1000,
    分钟: 60 * 1000,
    小时: 60 * 60 * 1000,
    ms: 1,
    s: 1000,
    min: 60 * 1000,
    h: 60 * 60 * 1000,
  };
  const factor = factors[unit];

  if (!Number.isFinite(amount) || amount <= 0 || !factor) {
    throw new Error(`无效的会议持续时间: ${JSON.stringify(value)}`);
  }
  return Math.min(maxMs, Math.max(1, Math.round(amount * factor)));
}

export function inspectTencentCameraToggle(layout, screen = DEFAULT_SCREEN) {
  const size = normalizeScreen(screen);
  const nodes = flattenLayout(layout);
  const label = nodes.find((node) =>
    node.textValues.some((value) => value === '开启视频'),
  );
  if (!label) return null;

  const labelY = (label.bounds.y1 + label.bounds.y2) / 2;
  const candidates = nodes.filter((node) => {
    const width = node.bounds.x2 - node.bounds.x1;
    const height = node.bounds.y2 - node.bounds.y1;
    const centerY = (node.bounds.y1 + node.bounds.y2) / 2;
    return (
      node.bounds.x1 >= size.width * 0.72 &&
      Math.abs(centerY - labelY) <= Math.max(80, size.height * 0.04) &&
      width >= size.width * 0.04 &&
      width <= size.width * 0.2 &&
      height >= size.height * 0.015 &&
      height <= size.height * 0.08
    );
  });
  if (!candidates.length) return null;

  const outer = [...candidates].sort((left, right) => {
    const leftArea =
      (left.bounds.x2 - left.bounds.x1) * (left.bounds.y2 - left.bounds.y1);
    const rightArea =
      (right.bounds.x2 - right.bounds.x1) * (right.bounds.y2 - right.bounds.y1);
    return rightArea - leftArea;
  })[0];
  const leaf = [...candidates]
    .filter((node) => node.childCount === 0)
    .sort(
      (left, right) =>
        right.bounds.x2 -
        right.bounds.x1 -
        (left.bounds.x2 - left.bounds.x1),
    )[0];
  if (!leaf) return null;

  const outerWidth = outer.bounds.x2 - outer.bounds.x1;
  const leafWidth = leaf.bounds.x2 - leaf.bounds.x1;
  return {
    enabled: leafWidth / outerWidth >= 0.75,
    x: Math.round((outer.bounds.x1 + outer.bounds.x2) / 2),
    y: Math.round((outer.bounds.y1 + outer.bounds.y2) / 2),
    evidence: {
      outerBounds: outer.rawBounds,
      indicatorBounds: leaf.rawBounds,
    },
  };
}

export function selectTencentShareSteps(
  recordedSteps,
  screen = DEFAULT_SCREEN,
) {
  const steps = Array.isArray(recordedSteps) ? recordedSteps : [];
  const size = normalizeScreen(screen);
  const explicit = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.phase === 'share');
  if (explicit.length) return explicit.map((entry) => normalizeLegacyLongPress(entry, size));

  const entryIndex = steps.findIndex(
    (step) =>
      isPointStep(step) &&
      Number(step.y) >= size.height * 0.84 &&
      Number(step.x) >= size.width * 0.15 &&
      Number(step.x) <= size.width * 0.85,
  );
  if (entryIndex < 0) return [];

  const relativeEndIndex = steps.slice(entryIndex + 1).findIndex(
    (step) =>
      isPointStep(step) &&
      Number(step.x) >= size.width * 0.8 &&
      Number(step.y) <= size.height * 0.16,
  );
  const endIndex =
    relativeEndIndex < 0 ? steps.length : entryIndex + 1 + relativeEndIndex;

  return steps
    .slice(entryIndex + 1, endIndex)
    .map((step, offset) =>
      normalizeLegacyLongPress(
        { step, index: entryIndex + 1 + offset },
        size,
      ),
    );
}

export function inspectTencentShareStatusPixels({
  width,
  height,
  data,
  channels = 4,
} = {}) {
  const imageWidth = Number(width);
  const imageHeight = Number(height);
  if (
    !Number.isInteger(imageWidth) ||
    !Number.isInteger(imageHeight) ||
    imageWidth <= 0 ||
    imageHeight <= 0 ||
    !Buffer.isBuffer(data) ||
    data.length < imageWidth * imageHeight * channels
  ) {
    return { active: false, reason: 'invalid_image' };
  }

  const center = sampleColorRegion({
    data,
    width: imageWidth,
    height: imageHeight,
    channels,
    region: [0.12, 0.2, 0.88, 0.78],
  });
  const green = sampleColorRegion({
    data,
    width: imageWidth,
    height: imageHeight,
    channels,
    region: [0.3, 0.34, 0.7, 0.56],
  });
  const red = sampleColorRegion({
    data,
    width: imageWidth,
    height: imageHeight,
    channels,
    region: [0.3, 0.52, 0.7, 0.74],
  });
  const darkRatio = center.ratios.dark;
  const greenRatio = green.ratios.green;
  const redRatio = red.ratios.red;
  return {
    active: darkRatio >= 0.72 && greenRatio >= 0.015 && redRatio >= 0.015,
    reason: 'share_status_visual',
    darkRatio,
    greenRatio,
    redRatio,
  };
}

export function inspectTencentShareStatusPng(png) {
  try {
    return inspectTencentShareStatusPixels(decodeRgbaPng(png));
  } catch (error) {
    return { active: false, reason: `png_decode_failed: ${error.message}` };
  }
}

export function executeTencentQuickMeeting(options = {}) {
  return executeTencentMeeting({
    ...options,
    meetingMode: 'quick',
  });
}

export function executeTencentJoinMeeting(options = {}) {
  return executeTencentMeeting({
    ...options,
    meetingMode: 'join',
  });
}

async function executeTencentMeeting({
  device,
  app,
  parameters = {},
  recordedSteps = [],
  sourceScreen = null,
  executeStep,
  startCapture = null,
  onStep = () => {},
  onStatus = () => {},
  sleep = delay,
  timings = {},
  meetingMode = 'quick',
} = {}) {
  if (!device || !app?.packageName) {
    throw new Error('腾讯会议执行器缺少设备或应用配置');
  }
  if (typeof executeStep !== 'function') {
    throw new Error('腾讯会议执行器缺少动作回放函数');
  }

  const checks = [];
  const joiningMeeting = meetingMode === 'join';
  const validationMode = joiningMeeting
    ? 'tencent_join_meeting_v1'
    : 'tencent_quick_meeting_v1';
  const meetingId = normalizeMeetingId(parameters.meetingId);
  const meetingPassword = String(parameters.meetingPassword || '').trim();
  if (joiningMeeting && !meetingId) {
    throw new Error('腾讯会议加入会议缺少有效会议号');
  }
  const effectiveDurationMs = durationParameterToMs(parameters.duration);
  const desiredCamera = Boolean(parameters.camera);
  const desiredShareScreen = Boolean(parameters.shareScreen);
  const waits = { ...DEFAULT_TIMINGS, ...timings };
  let replayStepIndex = 0;
  let activeScreen = normalizeScreen(sourceScreen || DEFAULT_SCREEN);
  let meetingEntered = false;

  const pass = (id, label, detail = '') => {
    checks.push({ id, label, status: 'passed', detail });
  };
  const fail = (id, label, detail) => {
    const check = { id, label, status: 'failed', detail };
    checks.push(check);
    throw new Error(detail);
  };

  try {
    const status = await device.getDeviceStatus();
    if (!status?.connected) {
      fail('device_connected', '设备连接', '未检测到已连接设备');
    }
    if (status.provider !== 'hdc') {
      fail(
        'harmony_device',
        '鸿蒙设备',
        `腾讯会议${joiningMeeting ? '加入会议' : '快速会议'}专用回放当前仅支持 HDC 鸿蒙设备`,
      );
    }
    pass('device_connected', '设备连接', status.serial || 'HDC');

    await device.keyevent('KEYCODE_BACK').catch(() => {});
    await sleep(waits.afterOverlayDismissMs);
    await device.forceStopPackage(app.packageName);
    await sleep(waits.afterStopMs);
    await device.launchPackage(app.packageName);
    await sleep(waits.afterLaunchMs);

    const appFocus = await waitForValue(
      () => device.getCurrentFocus(),
      (focus) => isTencentMeetingFocus(focus, app),
      waits,
      sleep,
    );
    if (!appFocus) {
      fail('app_launched', '启动腾讯会议', '腾讯会议启动后未进入前台');
    }
    pass(
      'app_launched',
      '启动腾讯会议',
      appFocus.bundleName || appFocus.packageName,
    );

    const targetScreen =
      (await device.getScreenSize?.().catch(() => null)) ||
      sourceScreen ||
      status.screen ||
      DEFAULT_SCREEN;
    const size = normalizeScreen(targetScreen);
    activeScreen = size;
    const homeSnapshot = await waitForTencentHome({
      device,
      app,
      waits,
      sleep,
    });
    if (!homeSnapshot) {
      fail(
        joiningMeeting ? 'join_meeting_setup' : 'quick_meeting_setup',
        joiningMeeting ? '进入加入会议设置' : '进入快速会议设置',
        `腾讯会议启动后未检测到首页“${joiningMeeting ? '加入会议' : '快速会议'}”入口`,
      );
    }

    const setupCheckId = joiningMeeting
      ? 'join_meeting_setup'
      : 'quick_meeting_setup';
    const setupCheckLabel = joiningMeeting
      ? '进入加入会议设置'
      : '进入快速会议设置';
    const entryText = joiningMeeting ? '加入会议' : '快速会议';
    const entryNode = findTextNode(homeSnapshot.layout, [entryText]);
    const entryPoint = entryNode
      ? {
          x: Math.round(
            (entryNode.bounds.x1 + entryNode.bounds.x2) / 2,
          ),
          y: Math.round(
            (entryNode.bounds.y1 + entryNode.bounds.y2) / 2,
          ),
        }
      : {
          x: Math.round(
            size.width *
              ((joiningMeeting ? 182 : 480) / DEFAULT_SCREEN.width),
          ),
          y: Math.round(size.height * (680 / DEFAULT_SCREEN.height)),
        };
    let setupSnapshot = null;
    for (let attempt = 0; attempt < 3 && !setupSnapshot; attempt += 1) {
      await device.tap(entryPoint);
      await sleep(
        joiningMeeting
          ? waits.afterJoinMeetingTapMs
          : waits.afterQuickMeetingTapMs,
      );
      setupSnapshot = await waitForValue(
        () => device.getUiTextSnapshot(),
        (snapshot) =>
          snapshot &&
          (joiningMeeting
            ? isTencentJoinSetupSnapshot(snapshot)
            : isTencentQuickSetupSnapshot(snapshot)),
        {
          ...waits,
          stateTimeoutMs: Math.min(waits.stateTimeoutMs, 2500),
        },
        sleep,
      );
    }
    if (!setupSnapshot) {
      fail(
        setupCheckId,
        setupCheckLabel,
        joiningMeeting
          ? '点击“加入会议”后未检测到会议号设置页'
          : '点击“快速会议”后未检测到“开启视频”和“进入会议”设置页',
      );
    }
    pass(setupCheckId, setupCheckLabel);

    if (joiningMeeting) {
      const meetingIdInput = findTencentMeetingIdInput(
        setupSnapshot.layout,
        size,
      );
      if (!meetingIdInput) {
        fail(
          'meeting_id_entered',
          '输入会议号',
          '加入会议设置页未找到会议号输入框',
        );
      }
      await device.inputText(meetingId, {
        clearExisting: true,
        x: meetingIdInput.x,
        y: meetingIdInput.y,
      });
      await sleep(waits.afterMeetingIdInputMs);
      setupSnapshot = await waitForValue(
        () => device.getUiTextSnapshot(),
        (snapshot) =>
          snapshot &&
          isTencentJoinSetupSnapshot(snapshot) &&
          snapshotContainsMeetingId(snapshot, meetingId),
        waits,
        sleep,
      );
      if (!setupSnapshot) {
        fail(
          'meeting_id_entered',
          '输入会议号',
          `会议号 ${meetingId} 未写入腾讯会议输入框`,
        );
      }
      pass('meeting_id_entered', '输入会议号', meetingId);
    }

    let camera = inspectTencentCameraToggle(setupSnapshot.layout, size);
    if (!camera) {
      fail(
        'camera_configured',
        '摄像头参数',
        '无法从腾讯会议设置页识别“开启视频”开关状态',
      );
    }
    if (camera.enabled !== desiredCamera) {
      await device.tap({ x: camera.x, y: camera.y });
      await sleep(waits.afterCameraTapMs);
      await handleTencentPermissionSnapshot({
        device,
        waits,
        sleep,
      });
      setupSnapshot = await device.getUiTextSnapshot();
      camera = inspectTencentCameraToggle(setupSnapshot.layout, size);
    }
    if (!camera || camera.enabled !== desiredCamera) {
      fail(
        'camera_configured',
        '摄像头参数',
        `摄像头开关未切换为${desiredCamera ? '开启' : '关闭'}`,
      );
    }
    pass(
      'camera_configured',
      '摄像头参数',
      desiredCamera ? '已开启' : '已关闭',
    );

    const enterLabel = joiningMeeting ? '加入会议' : '进入会议';
    const enterNode = joiningMeeting
      ? findLowestTextNode(setupSnapshot.layout, [enterLabel])
      : findTextNode(setupSnapshot.layout, [enterLabel]);
    if (!enterNode) {
      fail(
        'meeting_entered',
        '进入会议',
        `设置页未找到“${enterLabel}”按钮`,
      );
    }
    await device.tap({
      x: Math.round((enterNode.bounds.x1 + enterNode.bounds.x2) / 2),
      y: Math.round((enterNode.bounds.y1 + enterNode.bounds.y2) / 2),
    });
    await sleep(waits.afterEnterMeetingMs);

    if (joiningMeeting) {
      const passwordSnapshot = await device.getUiTextSnapshot().catch(() => null);
      if (isTencentPasswordSnapshot(passwordSnapshot)) {
        if (!meetingPassword) {
          fail(
            'meeting_password_entered',
            '输入会议密码',
            '会议要求输入密码，但快捷任务没有配置会议密码',
          );
        }
        const passwordInput = findTencentPasswordInput(
          passwordSnapshot.layout,
          size,
        );
        if (!passwordInput) {
          fail(
            'meeting_password_entered',
            '输入会议密码',
            '会议密码页未找到密码输入框',
          );
        }
        await device.inputText(meetingPassword, {
          clearExisting: true,
          x: passwordInput.x,
          y: passwordInput.y,
        });
        await sleep(waits.afterPasswordInputMs);
        const filledPasswordSnapshot =
          (await device.getUiTextSnapshot().catch(() => null)) ||
          passwordSnapshot;
        const passwordConfirm = findLowestTextNode(
          filledPasswordSnapshot.layout,
          ['加入会议', '确定', '确认'],
        );
        if (!passwordConfirm) {
          fail(
            'meeting_password_entered',
            '输入会议密码',
            '会议密码页未找到确认按钮',
          );
        }
        await tapNode(device, passwordConfirm);
        await sleep(waits.afterEnterMeetingMs);
        pass('meeting_password_entered', '输入会议密码', '已填写');
      } else {
        pass(
          'meeting_password_not_required',
          '会议密码',
          meetingPassword ? '未出现密码输入页' : '会议无需密码',
        );
      }
    }

    const meetingState = await waitForTencentMeetingEntry({
      device,
      app,
      waits,
      sleep,
    });
    if (!meetingState) {
      fail(
        'meeting_entered',
        '进入会议',
        '点击“进入会议”后未检测到腾讯会议会中界面',
      );
    }
    pass(
      'meeting_entered',
      '进入会议',
      meetingState.focus.activity || 'NXHostUIAbility',
    );
    meetingEntered = true;

    if (typeof startCapture === 'function') {
      await startCapture();
      pass('capture_started', '任务采集', '进入会议后已启动采集');
    }

    if (desiredShareScreen) {
      let shareDialogState = null;
      let sharingState = null;
      const dynamicShareState = await openTencentShareDialogDynamically({
        device,
        screen: size,
        waits,
        sleep,
        onStatus,
      });
      if (dynamicShareState?.sharingStarted) {
        sharingState = {
          ...dynamicShareState,
          dynamicEntry: true,
        };
      } else if (dynamicShareState?.open) {
        shareDialogState = dynamicShareState;
      }

      if (!shareDialogState && !sharingState) {
        const shareSteps = selectTencentShareSteps(
          recordedSteps,
          sourceScreen || size,
        );
        if (!shareSteps.length) {
          fail(
            'share_dialog_opened',
            '打开共享屏幕确认',
            '动态定位共享入口失败，录制轨迹中也没有可用的共享屏幕动作',
          );
        }

        for (const [{ step, index }, position] of shareSteps.map(
          (entry, position) => [entry, position],
        )) {
          const beforeFocus = await device.getCurrentFocus().catch(() => null);
          if (isShareDialogFocus(beforeFocus)) {
            shareDialogState = await readShareFlowState(device, beforeFocus);
            break;
          }

          await executeStep(step, { targetScreen: size });
          replayStepIndex = index + 1;
          onStep(replayStepIndex);
          const actionDelay = Math.max(
            Number(step.delayMs) || 0,
            waits.shareStepDelayMs,
          );
          await sleep(actionDelay);

          const afterFocus = await device.getCurrentFocus().catch(() => null);
          if (isShareDialogFocus(afterFocus)) {
            shareDialogState = await readShareFlowState(device, afterFocus);
            break;
          }

          const shouldInspectLayout =
            position >= 2 || position === shareSteps.length - 1;
          if (!shouldInspectLayout) continue;

          const visualState = await readShareVisualState(device);
          if (visualState?.active) {
            sharingState = {
              focus: afterFocus,
              snapshot: null,
              visualEvidence: visualState,
            };
            break;
          }

          const after = await readShareFlowState(device, afterFocus);
          if (after.sharingStarted) {
            sharingState = after;
            break;
          }
          if (after.open) {
            shareDialogState = after;
            break;
          }
        }
      }

      if (!shareDialogState && !sharingState) {
        const finalState = await waitForValue(
          () => readShareFlowState(device),
          (state) => state?.open || state?.sharingStarted,
          {
            ...waits,
            stateTimeoutMs: waits.shareDialogTimeoutMs,
          },
          sleep,
        );
        if (finalState?.sharingStarted) sharingState = finalState;
        else if (finalState?.open) shareDialogState = finalState;
      }

      if (!shareDialogState && !sharingState) {
        fail(
          'share_dialog_opened',
          '打开共享屏幕确认',
          `未检测到系统共享屏幕确认窗口 ${SHARE_DIALOG_BUNDLE} 或共享权限文本`,
        );
      }

      if (sharingState) {
        pass(
          'share_dialog_opened',
          '打开共享屏幕确认',
          sharingState.dynamicEntry
            ? '动态共享入口已启动，系统权限已复用'
            : '共享已启动，系统覆盖窗口由录制确认动作完成',
        );
        pass(
          'share_confirmed',
          '确认共享屏幕',
          sharingState.visualEvidence
            ? shareVisualEvidence(sharingState.visualEvidence)
            : shareStateEvidence(sharingState.snapshot),
        );
        pass('share_started', '共享屏幕状态', '共享已启动');
      } else {
        pass(
          'share_dialog_opened',
          '打开共享屏幕确认',
          shareDialogState.evidence,
        );

        const shareSnapshot =
          shareDialogState.snapshot ||
          (await device.getUiTextSnapshot().catch(() => null));
        const confirmNode = findPositiveConfirmationNode(shareSnapshot?.layout);
        if (!confirmNode) {
          fail(
            'share_confirmed',
            '确认共享屏幕',
            '系统共享屏幕窗口中未找到允许或开始共享按钮',
          );
        }
        await device.tap({
          x: Math.round((confirmNode.bounds.x1 + confirmNode.bounds.x2) / 2),
          y: Math.round((confirmNode.bounds.y1 + confirmNode.bounds.y2) / 2),
        });
        await sleep(waits.afterShareConfirmMs);

        let confirmedVisualState = await readShareVisualState(device);
        let confirmedSharingState = await readTencentShareStartedState({
          device,
          app,
        });
        if (!confirmedSharingState && !confirmedVisualState?.active) {
          await revealTencentMeetingControls({
            device,
            screen: size,
            waits,
            sleep,
          });
          confirmedVisualState = await readShareVisualState(device);
          confirmedSharingState = await waitForValue(
            () => readTencentShareStartedState({ device, app }),
            Boolean,
            waits,
            sleep,
          );
        }
        if (!confirmedSharingState && !confirmedVisualState?.active) {
          fail(
            'share_confirmed',
            '确认共享屏幕',
            '点击允许后未检测到“正在共享屏幕”“停止共享”或“结束共享”状态',
          );
        }
        pass(
          'share_confirmed',
          '确认共享屏幕',
          confirmedVisualState?.active
            ? shareVisualEvidence(confirmedVisualState)
            : shareStateEvidence(confirmedSharingState.snapshot),
        );
        pass('share_started', '共享屏幕状态', '共享已启动');
      }
    } else {
      pass('share_not_requested', '共享屏幕参数', '未请求共享屏幕');
    }

    await waitForMeetingDuration({
      device,
      app,
      durationMs: effectiveDurationMs,
      sleep,
    });
    pass(
      'duration_completed',
      '会议持续时间',
      `${effectiveDurationMs}ms`,
    );

    const finalFocus = await device.getCurrentFocus().catch(() => null);
    if (!isTencentMeetingFocus(finalFocus, app)) {
      fail(
        'meeting_sustained',
        '会议保持',
        '持续时间结束前腾讯会议已不在会中前台',
      );
    }
    pass('meeting_sustained', '会议保持');

    const endedNormally = await (joiningMeeting
      ? leaveTencentMeetingNormally({
          device,
          screen: size,
          waits,
          sleep,
        })
      : endTencentMeetingNormally({
          device,
          screen: size,
          waits,
          sleep,
        }));
    if (!endedNormally) {
      await device.forceStopPackage(app.packageName).catch(() => {});
      fail(
        'meeting_cleanup',
        '会议清理',
        joiningMeeting
          ? '未能通过“离开会议”正常离会，会话未通过清理验证'
          : '未能通过“结束会议”正常结束，会话未通过清理验证',
      );
    }
    pass(
      'meeting_cleanup',
      '会议清理',
      joiningMeeting
        ? '已正常离开会议并返回首页'
        : '已正常结束会议并返回首页',
    );

    return {
      validationMode,
      validationChecks: checks,
      effectiveDurationMs,
      replayStepIndex,
    };
  } catch (error) {
    let endedNormally = false;
    if (meetingEntered) {
      endedNormally = Boolean(
        await (joiningMeeting
          ? leaveTencentMeetingNormally({
              device,
              screen: activeScreen,
              waits,
              sleep,
            })
          : endTencentMeetingNormally({
              device,
              screen: activeScreen,
              waits,
              sleep,
            })
        ).catch(() => null),
      );
    }
    if (!endedNormally) {
      await device.forceStopPackage(app.packageName).catch(() => {});
    }
    error.validationMode = validationMode;
    error.validationChecks = checks;
    error.effectiveDurationMs = effectiveDurationMs;
    error.replayStepIndex = replayStepIndex;
    throw error;
  }
}

async function endTencentMeetingNormally({ device, screen, waits, sleep }) {
  let dialogSnapshot = null;
  for (let attempt = 0; attempt < 2 && !dialogSnapshot; attempt += 1) {
    await device.keyevent('KEYCODE_BACK');
    await sleep(waits.afterEndDialogMs);
    dialogSnapshot = await waitForValue(
      () => device.getUiTextSnapshot(),
      (snapshot) =>
        snapshot &&
        snapshot.text.includes('离开会议') &&
        snapshot.text.includes('结束会议'),
      {
        ...waits,
        stateTimeoutMs: Math.min(waits.stateTimeoutMs, 4000),
      },
      sleep,
    );
  }
  const endNode = findTextNode(dialogSnapshot?.layout, ['结束会议']);
  if (endNode) {
    await device.tap({
      x: Math.round((endNode.bounds.x1 + endNode.bounds.x2) / 2),
      y: Math.round((endNode.bounds.y1 + endNode.bounds.y2) / 2),
    });
  } else {
    await device.tap({
      x: Math.round(screen.width * (787 / DEFAULT_SCREEN.width)),
      y: Math.round(screen.height * (2371 / DEFAULT_SCREEN.height)),
    });
  }
  await sleep(waits.afterEndConfirmMs);

  return waitForValue(
    () => device.getUiTextSnapshot(),
    (snapshot) =>
      snapshot &&
      snapshot.text.includes('快速会议') &&
      !snapshot.text.includes('进入会议') &&
      !snapshot.text.includes('进行中'),
    waits,
    sleep,
  );
}

async function leaveTencentMeetingNormally({ device, screen, waits, sleep }) {
  let leaveDialog = null;
  for (let attempt = 0; attempt < 3 && !leaveDialog; attempt += 1) {
    const snapshot = await device.getUiTextSnapshot().catch(() => null);
    if (
      snapshot?.text.includes('确定离开会议吗') &&
      snapshot.text.includes('离开会议')
    ) {
      leaveDialog = snapshot;
      break;
    }

    const leaveNode = findTextNode(snapshot?.layout, ['离开']);
    if (leaveNode) {
      await tapNode(device, leaveNode);
    } else if (attempt < 2) {
      await device.keyevent('KEYCODE_BACK');
    } else {
      await device.tap({
        x: Math.round(screen.width * (1182 / 1280)),
        y: Math.round(screen.height * (221 / 2832)),
      });
    }
    await sleep(waits.afterEndDialogMs);
    leaveDialog = await waitForValue(
      () => device.getUiTextSnapshot(),
      (candidate) =>
        candidate &&
        candidate.text.includes('离开会议') &&
        (candidate.text.includes('确定离开会议吗') ||
          !candidate.text.includes('结束会议')),
      {
        ...waits,
        stateTimeoutMs: Math.min(waits.stateTimeoutMs, 3000),
      },
      sleep,
    );
  }

  const leaveMeetingNode = findLowestTextNode(leaveDialog?.layout, [
    '离开会议',
  ]);
  if (!leaveMeetingNode) return null;
  await tapNode(device, leaveMeetingNode);
  await sleep(waits.afterEndConfirmMs);

  return waitForTencentHomeSnapshot({ device, waits, sleep });
}

function normalizeLegacyLongPress(entry, screen) {
  const step = { ...entry.step };
  const expectedX = screen.width * (937 / DEFAULT_SCREEN.width);
  const expectedY = screen.height * (1818 / DEFAULT_SCREEN.height);
  const isLegacyLongClick =
    step.type === 'tap' &&
    Math.abs(Number(step.x) - expectedX) <= screen.width * 0.07 &&
    Math.abs(Number(step.y) - expectedY) <= screen.height * 0.05;
  if (isLegacyLongClick) {
    step.type = 'long_press';
    step.durationMs = Math.max(800, Number(step.durationMs) || 800);
  }
  return { ...entry, step };
}

async function waitForMeetingDuration({ device, app, durationMs, sleep }) {
  let remaining = durationMs;
  while (remaining > 0) {
    const chunk = Math.min(WAIT_CHUNK_MS, remaining);
    await sleep(chunk);
    remaining -= chunk;
    if (remaining <= 0) return;

    const focus = await device.getCurrentFocus().catch(() => null);
    if (!isTencentMeetingFocus(focus, app)) {
      throw new Error('会议持续期间腾讯会议离开前台');
    }
  }
}

async function waitForTencentHome({ device, app, waits, sleep }) {
  const deadline = Date.now() + Math.max(0, Number(waits.stateTimeoutMs) || 0);

  while (true) {
    const [focus, snapshot] = await Promise.all([
      device.getCurrentFocus().catch(() => null),
      device.getUiTextSnapshot().catch(() => null),
    ]);
    if (
      isTencentMeetingFocus(focus, app) &&
      snapshot?.text.includes('快速会议') &&
      snapshot.text.includes('加入会议')
    ) {
      if (isTencentRecoverySnapshot(snapshot)) {
        const cancelNode = findTextNode(snapshot.layout, ['取消']);
        if (cancelNode) {
          await tapNode(device, cancelNode);
          await sleep(waits.afterRecoveryDismissMs);
          continue;
        }
      }
      return snapshot;
    }
    if (Date.now() >= deadline) break;
    await sleep(waits.pollIntervalMs);
  }

  return null;
}

async function waitForTencentHomeSnapshot({ device, waits, sleep }) {
  return waitForValue(
    () => device.getUiTextSnapshot(),
    (snapshot) =>
      snapshot &&
      snapshot.text.includes('快速会议') &&
      snapshot.text.includes('加入会议'),
    waits,
    sleep,
  );
}

async function waitForTencentMeetingEntry({ device, app, waits, sleep }) {
  const deadline = Date.now() + Math.max(0, Number(waits.stateTimeoutMs) || 0);

  while (true) {
    const [focus, snapshot] = await Promise.all([
      device.getCurrentFocus().catch(() => null),
      device.getUiTextSnapshot().catch(() => null),
    ]);
    if (isTencentPermissionSnapshot(snapshot)) {
      const handled = await handleTencentPermissionSnapshot({
        device,
        snapshot,
        waits,
        sleep,
      });
      if (handled) continue;
    }
    if (
      isTencentMeetingFocus(focus, app) &&
      snapshot &&
      !snapshot.text.includes('正在进入会议') &&
      !isTencentMeetingSetupSnapshot(snapshot) &&
      !isTencentPasswordSnapshot(snapshot) &&
      hasNxHostSurface(snapshot.layout)
    ) {
      return { focus, snapshot };
    }
    if (Date.now() >= deadline) break;
    await sleep(waits.pollIntervalMs);
  }

  return null;
}

async function handleTencentPermissionSnapshot({
  device,
  snapshot = null,
  waits,
  sleep,
}) {
  let current =
    snapshot || (await device.getUiTextSnapshot().catch(() => null));
  if (!isTencentPermissionSnapshot(current)) return false;

  const allowNode = findTextNode(current.layout, [
    '允许',
    '仅使用期间允许',
    '使用时允许',
  ]);
  if (!allowNode) return false;
  await tapNode(device, allowNode);
  await sleep(waits.afterPermissionChoiceMs);

  current = await device.getUiTextSnapshot().catch(() => null);
  const confirmNode = findTextNode(current?.layout, ['确定']);
  if (confirmNode) {
    await tapNode(device, confirmNode);
    await sleep(waits.afterPermissionConfirmMs);
  }
  return true;
}

async function waitForValue(read, predicate, timings, sleep) {
  const timeoutMs = Math.max(0, Number(timings.stateTimeoutMs) || 0);
  const intervalMs = Math.max(0, Number(timings.pollIntervalMs) || 0);
  const startedAt = Date.now();
  let lastValue = null;

  do {
    lastValue = await read().catch(() => null);
    if (predicate(lastValue)) return lastValue;
    if (Date.now() - startedAt >= timeoutMs) break;
    await sleep(intervalMs);
  } while (Date.now() - startedAt <= timeoutMs);

  return null;
}

function isTencentRecoverySnapshot(snapshot) {
  const text = String(snapshot?.text || '');
  return (
    text.includes('上次异常退出') &&
    text.includes('恢复会议') &&
    text.includes('取消')
  );
}

function isTencentPermissionSnapshot(snapshot) {
  const text = String(snapshot?.text || '');
  return (
    /(麦克风|摄像头|相机)权限/.test(text) &&
    /(允许|使用时允许)/.test(text) &&
    text.includes('确定')
  );
}

function isTencentQuickSetupSnapshot(snapshot) {
  const text = String(snapshot?.text || '');
  return text.includes('开启视频') && text.includes('进入会议');
}

function isTencentJoinSetupSnapshot(snapshot) {
  const text = String(snapshot?.text || '');
  return (
    text.includes('会议号') &&
    text.includes('您的名称') &&
    text.includes('开启视频') &&
    text.includes('加入会议')
  );
}

function isTencentMeetingSetupSnapshot(snapshot) {
  return (
    isTencentQuickSetupSnapshot(snapshot) ||
    isTencentJoinSetupSnapshot(snapshot)
  );
}

function isTencentPasswordSnapshot(snapshot) {
  const text = String(snapshot?.text || '');
  return (
    /(会议密码|请输入密码|输入会议密码)/.test(text) &&
    /(加入会议|确定|确认)/.test(text)
  );
}

async function tapNode(device, node) {
  await device.tap({
    x: Math.round((node.bounds.x1 + node.bounds.x2) / 2),
    y: Math.round((node.bounds.y1 + node.bounds.y2) / 2),
  });
}

function isTencentMeetingFocus(focus, app) {
  return Boolean(
    focus &&
      (focus.bundleName === (app.harmonyBundleName || TENCENT_MEETING_BUNDLE) ||
        focus.packageName === app.packageName ||
        focus.packageName === TENCENT_MEETING_BUNDLE),
  );
}

function isShareDialogFocus(focus) {
  return Boolean(
    focus &&
      [focus.bundleName, focus.packageName, focus.activity].some((value) =>
        String(value || '').includes(SHARE_DIALOG_BUNDLE),
      ),
  );
}

async function openTencentShareDialogDynamically({
  device,
  screen,
  waits,
  sleep,
  onStatus,
}) {
  let meetingSnapshot = await device.getUiTextSnapshot().catch(() => null);
  onStatus(
    `共享动态定位: 初始会中状态 ${summarizeTencentShareSnapshot(meetingSnapshot)}`,
  );
  let shareEntry = findLowestTextNode(meetingSnapshot?.layout, [
    '共享屏幕',
  ]);
  if (!shareEntry) {
    await revealTencentMeetingControls({
      device,
      screen,
      waits,
      sleep,
    });
    meetingSnapshot = await waitForValue(
      () => device.getUiTextSnapshot(),
      (snapshot) => snapshot?.text.includes('共享屏幕'),
      {
        ...waits,
        stateTimeoutMs: Math.min(waits.stateTimeoutMs, 3000),
      },
      sleep,
    );
    shareEntry = findLowestTextNode(meetingSnapshot?.layout, ['共享屏幕']);
  }
  if (!shareEntry) {
    onStatus(
      `共享动态定位: 未找到会中共享入口 ${summarizeTencentShareSnapshot(meetingSnapshot)}`,
    );
    return null;
  }
  onStatus(`共享动态定位: 点击会中共享入口 ${shareEntry.rawBounds}`);
  await tapNode(device, shareEntry);
  await sleep(waits.shareStepDelayMs);

  const menuSnapshot = await waitForValue(
    () => device.getUiTextSnapshot(),
    (snapshot) =>
      snapshot?.text.includes('共享屏幕') &&
      snapshot.text.includes('共享白板'),
    {
      ...waits,
      stateTimeoutMs: Math.min(waits.stateTimeoutMs, 3000),
    },
    sleep,
  );
  const menuAction = findTencentShareMenuAction(menuSnapshot?.layout, screen);
  if (!menuAction) {
    onStatus(
      `共享动态定位: 未找到二级共享菜单 ${summarizeTencentShareSnapshot(menuSnapshot)}`,
    );
    return null;
  }
  onStatus(
    `共享动态定位: 点击二级共享菜单 (${menuAction.x},${menuAction.y})`,
  );
  await device.tap(menuAction);
  await sleep(waits.shareStepDelayMs);

  const shareState = await waitForValue(
    () => readShareFlowState(device),
    (state) => state?.open || state?.sharingStarted,
    {
      ...waits,
      stateTimeoutMs: Math.max(
        waits.shareDialogTimeoutMs,
        Math.min(waits.stateTimeoutMs, 5000),
      ),
    },
    sleep,
  );
  if (shareState) {
    onStatus(
      `共享动态定位: 检测到${shareState.open ? '系统确认' : '共享状态'} ${summarizeTencentShareSnapshot(shareState.snapshot)}`,
    );
    return shareState;
  }

  await revealTencentMeetingControls({
    device,
    screen,
    waits,
    sleep,
  });
  const directShareState = await waitForValue(
    () => readShareFlowState(device),
    (state) => state?.sharingStarted,
    {
      ...waits,
      stateTimeoutMs: Math.min(waits.stateTimeoutMs, 3000),
    },
    sleep,
  );
  onStatus(
    directShareState
      ? `共享动态定位: 无确认窗直接共享 ${summarizeTencentShareSnapshot(directShareState.snapshot)}`
      : '共享动态定位: 二级菜单后未检测到确认窗或共享状态',
  );
  return directShareState;
}

async function readShareFlowState(device, knownFocus = null) {
  const [focus, snapshot] = await Promise.all([
    knownFocus
      ? Promise.resolve(knownFocus)
      : device.getCurrentFocus().catch(() => null),
    device.getUiTextSnapshot().catch(() => null),
  ]);
  const focusMatch = isShareDialogFocus(focus);
  const textMatch = isShareDialogSnapshot(snapshot);
  return {
    open: focusMatch || textMatch,
    sharingStarted: hasShareStartedSnapshot(snapshot),
    focus,
    snapshot,
    evidence: focusMatch
      ? focus.bundleName || focus.packageName || SHARE_DIALOG_BUNDLE
      : shareDialogEvidence(snapshot),
  };
}

async function readTencentShareStartedState({ device, app }) {
  const [focus, snapshot] = await Promise.all([
    device.getCurrentFocus().catch(() => null),
    device.getUiTextSnapshot().catch(() => null),
  ]);
  return isTencentMeetingFocus(focus, app) && hasShareStartedSnapshot(snapshot)
    ? { focus, snapshot }
    : null;
}

async function revealTencentMeetingControls({ device, screen, waits, sleep }) {
  await device.tap({
    x: Math.round(screen.width * 0.5),
    y: Math.round(screen.height * 0.67),
  });
  await sleep(Math.min(500, Math.max(200, waits.shareStepDelayMs)));
}

async function readShareVisualState(device) {
  if (typeof device?.screenshotPng !== 'function') return null;
  const png = await device.screenshotPng().catch(() => null);
  return png ? inspectTencentShareStatusPng(png) : null;
}

function isShareDialogSnapshot(snapshot) {
  const text = String(snapshot?.text || '');
  const systemPermission =
    /(使用你的屏幕|录制\s*\/?\s*投射屏幕|捕获你的屏幕|共享或录制屏幕)/.test(
      text,
    ) &&
    /(允许|开始|立即开始)/.test(text);
  const appConfirmation =
    text.includes('共享屏幕') &&
    /(开始共享|立即开始)/.test(text) &&
    /(取消|不允许|拒绝)/.test(text);
  return systemPermission || appConfirmation;
}

function shareDialogEvidence(snapshot) {
  const text = String(snapshot?.text || '');
  return (
    [
      '使用你的屏幕',
      '录制/投射屏幕',
      '共享或录制屏幕',
      '开始共享',
    ].find((value) => text.includes(value)) || '共享权限文本'
  );
}

function hasShareStartedSnapshot(snapshot) {
  return /(您?正在共享屏幕|停止共享|结束共享)/.test(
    String(snapshot?.text || ''),
  );
}

function shareStateEvidence(snapshot) {
  const text = String(snapshot?.text || '');
  return (
    ['您正在共享屏幕', '正在共享屏幕', '停止共享', '结束共享'].find(
      (value) => text.includes(value),
    ) || '共享状态已出现'
  );
}

function shareVisualEvidence(state) {
  return `共享状态页像素验证通过 dark=${state.darkRatio.toFixed(3)} green=${state.greenRatio.toFixed(3)} red=${state.redRatio.toFixed(3)}`;
}

function summarizeTencentShareSnapshot(snapshot) {
  const text = String(snapshot?.text || '');
  const markers = [
    '正在进入会议',
    '共享屏幕',
    '共享白板',
    '使用你的屏幕',
    '允许',
    '结束共享',
    '停止共享',
    '离开',
  ].filter((value) => text.includes(value));
  return markers.length ? markers.join(',') : `textLength=${text.length}`;
}

function hasNxHostSurface(layout) {
  return flattenLayout(layout).some(
    (node) =>
      /NxHostView|NXView|NXLayer/i.test(String(node.attributes.id || '')) ||
      /NXHostUIAbility/i.test(String(node.attributes.abilityName || '')),
  );
}

function findTextNode(layout, texts, { partial = false } = {}) {
  const expected = Array.isArray(texts) ? texts : [texts];
  return (
    flattenLayout(layout).find((node) =>
      expected.some((candidate) =>
        node.textValues.some((value) =>
          partial ? value.includes(String(candidate)) : value === String(candidate),
        ),
      ),
    ) || null
  );
}

function findLowestTextNode(layout, texts, { partial = false } = {}) {
  const expected = Array.isArray(texts) ? texts : [texts];
  return (
    flattenLayout(layout)
      .filter((node) =>
        expected.some((candidate) =>
          node.textValues.some((value) =>
            partial
              ? value.includes(String(candidate))
              : value === String(candidate),
          ),
        ),
      )
      .sort((left, right) => right.bounds.y2 - left.bounds.y2)[0] || null
  );
}

function findTencentMeetingIdInput(layout, screen) {
  const size = normalizeScreen(screen);
  const nodes = flattenLayout(layout);
  const placeholder = nodes.find((node) =>
    node.textValues.some((value) => value.includes('请输入会议号')),
  );
  if (placeholder) return pointForNode(placeholder);

  const input = nodes.find((node) => {
    const centerY = (node.bounds.y1 + node.bounds.y2) / 2;
    return (
      /TextInput/i.test(String(node.attributes.type || '')) &&
      centerY >= size.height * 0.1 &&
      centerY <= size.height * 0.25
    );
  });
  if (input) return pointForNode(input);

  const label = findTextNode(layout, ['会议号']);
  if (!label) return null;
  return {
    x: Math.round(size.width * 0.55),
    y: Math.round((label.bounds.y1 + label.bounds.y2) / 2),
  };
}

function findTencentPasswordInput(layout, screen) {
  const size = normalizeScreen(screen);
  const nodes = flattenLayout(layout);
  const placeholder = nodes.find((node) =>
    node.textValues.some((value) =>
      /(请输入密码|输入会议密码|会议密码)/.test(value),
    ),
  );
  if (placeholder) return pointForNode(placeholder);

  const input = nodes.find((node) => {
    const centerY = (node.bounds.y1 + node.bounds.y2) / 2;
    return (
      /TextInput/i.test(String(node.attributes.type || '')) &&
      centerY >= size.height * 0.1 &&
      centerY <= size.height * 0.6
    );
  });
  return input ? pointForNode(input) : null;
}

function findTencentShareMenuAction(layout, screen) {
  const size = normalizeScreen(screen);
  const nodes = flattenLayout(layout);
  const whiteboard = nodes.find((node) =>
    node.textValues.some((value) => value === '共享白板'),
  );
  const candidates = nodes.filter(
    (node) =>
      node.textValues.some((value) => value === '共享屏幕') &&
      node.bounds.y2 < size.height * 0.94,
  );
  if (!candidates.length) return null;
  if (!whiteboard) {
    return pointForNode(
      candidates.sort((left, right) => right.bounds.y2 - left.bounds.y2)[0],
    );
  }
  const aboveWhiteboard = candidates
    .filter((node) => node.bounds.y2 <= whiteboard.bounds.y1)
    .sort(
      (left, right) =>
        whiteboard.bounds.y1 -
        left.bounds.y2 -
        (whiteboard.bounds.y1 - right.bounds.y2),
    )[0];
  return aboveWhiteboard ? pointForNode(aboveWhiteboard) : null;
}

function snapshotContainsMeetingId(snapshot, expectedMeetingId) {
  return flattenLayout(snapshot?.layout).some((node) =>
    node.textValues.some(
      (value) => normalizeMeetingId(value) === expectedMeetingId,
    ),
  );
}

function normalizeMeetingId(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 6 && digits.length <= 15 ? digits : '';
}

function pointForNode(node) {
  return {
    x: Math.round((node.bounds.x1 + node.bounds.x2) / 2),
    y: Math.round((node.bounds.y1 + node.bounds.y2) / 2),
  };
}

function findPositiveConfirmationNode(layout) {
  const nodes = flattenLayout(layout);
  const exactActions = new Set([
    '允许',
    '开始共享',
    '立即开始',
    '同意',
    '确定',
  ]);
  const exact = nodes.find((node) =>
    node.textValues.some((value) => exactActions.has(value)),
  );
  if (exact) return exact;

  return (
    nodes.find((node) =>
      node.textValues.some(
        (value) =>
          /(允许|开始共享|立即开始|同意|确定)/.test(value) &&
          !/(不允许|拒绝|取消|不同意)/.test(value),
      ),
    ) || null
  );
}

function flattenLayout(layout) {
  const nodes = [];

  function visit(node) {
    if (!node || typeof node !== 'object') return;
    const attributes =
      node.attributes && typeof node.attributes === 'object'
        ? node.attributes
        : node.attrs && typeof node.attrs === 'object'
          ? node.attrs
          : node;
    const bounds = parseBounds(attributes.bounds ?? attributes.rect ?? attributes.frame);
    if (bounds) {
      nodes.push({
        attributes,
        bounds,
        rawBounds: String(attributes.bounds || ''),
        childCount: Array.isArray(node.children) ? node.children.length : 0,
        textValues: [
          attributes.text,
          attributes.originalText,
          attributes.description,
          attributes.contentDescription,
          attributes.hint,
          attributes.label,
        ]
          .map((value) => String(value || '').trim())
          .filter(Boolean),
      });
    }
    for (const child of Array.isArray(node.children) ? node.children : []) {
      visit(child);
    }
  }

  visit(layout);
  return nodes;
}

function parseBounds(value) {
  if (typeof value === 'string') {
    const match = value.match(
      /\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/,
    );
    if (match) {
      return {
        x1: Number(match[1]),
        y1: Number(match[2]),
        x2: Number(match[3]),
        y2: Number(match[4]),
      };
    }
  }
  if (!value || typeof value !== 'object') return null;

  const x1 = Number(value.x1 ?? value.left ?? value.x);
  const y1 = Number(value.y1 ?? value.top ?? value.y);
  const x2 = Number(value.x2 ?? value.right ?? x1 + Number(value.width || 0));
  const y2 = Number(value.y2 ?? value.bottom ?? y1 + Number(value.height || 0));
  return [x1, y1, x2, y2].every(Number.isFinite)
    ? { x1, y1, x2, y2 }
    : null;
}

function normalizeScreen(screen) {
  return {
    width: Number(screen?.width) || DEFAULT_SCREEN.width,
    height: Number(screen?.height) || DEFAULT_SCREEN.height,
  };
}

function isPointStep(step) {
  return ['tap', 'long_press'].includes(step?.type);
}

export function decodeRgbaPng(png) {
  if (!Buffer.isBuffer(png) || png.length < 33) {
    throw new Error('PNG 数据为空');
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!png.subarray(0, 8).equals(signature)) {
    throw new Error('PNG 签名无效');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const compressed = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > png.length) throw new Error('PNG chunk 越界');
    const chunk = png.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
      interlace = chunk[12];
    } else if (type === 'IDAT') {
      compressed.push(chunk);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!width || !height || bitDepth !== 8 || !channels || interlace !== 0) {
    throw new Error(
      `不支持的 PNG 格式 ${width}x${height} depth=${bitDepth} color=${colorType} interlace=${interlace}`,
    );
  }
  const rowBytes = width * channels;
  const inflated = inflateSync(Buffer.concat(compressed));
  const expectedLength = (rowBytes + 1) * height;
  if (inflated.length < expectedLength) {
    throw new Error(`PNG 像素数据不完整 ${inflated.length}/${expectedLength}`);
  }

  const pixels = Buffer.allocUnsafe(rowBytes * height);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    const rowOffset = y * rowBytes;
    const previousRowOffset = rowOffset - rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = inflated[sourceOffset + x];
      const left = x >= channels ? pixels[rowOffset + x - channels] : 0;
      const up = y > 0 ? pixels[previousRowOffset + x] : 0;
      const upperLeft =
        y > 0 && x >= channels
          ? pixels[previousRowOffset + x - channels]
          : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, upperLeft);
      else if (filter !== 0) throw new Error(`不支持的 PNG filter ${filter}`);
      pixels[rowOffset + x] = (raw + predictor) & 0xff;
    }
    sourceOffset += rowBytes;
  }
  return { width, height, data: pixels, channels };
}

function sampleColorRegion({ data, width, height, channels, region }) {
  const [left, top, right, bottom] = region;
  const x1 = Math.max(0, Math.floor(width * left));
  const y1 = Math.max(0, Math.floor(height * top));
  const x2 = Math.min(width, Math.ceil(width * right));
  const y2 = Math.min(height, Math.ceil(height * bottom));
  const stride = Math.max(1, Math.floor(Math.min(width, height) / 320));
  let sampled = 0;
  let dark = 0;
  let green = 0;
  let red = 0;

  for (let y = y1; y < y2; y += stride) {
    for (let x = x1; x < x2; x += stride) {
      const offset = (y * width + x) * channels;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      sampled += 1;
      if (r <= 45 && g <= 45 && b <= 45) dark += 1;
      if (g >= 135 && g >= r * 1.45 && g >= b * 1.15) green += 1;
      if (r >= 165 && r >= g * 1.45 && r >= b * 1.2) red += 1;
    }
  }

  return {
    sampled,
    ratios: {
      dark: sampled ? dark / sampled : 0,
      green: sampled ? green / sampled : 0,
      red: sampled ? red / sampled : 0,
    },
  };
}

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
