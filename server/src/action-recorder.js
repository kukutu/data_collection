import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { config } from './config.js';
import { findWorkflow } from './workflow-registry.js';
import {
  executeTencentQuickMeeting,
  TENCENT_QUICK_MEETING_WORKFLOW_ID,
} from './skills/tencent-meeting.js';
import {
  executeWechatMediaTransfer,
  WECHAT_MEDIA_VALIDATION_MODE,
  WECHAT_MEDIA_WORKFLOW_ID,
} from './skills/wechat-media.js';
import { repairTrajectoryWithModel } from './skills/trajectory-repair.js';

const MAX_REPLAY_DELAY_MS = 5 * 60 * 1000;
const FALLBACK_STEP_DELAY_MS = 400;
const STATUS_BAR_CORNER_RATIO = 0.025;
const STATUS_BAR_HEIGHT_RATIO = 0.015;

export class ActionRecorder {
  constructor({
    device,
    apps = [],
    recordingsRoot = config.recordings.root,
    now = () => new Date(),
    trajectoryRepair = repairTrajectoryWithModel,
    quickMeetingExecutor = executeTencentQuickMeeting,
    wechatMediaExecutor = executeWechatMediaTransfer,
    workflows = [],
  } = {}) {
    this.device = device;
    this.apps = apps;
    this.recordingsRoot = recordingsRoot;
    this.now = now;
    this.trajectoryRepair = trajectoryRepair;
    this.quickMeetingExecutor = quickMeetingExecutor;
    this.wechatMediaExecutor = wechatMediaExecutor;
    this.workflows = workflows;
    this.sessions = new Map();
    this.activeId = null;
  }

  async start({ appId, workflowId, featureName, parameters = {} } = {}) {
    await this.#releaseStaleActiveSession();
    if (this.activeId) throw new Error('已有录制或回放任务正在运行');

    const workflow = workflowId ? findWorkflow(this.workflows, workflowId) : null;
    if (workflowId && !workflow) throw new Error(`未找到功能: ${workflowId}`);
    if (workflow && appId && workflow.appId !== appId) {
      throw new Error('App 与功能不匹配');
    }

    const selectedAppId = workflow?.appId || appId;
    const app = this.apps.find((candidate) => candidate.id === selectedAppId);
    if (!app) throw new Error(`未找到应用: ${appId}`);
    const selectedFeatureName =
      String(featureName || workflow?.featureName || '未命名功能').trim() || '未命名功能';

    const id = randomUUID();
    let deviceLock = null;
    let session = null;
    try {
      deviceLock =
        typeof this.device.beginSession === 'function'
          ? await this.device.beginSession({ owner: `recording:${id}` })
          : null;
      const deviceStatus = deviceLock || (await this.device.getDeviceStatus());
      if (!deviceStatus?.connected) throw new Error('录制前未检测到已连接设备');

      const outputDir = join(
        resolve(this.recordingsRoot),
        safeSegment(app.name),
        safeSegment(selectedFeatureName),
        `${formatTimestamp(this.now())}-${id.slice(0, 8)}`,
      );
      await mkdir(outputDir, { recursive: true });

      session = {
        id,
        appId: app.id,
        appName: app.name,
        workflowId: workflow?.id || null,
        workflowName: workflow?.featureName || null,
        featureName: selectedFeatureName,
        recordingKey: workflow?.id || `${selectedAppId}:${selectedFeatureName}`,
        parameterSchema: workflow?.params || [],
        parameters: sanitizeParameters(workflow?.params || [], parameters),
        runtimeParameters: clone(parameters),
        validationStatus: 'unverified',
        validationMode: null,
        validationChecks: [],
        validatedAt: null,
        validationError: null,
        effectiveDurationMs: null,
        status: 'starting',
        provider: deviceStatus.provider,
        serial: deviceStatus.serial || '',
        screen: deviceStatus.screen || null,
        outputDir,
        trajectoryFile: join(outputDir, 'trajectory.json'),
        skillFile: join(outputDir, 'skill-draft.json'),
        contextFile: join(outputDir, 'contexts.json'),
        rawLiveFile: join(outputDir, 'raw-live.jsonl'),
        rawRemoteFile: join(outputDir, 'raw-remote.log'),
        startedAt: this.now().toISOString(),
        stoppedAt: null,
        replayStartedAt: null,
        replayFinishedAt: null,
        replayStepIndex: 0,
        replaySource: null,
        steps: [],
        correctedSteps: [],
        correctedSkillFile: null,
        correctionStatus: null,
        correctionSource: null,
        correctionChanges: [],
        correctionConfidence: null,
        correctionError: null,
        diagnostics: [],
        contexts: [],
        screenshots: {},
        timelineSource: null,
        timelineQuality: null,
        recordingQuality: null,
        qualityScore: null,
        qualityIssues: [],
        remoteStepCount: 0,
        streamStepCount: 0,
        mergedStepCount: 0,
        rejectedStepCount: 0,
        matchedStepCount: 0,
        actionContextCount: 0,
        liveActionEventCount: 0,
        error: null,
        inputProcess: null,
        outputLines: [],
        liveCandidates: [],
        rawLiveWriteQueue: Promise.resolve(),
        rawLiveWriteFailed: false,
        actionContextQueue: Promise.resolve(),
        flushOutput: null,
        deviceLock,
      };
      await Promise.all([
        writeFile(session.rawLiveFile, '', 'utf8'),
        writeFile(session.rawRemoteFile, '', 'utf8'),
      ]);

      this.sessions.set(id, session);
      this.activeId = id;
      await captureDeviceContext(session, this.device, 'recording-start', {
        parameterSchema: session.parameterSchema,
        parameters: session.runtimeParameters,
      });
      const recorder = await this.device.startUiRecording({
        recordWidgetInfo: true,
        printToConsole: true,
      });
      if (!recorder?.process) throw new Error('设备没有返回录制进程');

      session.provider = recorder.provider || session.provider;
      session.serial = recorder.serial || session.serial;
      session.recordingMode = recorder.mode || 'unknown';
      session.inputProcess = recorder.process;
      session.readUiRecording = recorder.readUiRecording || null;
      session.flushOutput = attachOutput(session, recorder.process, this.device);
      await this.#discardUnverifiedSessions(session);
      session.status = 'recording';
      return this.snapshot(id);
    } catch (error) {
      if (session) {
        session.error = error.message;
        session.status = 'failed';
      }
      this.activeId = null;
      if (deviceLock && typeof this.device.endSession === 'function') {
        await this.device.endSession(deviceLock).catch(() => {});
        if (session) session.deviceLock = null;
      }
      throw error;
    }
  }

  async stop(id) {
    const session = this.#get(id);
    if (!['recording', 'starting'].includes(session.status)) return this.snapshot(id);

    session.status = 'stopping';
    try {
      await stopProcess(session.inputProcess, session.diagnostics);
      await sleep(50);
      session.flushOutput?.();
      await session.rawLiveWriteQueue;

      let remoteOutput = '';
      try {
        remoteOutput = session.readUiRecording
          ? await session.readUiRecording({ timeoutMs: 3000 })
          : await this.device.readUiRecording({ serial: session.serial });
      } catch (error) {
        session.diagnostics.push(`读取设备录制结果失败: ${error.message}`);
      }

      try {
        await writeFile(
          session.rawRemoteFile,
          redactSensitiveData(
            String(remoteOutput || ''),
            collectSensitiveValues(session.parameterSchema, session.runtimeParameters),
          ),
          'utf8',
        );
      } catch (error) {
        session.diagnostics.push(`raw-remote.log write failed: ${error.message}`);
      }

      session.stoppedAt = this.now().toISOString();
      const timeline = selectRecordedTrajectory({
        remoteOutput,
        receivedLines: session.outputLines,
        recordingDurationMs: elapsedBetween(session.startedAt, session.stoppedAt),
        screen: session.screen,
      });
      session.timelineSource = timeline.source;
      session.timelineQuality = timeline.quality;
      session.remoteStepCount = timeline.remoteStepCount;
      session.streamStepCount = timeline.streamStepCount;
      session.mergedStepCount = timeline.mergedStepCount;
      session.rejectedStepCount = timeline.rejectedStepCount;
      session.matchedStepCount = timeline.matchedStepCount;
      session.diagnostics.push(...timeline.diagnostics);
      session.steps = parameterizeTrajectory(
        timeline.steps,
        session.parameterSchema,
        session.runtimeParameters,
      );
      session.status = 'stopped';
      session.inputProcess = null;

      await session.actionContextQueue;
      await captureDeviceContext(session, this.device, 'recording-stop', {
        parameterSchema: session.parameterSchema,
        parameters: session.runtimeParameters,
      });
      session.actionContextCount = session.contexts.filter(
        (context) => Number.isInteger(context.actionIndex),
      ).length;
      const recordingQuality = assessRecordingQuality(session, timeline);
      session.recordingQuality = recordingQuality.level;
      session.qualityScore = recordingQuality.score;
      session.qualityIssues = recordingQuality.issues;
      await this.#writeArtifacts(session);
    } finally {
      if (this.activeId === id) this.activeId = null;
      if (session.deviceLock && typeof this.device.endSession === 'function') {
        await this.device.endSession(session.deviceLock).catch((error) => {
          session.diagnostics.push(`释放录制设备锁失败: ${error.message}`);
        });
        session.deviceLock = null;
      }
    }
    return this.snapshot(id);
  }

  async repair(id, { apiKey } = {}) {
    const session = this.#get(id);
    if (['recording', 'starting', 'stopping', 'replaying'].includes(session.status)) {
      throw new Error('录制或回放尚未结束，不能进行模型纠正');
    }
    if (!session.steps.length) throw new Error('轨迹为空，不能进行模型纠正');
    if (session.correctionStatus === 'repairing') throw new Error('模型纠正正在进行');
    if (this.activeId && this.activeId !== id) throw new Error('已有录制或回放任务正在运行');

    this.activeId = id;
    session.correctionStatus = 'repairing';
    session.correctionError = null;
    try {
      const result = await this.trajectoryRepair({
        trajectory: {
          id: session.id,
          appId: session.appId,
          appName: session.appName,
          featureName: session.featureName,
          provider: session.provider,
          screen: session.screen,
          steps: session.steps,
          contexts: session.contexts.map(summarizeContext),
        },
        apiKey,
      });
      session.correctedSteps = result.steps;
      session.correctionSource = 'model_repaired';
      session.correctionChanges = result.changes;
      session.correctionConfidence = result.confidence;
      session.correctionStatus = 'completed';
      await this.#writeCorrectedArtifact(session);
    } catch (error) {
      session.correctionStatus = 'failed';
      session.correctionError = error.message;
      throw error;
    } finally {
      if (this.activeId === id) this.activeId = null;
    }

    return this.snapshot(id);
  }

  async replay(
    id,
    {
      speed = 1,
      source = 'auto',
      parameters = {},
      validationDurationMs = null,
    } = {},
  ) {
    const session = this.#get(id);
    if (session.status === 'recording' || session.status === 'starting' || session.status === 'stopping') {
      throw new Error('录制尚未结束，不能回放');
    }
    const useCorrected = source !== 'raw' && session.correctedSteps?.length;
    const replaySteps = useCorrected ? session.correctedSteps : session.steps;
    if (!replaySteps.length) throw new Error('轨迹为空，不能回放');
    if (this.activeId && this.activeId !== id) throw new Error('已有录制或回放任务正在运行');

    const replaySpeed = clampNumber(speed, 0.1, 10, 1);
    const replayParameters = { ...session.runtimeParameters, ...parameters };
    const executionParameters = applyReplayValidationOverrides(
      replayParameters,
      session.parameterSchema,
      validationDurationMs,
      session.workflowId,
    );
    session.runtimeParameters = clone(replayParameters);
    session.parameters = sanitizeParameters(session.parameterSchema, replayParameters);
    this.activeId = id;
    session.status = 'replaying';
    session.replaySource = useCorrected ? 'corrected' : 'raw';
    session.replayStartedAt = this.now().toISOString();
    session.replayFinishedAt = null;
    session.replayStepIndex = 0;
    session.validationMode = null;
    session.validationChecks = [];
    session.effectiveDurationMs = null;
    session.error = null;
    let replayDeviceLock = null;

    try {
      if (typeof this.device.beginSession === 'function') {
        replayDeviceLock = await this.device.beginSession({
          owner: `replay:${session.id}`,
        });
      }
      const screen =
        replayDeviceLock?.screen ||
        (await this.device.getScreenSize?.().catch(() => null));
      if (session.workflowId === TENCENT_QUICK_MEETING_WORKFLOW_ID) {
        const app = this.apps.find((candidate) => candidate.id === session.appId);
        const result = await this.quickMeetingExecutor({
          device: this.device,
          app,
          parameters: executionParameters,
          recordedSteps: replaySteps,
          sourceScreen: session.screen,
          executeStep: (step, options = {}) =>
            replayStep(this.device, step, {
              sourceScreen: session.screen,
              targetScreen: options.targetScreen || screen,
              parameters: executionParameters,
            }),
          onStep: (stepIndex) => {
            session.replayStepIndex = stepIndex;
          },
        });
        session.validationMode = result.validationMode;
        session.validationChecks = result.validationChecks || [];
        session.effectiveDurationMs = result.effectiveDurationMs ?? null;
        session.replayStepIndex = result.replayStepIndex || session.replayStepIndex;
      } else if (session.workflowId === WECHAT_MEDIA_WORKFLOW_ID) {
        const app = this.apps.find((candidate) => candidate.id === session.appId);
        const result = await this.wechatMediaExecutor({
          device: this.device,
          app,
          parameters: executionParameters,
          recordedSteps: replaySteps,
          sourceScreen: session.screen,
          onStep: (stepIndex) => {
            session.replayStepIndex = stepIndex;
          },
        });
        session.validationMode = result.validationMode;
        session.validationChecks = result.validationChecks || [];
        session.effectiveDurationMs = result.effectiveDurationMs ?? null;
        session.replayStepIndex = result.replayStepIndex || session.replayStepIndex;
        session.replaySource = result.replaySource || session.replaySource;
        if (result.correctedSteps?.length) {
          session.correctedSteps = clone(result.correctedSteps);
          session.correctionStatus = 'completed';
          session.correctionSource = 'workflow_skill_repaired';
          session.correctionChanges = clone(result.correctionChanges || []);
          session.correctionConfidence = result.correctionConfidence ?? null;
          session.correctionError = null;
        }
      } else {
        for (const [index, step] of replaySteps.entries()) {
          const delayMs = Math.min(MAX_REPLAY_DELAY_MS, Math.max(0, Number(step.delayMs) || 0));
          if (delayMs > 0) await sleep(delayMs / replaySpeed);
          await replayStep(this.device, step, {
            sourceScreen: session.screen,
            targetScreen: screen,
            parameters: executionParameters,
          });
          session.replayStepIndex = index + 1;
        }
        session.validationMode = 'trajectory_completed_v1';
        session.validationChecks = [
          {
            id: 'trajectory_completed',
            label: '动作轨迹回放',
            status: 'passed',
            detail: `${replaySteps.length} 步`,
          },
        ];
      }

      if (!allValidationChecksPassed(session.validationChecks)) {
        throw new Error('回放完成，但业务状态验证未全部通过');
      }
      session.status = 'replayed';
      session.validationStatus = 'verified';
      session.validatedAt = this.now().toISOString();
      session.validationError = null;
      session.replayFinishedAt = this.now().toISOString();
      await captureDeviceContext(session, this.device, 'replay-success', {
        parameterSchema: session.parameterSchema,
        parameters: replayParameters,
      });
    } catch (error) {
      session.validationMode = error.validationMode || session.validationMode;
      session.validationChecks =
        error.validationChecks?.length
          ? error.validationChecks
          : session.validationChecks.length
            ? session.validationChecks
            : [
                {
                  id: 'replay_error',
                  label: '动作轨迹回放',
                  status: 'failed',
                  detail: error.message,
                },
              ];
      session.effectiveDurationMs =
        error.effectiveDurationMs ?? session.effectiveDurationMs;
      session.replayStepIndex =
        error.replayStepIndex ?? session.replayStepIndex;
      session.status = 'replay_failed';
      session.validationStatus = 'unverified';
      session.validatedAt = null;
      session.validationError = error.message;
      session.error = error.message;
      session.replayFinishedAt = this.now().toISOString();
      await captureDeviceContext(session, this.device, 'replay-failure', {
        parameterSchema: session.parameterSchema,
        parameters: replayParameters,
      });
    } finally {
      if (replayDeviceLock && typeof this.device.endSession === 'function') {
        await this.device.endSession(replayDeviceLock).catch((error) => {
          session.diagnostics.push(`释放回放设备锁失败: ${error.message}`);
        });
      }
      if (this.activeId === id) this.activeId = null;
    }

    await this.#writeValidationArtifacts(session);
    return this.snapshot(id);
  }

  async loadFromDisk() {
    const trajectoryFiles = await findTrajectoryFiles(resolve(this.recordingsRoot));
    let loaded = 0;
    let downgraded = 0;

    for (const trajectoryFile of trajectoryFiles) {
      let metadata;
      try {
        metadata = JSON.parse(await readFile(trajectoryFile, 'utf8'));
      } catch {
        continue;
      }
      if (!metadata?.id || !metadata?.appId || !Array.isArray(metadata.steps)) {
        continue;
      }

      const workflow = metadata.workflowId
        ? findWorkflow(this.workflows, metadata.workflowId)
        : null;
      const app = this.apps.find((candidate) => candidate.id === metadata.appId);
      const outputDir = dirname(trajectoryFile);
      const parameterSchema = metadata.params || workflow?.params || [];
      const strictTencentValidation =
        metadata.validationMode === 'tencent_quick_meeting_v1' &&
        allValidationChecksPassed(metadata.validationChecks);
      const strictWechatMediaValidation =
        metadata.validationMode === WECHAT_MEDIA_VALIDATION_MODE &&
        allValidationChecksPassed(metadata.validationChecks);
      const requiresStrictValidation =
        metadata.workflowId === TENCENT_QUICK_MEETING_WORKFLOW_ID ||
        metadata.workflowId === WECHAT_MEDIA_WORKFLOW_ID;
      const hasStrictValidation =
        metadata.workflowId === TENCENT_QUICK_MEETING_WORKFLOW_ID
          ? strictTencentValidation
          : metadata.workflowId === WECHAT_MEDIA_WORKFLOW_ID
            ? strictWechatMediaValidation
            : true;
      const downgradeStrictValidation =
        requiresStrictValidation &&
        metadata.validationStatus === 'verified' &&
        !hasStrictValidation;
      const validationStatus = downgradeStrictValidation
        ? 'unverified'
        : metadata.validationStatus || 'unverified';

      const session = {
        id: metadata.id,
        appId: metadata.appId,
        appName: metadata.appName || app?.name || metadata.appId,
        workflowId: metadata.workflowId || null,
        workflowName: workflow?.featureName || metadata.workflowName || null,
        featureName:
          workflow?.featureName ||
          metadata.featureName ||
          metadata.workflowName ||
          '未命名功能',
        recordingKey:
          metadata.recordingKey ||
          metadata.workflowId ||
          `${metadata.appId}:${metadata.featureName || '未命名功能'}`,
        parameterSchema,
        parameters: clone(metadata.parameters),
        runtimeParameters: restoreRuntimeParameters(
          parameterSchema,
          metadata.parameters,
        ),
        validationStatus,
        validationMode: downgradeStrictValidation
          ? null
          : metadata.validationMode || null,
        validationChecks: downgradeStrictValidation
          ? []
          : clone(metadata.validationChecks || []),
        validatedAt: downgradeStrictValidation
          ? null
          : metadata.validatedAt || null,
        validationError: downgradeStrictValidation
          ? metadata.workflowId === WECHAT_MEDIA_WORKFLOW_ID
            ? '旧版微信媒体录制缺少严格业务状态验证，请重新回放验证'
            : '旧版腾讯会议录制缺少严格业务状态验证，请重新回放验证'
          : metadata.validationError || null,
        effectiveDurationMs: metadata.effectiveDurationMs ?? null,
        status: validationStatus === 'verified' ? 'replayed' : 'stopped',
        provider: metadata.provider || '',
        serial: metadata.serial || '',
        screen: metadata.screen || null,
        outputDir,
        trajectoryFile,
        skillFile: join(outputDir, 'skill-draft.json'),
        contextFile: join(outputDir, 'contexts.json'),
        rawLiveFile: metadata.rawLiveFile || join(outputDir, 'raw-live.jsonl'),
        rawRemoteFile: metadata.rawRemoteFile || join(outputDir, 'raw-remote.log'),
        startedAt: metadata.startedAt || '',
        stoppedAt: metadata.stoppedAt || null,
        replayStartedAt: metadata.replayStartedAt || null,
        replayFinishedAt: metadata.replayFinishedAt || null,
        replayStepIndex: Number(metadata.replayStepIndex) || 0,
        replaySource: metadata.replaySource || null,
        steps: clone(metadata.steps),
        correctedSteps: [],
        correctedSkillFile: null,
        correctionStatus: null,
        correctionSource: null,
        correctionChanges: [],
        correctionConfidence: null,
        correctionError: null,
        diagnostics: [],
        contexts: [],
        screenshots: clone(metadata.screenshots || {}),
        timelineSource: metadata.timelineSource || null,
        timelineQuality: metadata.timelineQuality || null,
        recordingQuality: metadata.recordingQuality || null,
        qualityScore: Number.isFinite(metadata.qualityScore) ? metadata.qualityScore : null,
        qualityIssues: clone(metadata.qualityIssues || []),
        remoteStepCount: Number(metadata.remoteStepCount) || 0,
        streamStepCount: Number(metadata.streamStepCount) || 0,
        mergedStepCount: Number(metadata.mergedStepCount) || metadata.steps.length,
        rejectedStepCount: Number(metadata.rejectedStepCount) || 0,
        matchedStepCount: Number(metadata.matchedStepCount) || 0,
        actionContextCount: Number(metadata.actionContextCount) || 0,
        liveActionEventCount: Number(metadata.liveActionEventCount) || 0,
        error: null,
        inputProcess: null,
        outputLines: [],
        liveCandidates: [],
        rawLiveWriteQueue: Promise.resolve(),
        rawLiveWriteFailed: false,
        actionContextQueue: Promise.resolve(),
        flushOutput: null,
      };

      const correctedSkillFile = join(outputDir, 'skill-corrected.json');
      try {
        const contextData = JSON.parse(
          await readFile(session.contextFile, 'utf8'),
        );
        if (Array.isArray(contextData.contexts)) {
          session.contexts = contextData.contexts;
        }
      } catch {
        // Recording context was introduced after the original trajectory format.
      }
      try {
        const corrected = JSON.parse(
          await readFile(correctedSkillFile, 'utf8'),
        );
        if (Array.isArray(corrected.steps) && corrected.steps.length) {
          session.correctedSteps = corrected.steps;
          session.correctedSkillFile = correctedSkillFile;
          session.correctionStatus = 'completed';
          session.correctionSource = corrected.source || 'model_repaired';
          session.correctionChanges = corrected.changes || [];
          session.correctionConfidence = corrected.confidence ?? null;
        }
      } catch {
        // Corrected trajectories are optional.
      }

      this.sessions.set(session.id, session);
      loaded += 1;
      if (downgradeStrictValidation) {
        downgraded += 1;
        await this.#writeValidationArtifacts(session);
      }
    }

    return { loaded, downgraded };
  }

  getVerifiedWorkflowIds() {
    return new Set(
      [...this.sessions.values()]
        .filter((session) => session.validationStatus === 'verified')
        .map((session) => session.workflowId)
        .filter(Boolean),
    );
  }

  list() {
    return [...this.sessions.values()]
      .sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)))
      .map((session) => this.snapshot(session.id));
  }

  snapshot(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    const {
      inputProcess,
      outputLines,
      readUiRecording,
      runtimeParameters,
      contexts,
      liveCandidates,
      rawLiveWriteQueue,
      rawLiveWriteFailed,
      actionContextQueue,
      flushOutput,
      ...rest
    } = session;
    return {
      ...rest,
      stepCount: session.steps.length,
      correctedStepCount: session.correctedSteps?.length || 0,
      contextCount: session.contexts.length,
      active: this.activeId === id,
    };
  }

  #get(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`录制任务不存在: ${id}`);
    return session;
  }

  async #releaseStaleActiveSession() {
    if (this.activeId) {
      const session = this.sessions.get(this.activeId);
      const stillActive =
        session &&
        (['starting', 'recording', 'stopping', 'replaying'].includes(session.status) ||
          session.correctionStatus === 'repairing');
      if (stillActive) return;
      this.activeId = null;
    }

    if (
      typeof this.device.getActiveSession !== 'function' ||
      typeof this.device.endSession !== 'function'
    ) {
      return;
    }

    const deviceSession = await this.device.getActiveSession();
    const ownerMatch = String(deviceSession?.owner || '').match(/^(recording|replay):(.+)$/);
    if (!ownerMatch) return;

    const [, mode, recordingId] = ownerMatch;
    const session = this.sessions.get(recordingId);
    const stillActive =
      mode === 'recording'
        ? ['starting', 'recording', 'stopping'].includes(session?.status)
        : session?.status === 'replaying';
    if (!stillActive) await this.device.endSession(deviceSession);
  }

  async #discardUnverifiedSessions(sessionToKeep) {
    const staleSessions = [...this.sessions.values()].filter(
      (session) =>
        session.id !== sessionToKeep.id &&
        session.recordingKey === sessionToKeep.recordingKey &&
        session.validationStatus !== 'verified',
    );

    for (const session of staleSessions) {
      await rm(session.outputDir, { recursive: true, force: true });
      this.sessions.delete(session.id);
    }

    const featureDir = join(
      resolve(this.recordingsRoot),
      safeSegment(sessionToKeep.appName),
      safeSegment(sessionToKeep.featureName),
    );
    let entries = [];
    try {
      entries = await readdir(featureDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidateDir = join(featureDir, entry.name);
      if (resolve(candidateDir) === resolve(sessionToKeep.outputDir)) continue;

      let metadata = null;
      try {
        metadata = JSON.parse(await readFile(join(candidateDir, 'trajectory.json'), 'utf8'));
      } catch {
        // An incomplete directory from a failed start is also replaceable.
      }

      const sameWorkflow =
        metadata?.recordingKey === sessionToKeep.recordingKey ||
        (!metadata?.recordingKey && metadata?.appId === sessionToKeep.appId);
      if (sameWorkflow && metadata?.validationStatus !== 'verified') {
        await rm(candidateDir, { recursive: true, force: true });
      }
    }
  }

  async #writeValidationArtifacts(session) {
    await this.#writeArtifacts(session);
    if (session.correctedSteps?.length) {
      await this.#writeCorrectedArtifact(session);
    }
  }

  async #writeArtifacts(session) {
    const metadata = {
      version: 4,
      id: session.id,
      appId: session.appId,
      appName: session.appName,
      featureName: session.featureName,
      workflowId: session.workflowId,
      workflowName: session.workflowName,
      params: session.parameterSchema,
      recordingKey: session.recordingKey,
      provider: session.provider,
      serial: session.serial,
      screen: session.screen,
      parameters: session.parameters,
      validationStatus: session.validationStatus,
      validationMode: session.validationMode,
      validationChecks: session.validationChecks,
      validatedAt: session.validatedAt,
      validationError: session.validationError,
      effectiveDurationMs: session.effectiveDurationMs,
      startedAt: session.startedAt,
      stoppedAt: session.stoppedAt,
      replayStartedAt: session.replayStartedAt,
      replayFinishedAt: session.replayFinishedAt,
      replayStepIndex: session.replayStepIndex,
      replaySource: session.replaySource,
      timelineSource: session.timelineSource,
      timelineQuality: session.timelineQuality,
      recordingQuality: session.recordingQuality,
      qualityScore: session.qualityScore,
      qualityIssues: session.qualityIssues,
      remoteStepCount: session.remoteStepCount,
      streamStepCount: session.streamStepCount,
      mergedStepCount: session.mergedStepCount,
      rejectedStepCount: session.rejectedStepCount,
      matchedStepCount: session.matchedStepCount,
      actionContextCount: session.actionContextCount,
      liveActionEventCount: session.liveActionEventCount,
      rawLiveFile: session.rawLiveFile,
      rawRemoteFile: session.rawRemoteFile,
      contextFile: session.contextFile,
      screenshots: session.screenshots,
      steps: session.steps,
    };
    await writeFile(session.trajectoryFile, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    if (session.contexts.length) {
      await writeFile(
        session.contextFile,
        `${JSON.stringify(
          {
            version: 2,
            recordingId: session.id,
            contexts: session.contexts,
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    }
    await writeFile(
      session.skillFile,
      `${JSON.stringify(
        {
          version: 4,
          name: session.featureName,
          appId: session.appId,
          appName: session.appName,
          source: 'manual_recording',
          workflowId: session.workflowId,
          params: session.parameterSchema,
          parameters: session.parameters,
          validationStatus: session.validationStatus,
          validationMode: session.validationMode,
          validationChecks: session.validationChecks,
          validatedAt: session.validatedAt,
          validationError: session.validationError,
          effectiveDurationMs: session.effectiveDurationMs,
          recordingQuality: session.recordingQuality,
          qualityScore: session.qualityScore,
          qualityIssues: session.qualityIssues,
          steps: session.steps,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  async #writeCorrectedArtifact(session) {
    const correctedSkillFile = join(session.outputDir, 'skill-corrected.json');
    session.correctedSkillFile = correctedSkillFile;
    await writeFile(
      correctedSkillFile,
      `${JSON.stringify(
        {
          version: 3,
          name: session.featureName,
          appId: session.appId,
          appName: session.appName,
          source: session.correctionSource || 'model_repaired',
          workflowId: session.workflowId,
          params: session.parameterSchema,
          parameters: session.parameters,
          validationStatus: session.validationStatus,
          validationMode: session.validationMode,
          validationChecks: session.validationChecks,
          validatedAt: session.validatedAt,
          validationError: session.validationError,
          effectiveDurationMs: session.effectiveDurationMs,
          confidence: session.correctionConfidence,
          changes: session.correctionChanges,
          steps: session.correctedSteps,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }
}

export function parseRecordedTrajectory(rawOutput, { receivedLines = [] } = {}) {
  const candidates = [];
  const lines = String(rawOutput || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (receivedLines.length > 0) {
    for (const entry of receivedLines) {
      const line = String(entry?.line || '').trim();
      if (!line) continue;
      const receivedAt = Number(entry.at) || null;
      parseJsonLine(line, candidates, receivedAt);
      parseUiRecordLine(line, candidates, receivedAt);
      parseGeteventLine(line, candidates, receivedAt);
    }
  } else {
    for (const line of lines) {
      parseJsonLine(line, candidates);
      parseUiRecordLine(line, candidates);
    }
  }

  return normalizeCandidates(candidates);
}

export function selectRecordedTrajectory({
  remoteOutput = '',
  receivedLines = [],
  recordingDurationMs = 0,
  screen = null,
} = {}) {
  const remoteSteps = parseRecordedTrajectory(remoteOutput);
  const streamSteps = parseRecordedTrajectory('', { receivedLines });
  const liveTimingMarkers = parseLiveActionTimingMarkers(receivedLines);
  const streamStepCount = Math.max(streamSteps.length, liveTimingMarkers.length);
  const diagnostics = [];
  let steps = [];
  let source = 'none';
  let matchedStepCount = 0;

  if (remoteSteps.length && streamSteps.length) {
    const merged = mergeRecordedTrajectories(remoteSteps, streamSteps);
    steps = merged.steps;
    matchedStepCount = merged.matchedStepCount;
    source =
      merged.matchedStepCount === remoteSteps.length &&
      merged.matchedStepCount === streamSteps.length
        ? hasCompleteRecordedTiming(steps)
          ? 'remote+live-timestamps'
          : 'remote+live'
        : 'remote+live-merged';
    if (source === 'remote+live-merged') {
      diagnostics.push(
        `Merged remote/live recording streams: ${remoteSteps.length}/${streamSteps.length} steps, ${matchedStepCount} aligned.`,
      );
    }
  } else if (remoteSteps.length && liveTimingMarkers.length) {
    const timed = applyLiveTimingMarkers(remoteSteps, liveTimingMarkers);
    steps = timed.steps;
    matchedStepCount = timed.matchedStepCount;
    source =
      matchedStepCount === remoteSteps.length &&
      matchedStepCount === liveTimingMarkers.length
        ? 'remote+live-timestamps'
        : 'remote+live-markers';
    if (source === 'remote+live-markers') {
      diagnostics.push(
        `Aligned ${matchedStepCount}/${remoteSteps.length} remote actions with ${liveTimingMarkers.length} live action markers.`,
      );
    }
  } else if (remoteSteps.length) {
    steps = remoteSteps;
    source = 'remote';
  } else if (streamSteps.length) {
    steps = streamSteps;
    source = 'live';
  }

  const mergedStepCount = steps.length;
  const coordinateValidation = validateTrajectoryCoordinates(steps, screen);
  steps = coordinateValidation.steps;
  diagnostics.push(...coordinateValidation.diagnostics);

  let quality = getTimelineQuality(steps);
  if (
    steps.length > 1 &&
    quality !== 'exact' &&
    Number(recordingDurationMs) >= 1500
  ) {
    steps = steps.map((step, index) =>
      index === 0 || Number(step.delayMs) > 0
        ? step
        : { ...step, delayMs: FALLBACK_STEP_DELAY_MS },
    );
    quality = 'approximate';
    diagnostics.push(
      `设备录制未返回动作时间戳，已用 ${FALLBACK_STEP_DELAY_MS}ms 回放等待补齐缺失时间。`,
    );
  }

  return {
    steps,
    source,
    quality,
    diagnostics,
    remoteStepCount: remoteSteps.length,
    streamStepCount,
    mergedStepCount,
    rejectedStepCount: coordinateValidation.rejected.length,
    rejectedSteps: coordinateValidation.rejected,
    matchedStepCount,
  };
}

async function replayStep(device, step, { sourceScreen, targetScreen, parameters = {} }) {
  const scale = getScreenScale(sourceScreen, targetScreen);
  const target = buildReplayTarget(step.context);
  if (step.type === 'tap') {
    await device.tap({
      x: scaleCoordinate(step.x, scale.x),
      y: scaleCoordinate(step.y, scale.y),
      ...(target ? { target } : {}),
    });
    return;
  }
  if (step.type === 'long_press') {
    if (typeof device.longPress !== 'function') {
      throw new Error('当前设备适配器不支持长按回放');
    }
    await device.longPress({
      x: scaleCoordinate(step.x, scale.x),
      y: scaleCoordinate(step.y, scale.y),
      durationMs: step.durationMs,
      ...(target ? { target } : {}),
    });
    return;
  }
  if (step.type === 'swipe') {
    await device.swipe({
      x1: scaleCoordinate(step.x1, scale.x),
      y1: scaleCoordinate(step.y1, scale.y),
      x2: scaleCoordinate(step.x2, scale.x),
      y2: scaleCoordinate(step.y2, scale.y),
      durationMs: step.durationMs,
    });
    return;
  }
  if (step.type === 'keyevent') {
    await device.keyevent(step.code);
    return;
  }
  if (step.type === 'input_text') {
    if (typeof device.inputText !== 'function') throw new Error('当前设备适配器不支持文本输入回放');
    await device.inputText(resolveParameterTemplate(step.text, parameters));
    return;
  }
  throw new Error(`不支持回放的动作类型: ${step.type}`);
}

function buildReplayTarget(context) {
  const widget = context?.widget;
  if (!widget || typeof widget !== 'object') return null;
  const id = String(widget.id || '').trim();
  if (id && !/^\d+$/.test(id)) {
    return { id };
  }

  const text = String(widget.text || '').trim();
  if (!text || text.length > 80) return null;
  return {
    texts: [text],
    partial: false,
  };
}

function parseJsonLine(line, candidates, inheritedAtMs = null) {
  if (!line.startsWith('{') && !line.startsWith('[')) return;
  try {
    collectJsonEvents(JSON.parse(line), candidates, inheritedAtMs);
  } catch {
    // Some uiRecord versions print a non-JSON prefix before the event.
  }
}

function collectJsonEvents(value, candidates, inheritedAtMs = null) {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonEvents(item, candidates, inheritedAtMs);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const eventTime = findTimeMs(value) ?? inheritedAtMs;
  for (const key of ['events', 'actions', 'records', 'steps', 'data']) {
    if (Array.isArray(value[key])) {
      collectJsonEvents(value[key], candidates, eventTime);
    }
  }

  const step = objectToCandidate(value, eventTime);
  if (step) candidates.push(step);
}

function objectToCandidate(value, atMs) {
  const finger = Array.isArray(value.fingerList) ? value.fingerList[0] : null;
  const type = String(
    value.type ??
      value.action ??
      value.operation ??
      value.event ??
      value.name ??
      value.OP_TYPE ??
      value.opType ??
      '',
  ).toLowerCase();
  const x = numberFrom(value.x ?? value.pointX ?? value.startX ?? value.X_POSI ?? finger?.X_POSI);
  const y = numberFrom(value.y ?? value.pointY ?? value.startY ?? value.Y_POSI ?? finger?.Y_POSI);
  const x2 = numberFrom(
    value.x2 ?? value.endX ?? value.toX ?? value.X2_POSI ?? finger?.X2_POSI ?? x,
  );
  const y2 = numberFrom(
    value.y2 ?? value.endY ?? value.toY ?? value.Y2_POSI ?? finger?.Y2_POSI ?? y,
  );
  const context = extractActionContext(value);

  if (/(swipe|drag|fling)/.test(type) && [x, y, x2, y2].every(Number.isFinite)) {
    return withActionContext({
      type: 'swipe',
      x1: x,
      y1: y,
      x2,
      y2,
      durationMs: normalizeGestureDuration(
        value.durationMs ?? value.duration ?? value.velocity ?? finger?.duration,
      ),
      atMs,
    }, context);
  }
  if (/(longclick|long_click|long-press|longpress)/.test(type) && [x, y].every(Number.isFinite)) {
    return withActionContext({
      type: 'long_press',
      x,
      y,
      durationMs: normalizeLongPressDuration(value.durationMs ?? value.duration),
      atMs,
    }, context);
  }
  if (/(click|tap|double-click)/.test(type) && [x, y].every(Number.isFinite)) {
    return withActionContext({ type: 'tap', x, y, atMs }, context);
  }
  if (/(inputtext|input_text|input-text)/.test(type)) {
    const text = value.text ?? value.inputText ?? value.content ?? value.value;
    if (text !== undefined && text !== null) {
      return withActionContext(
        { type: 'input_text', text: String(text), atMs },
        context,
      );
    }
  }
  if (/(key|back|home|enter|power)/.test(type)) {
    const code = String(value.code ?? value.keyCode ?? value.key ?? value.value ?? '').trim();
    if (code) {
      return withActionContext(
        { type: 'keyevent', code: normalizeKeyCode(code), atMs },
        context,
      );
    }
  }
  return null;
}

function parseUiRecordLine(line, candidates, receivedAt = null) {
  if (/EV_(?:ABS|KEY|SYN)\b/i.test(line)) return;
  if (line.startsWith('{') || line.startsWith('[')) {
    return;
  }
  const jsonStart = line.indexOf('{');
  if (jsonStart > 0) {
    const candidateCount = candidates.length;
    parseJsonLine(line.slice(jsonStart), candidates, receivedAt);
    if (candidates.length > candidateCount) return;
  }

  const lower = line.toLowerCase();
  const atMs = findLineTimeMs(line) ?? receivedAt;

  const swipeMatch = line.match(/(swipe|drag|fling|滑动)/i);
  const swipeNumbers = swipeMatch
    ? extractNumbers(line.slice(swipeMatch.index + swipeMatch[0].length))
    : [];
  if (swipeMatch && swipeNumbers.length >= 4) {
    const [x1, y1, x2, y2] = swipeNumbers;
    const durationMs = swipeNumbers[4] || 300;
    candidates.push({
      type: 'swipe',
      x1,
      y1,
      x2,
      y2,
      durationMs: durationMs > 40000 ? 300 : durationMs,
      atMs,
    });
    return;
  }

  const numbers = extractNumbers(line);
  if (/(longclick|long_click|long-press|longpress|长按)/i.test(lower) && numbers.length >= 2) {
    const [x, y] = numbers.slice(-2);
    candidates.push({
      type: 'long_press',
      x,
      y,
      durationMs: 800,
      atMs,
    });
    return;
  }

  if (/(click|tap|点击)/i.test(lower) && numbers.length >= 2) {
    const [x, y] = numbers.slice(-2);
    candidates.push({ type: 'tap', x, y, atMs });
    return;
  }

  if (/(keyevent|key event|按键)/i.test(lower)) {
    const match = line.match(/(?:keyevent|key\s*event|按键)\s*[:=]?\s*([A-Za-z0-9_]+)/i);
    const code = match?.[1] || line.match(/\b(KEYCODE_[A-Z0-9_]+|Back|Home|Enter|Power)\b/i)?.[1];
    if (code) candidates.push({ type: 'keyevent', code: normalizeKeyCode(code), atMs });
  }
}

function parseGeteventLine(line, candidates, receivedAt) {
  if (!/EV_(?:ABS|KEY|SYN)\b/i.test(line)) return;

  const eventTime = findLineTimeMs(line) ?? receivedAt;
  const state = parseGeteventState(candidates);
  const absMatch = line.match(/\b(EV_ABS)\s+([A-Z0-9_]+)\s+([0-9a-fx-]+)\b/i);
  const keyMatch = line.match(/\bEV_KEY\s+([A-Z0-9_]+)\s+([0-9a-fx-]+)\b/i);

  if (absMatch) {
    const code = absMatch[2].toUpperCase();
    const value = parseInputValue(absMatch[3]);
    if (code.includes('POSITION_X') || code === 'ABS_X') state.x = value;
    if (code.includes('POSITION_Y') || code === 'ABS_Y') state.y = value;
    if (code.includes('TRACKING_ID') && value < 0) finishTouch(state, eventTime);
    if (code.includes('TRACKING_ID') && value >= 0) startTouch(state, eventTime);
    if (state.down && Number.isFinite(state.x) && Number.isFinite(state.y)) {
      state.lastX = state.x;
      state.lastY = state.y;
    }
    return;
  }

  if (keyMatch && keyMatch[1].toUpperCase() === 'BTN_TOUCH') {
    const value = parseInputValue(keyMatch[2]);
    if (value > 0) startTouch(state, eventTime);
    else finishTouch(state, eventTime);
    return;
  }

  if (/\bEV_SYN\b/i.test(line) && state.down && Number.isFinite(state.x) && Number.isFinite(state.y)) {
    state.points.push({ x: state.x, y: state.y, atMs: eventTime });
  }
}

function parseGeteventState(candidates) {
  if (!candidates._touchState) {
    Object.defineProperty(candidates, '_touchState', {
      value: {
        down: false,
        points: [],
        x: null,
        y: null,
        lastX: null,
        lastY: null,
        startedAt: null,
        target: candidates,
      },
      enumerable: false,
    });
  }
  return candidates._touchState;
}

function startTouch(state, atMs) {
  if (state.down) return;
  state.down = true;
  state.startedAt = atMs;
  state.points = [];
}

function finishTouch(state, atMs) {
  if (!state.down) return;
  const points = state.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const first = points[0] || { x: state.x, y: state.y, atMs: state.startedAt };
  const last = points.at(-1) || { x: state.x, y: state.y, atMs };
  if (!Number.isFinite(first.x) || !Number.isFinite(first.y) || !Number.isFinite(last.x) || !Number.isFinite(last.y)) {
    resetTouch(state);
    return;
  }

  const distance = Math.hypot(last.x - first.x, last.y - first.y);
  if (distance >= 24) {
    state.target.push({
      type: 'swipe',
      x1: first.x,
      y1: first.y,
      x2: last.x,
      y2: last.y,
      durationMs: Math.max(50, (Number(atMs) || 0) - (Number(state.startedAt) || 0)),
      atMs: state.startedAt,
    });
  } else {
    state.target.push({ type: 'tap', x: first.x, y: first.y, atMs: state.startedAt });
  }
  resetTouch(state);
}

function resetTouch(state) {
  state.down = false;
  state.points = [];
  state.startedAt = null;
}

function parseLiveActionTimingMarkers(receivedLines) {
  const markers = [];
  for (const entry of receivedLines || []) {
    const marker = liveActionMarkerFromLine(entry?.line);
    if (!marker) continue;
    markers.push({
      ...marker,
      atMs: Number(entry?.at) || null,
    });
  }
  if (!markers.length) return [];

  const firstTime = markers.find((marker) => Number.isFinite(marker.atMs))?.atMs;
  let previousElapsed = 0;
  return markers.map((marker) => {
    const elapsedMs =
      Number.isFinite(marker.atMs) && Number.isFinite(firstTime)
        ? Math.max(0, marker.atMs - firstTime)
        : previousElapsed;
    const normalized = {
      type: marker.type,
      delayMs: Math.max(0, Math.round(elapsedMs - previousElapsed)),
    };
    previousElapsed = elapsedMs;
    return normalized;
  });
}

function liveActionMarkerFromLine(line) {
  const match = String(line || '')
    .trim()
    .match(
      /^(longclick|long_click|long-press|longpress|doubleclick|double-click|click|tap|swipe|fling|drag|inputtext|input_text)\b/i,
    );
  if (!match) return null;
  const operation = match[1].toLowerCase();
  if (/^(swipe|fling|drag)$/.test(operation)) return { type: 'swipe' };
  if (/^long/.test(operation)) return { type: 'long_press' };
  if (/^input/.test(operation)) return { type: 'input_text' };
  return { type: 'tap' };
}

function applyLiveTimingMarkers(steps, markers) {
  const timedSteps = steps.map((step) => ({ ...step }));
  let stepIndex = 0;
  let matchedStepCount = 0;
  for (const marker of markers) {
    while (
      stepIndex < timedSteps.length &&
      !areCompatibleActionTypes(timedSteps[stepIndex].type, marker.type)
    ) {
      stepIndex += 1;
    }
    if (stepIndex >= timedSteps.length) break;
    timedSteps[stepIndex].delayMs =
      Number(marker.delayMs) > 0
        ? Number(marker.delayMs)
        : Number(timedSteps[stepIndex].delayMs) || 0;
    stepIndex += 1;
    matchedStepCount += 1;
  }
  return { steps: timedSteps, matchedStepCount };
}

function areCompatibleActionTypes(leftType, rightType) {
  if (leftType === rightType) return true;
  return (
    new Set(['tap', 'long_press']).has(leftType) &&
    new Set(['tap', 'long_press']).has(rightType)
  );
}

function mergeRecordedTrajectories(remoteSteps, streamSteps) {
  const matches = alignTrajectorySteps(remoteSteps, streamSteps);
  const remoteIsBase =
    remoteSteps.length > streamSteps.length ||
    (remoteSteps.length === streamSteps.length &&
      trajectoryQualityScore(remoteSteps) >= trajectoryQualityScore(streamSteps));
  const base = remoteIsBase ? remoteSteps : streamSteps;
  const auxiliary = remoteIsBase ? streamSteps : remoteSteps;
  const matchByBaseIndex = new Map(
    matches.map((match) => [
      remoteIsBase ? match.remoteIndex : match.streamIndex,
      remoteIsBase ? match.streamIndex : match.remoteIndex,
    ]),
  );
  const steps = [];
  let auxiliaryCursor = 0;

  for (let baseIndex = 0; baseIndex < base.length; baseIndex += 1) {
    const auxiliaryIndex = matchByBaseIndex.get(baseIndex);
    if (auxiliaryIndex === undefined) {
      steps.push(base[baseIndex]);
      continue;
    }
    while (auxiliaryCursor < auxiliaryIndex) {
      steps.push(auxiliary[auxiliaryCursor]);
      auxiliaryCursor += 1;
    }
    const remoteStep = remoteIsBase ? base[baseIndex] : auxiliary[auxiliaryIndex];
    const streamStep = remoteIsBase ? auxiliary[auxiliaryIndex] : base[baseIndex];
    steps.push(mergeStepMetadata(remoteStep, streamStep));
    auxiliaryCursor = auxiliaryIndex + 1;
  }
  while (auxiliaryCursor < auxiliary.length) {
    steps.push(auxiliary[auxiliaryCursor]);
    auxiliaryCursor += 1;
  }

  return {
    steps,
    matchedStepCount: matches.length,
  };
}

function alignTrajectorySteps(remoteSteps, streamSteps) {
  const rows = remoteSteps.length + 1;
  const columns = streamSteps.length + 1;
  const scores = Array.from({ length: rows }, () => new Uint16Array(columns));

  for (let remoteIndex = 1; remoteIndex < rows; remoteIndex += 1) {
    for (let streamIndex = 1; streamIndex < columns; streamIndex += 1) {
      scores[remoteIndex][streamIndex] = areCompatibleSteps(
        remoteSteps[remoteIndex - 1],
        streamSteps[streamIndex - 1],
      )
        ? scores[remoteIndex - 1][streamIndex - 1] + 1
        : Math.max(
            scores[remoteIndex - 1][streamIndex],
            scores[remoteIndex][streamIndex - 1],
          );
    }
  }

  const matches = [];
  let remoteIndex = remoteSteps.length;
  let streamIndex = streamSteps.length;
  while (remoteIndex > 0 && streamIndex > 0) {
    if (
      areCompatibleSteps(
        remoteSteps[remoteIndex - 1],
        streamSteps[streamIndex - 1],
      )
    ) {
      matches.push({
        remoteIndex: remoteIndex - 1,
        streamIndex: streamIndex - 1,
      });
      remoteIndex -= 1;
      streamIndex -= 1;
    } else if (
      scores[remoteIndex - 1][streamIndex] >=
      scores[remoteIndex][streamIndex - 1]
    ) {
      remoteIndex -= 1;
    } else {
      streamIndex -= 1;
    }
  }
  return matches.reverse();
}

function areCompatibleSteps(left, right) {
  if (!left || !right) return false;
  const leftType = String(left.type || '');
  const rightType = String(right.type || '');
  const pointTypes = new Set(['tap', 'long_press']);
  if (pointTypes.has(leftType) && pointTypes.has(rightType)) {
    return pointsWithin(left.x, left.y, right.x, right.y, 16);
  }
  if (leftType !== rightType) return false;
  if (leftType === 'swipe') {
    return (
      pointsWithin(left.x1, left.y1, right.x1, right.y1, 20) &&
      pointsWithin(left.x2, left.y2, right.x2, right.y2, 20)
    );
  }
  if (leftType === 'input_text') return String(left.text) === String(right.text);
  if (leftType === 'keyevent') return String(left.code) === String(right.code);
  return false;
}

function pointsWithin(x1, y1, x2, y2, tolerance) {
  return (
    Math.abs(Number(x1) - Number(x2)) <= tolerance &&
    Math.abs(Number(y1) - Number(y2)) <= tolerance
  );
}

function mergeStepMetadata(remoteStep, streamStep) {
  const preferredStep =
    remoteStep.type === 'tap' && streamStep.type === 'long_press'
      ? streamStep
      : remoteStep;
  return {
    ...preferredStep,
    context: remoteStep.context || streamStep.context,
    delayMs:
      Number(streamStep.delayMs) > 0
        ? Number(streamStep.delayMs)
        : Number(remoteStep.delayMs) || 0,
  };
}

function trajectoryQualityScore(steps) {
  const timed = steps.filter((step) => Number(step.delayMs) > 0).length;
  const contextual = steps.filter((step) => step.context).length;
  const longPresses = steps.filter((step) => step.type === 'long_press').length;
  return steps.length * 100 + contextual * 20 + timed * 10 + longPresses * 5;
}

function hasRecordedTiming(steps) {
  return steps.some((step) => Number(step.delayMs) > 0);
}

function hasCompleteRecordedTiming(steps) {
  return steps.length > 1 && steps.slice(1).every((step) => Number(step.delayMs) > 0);
}

function getTimelineQuality(steps) {
  if (!steps.length) return 'empty';
  if (hasCompleteRecordedTiming(steps)) return 'exact';
  if (hasRecordedTiming(steps)) return 'approximate';
  return 'missing';
}

function validateTrajectoryCoordinates(steps, screen) {
  const width = numberFrom(screen?.width);
  const height = numberFrom(screen?.height);
  const rejected = [];
  const accepted = [];
  const diagnostics = [];

  steps.forEach((step, index) => {
    const reason = invalidCoordinateReason(step, { width, height });
    if (!reason) {
      accepted.push(step);
      return;
    }
    rejected.push({ index, reason, step });
    diagnostics.push(`Rejected recorded action ${index + 1}: ${reason}.`);
  });

  return { steps: accepted, rejected, diagnostics };
}

function invalidCoordinateReason(step, screen) {
  if (step.type === 'tap' || step.type === 'long_press') {
    return invalidPointReason(step.x, step.y, step.context, screen);
  }
  if (step.type === 'swipe') {
    return (
      invalidPointReason(step.x1, step.y1, step.context, screen, false) ||
      invalidPointReason(step.x2, step.y2, step.context, screen, false)
    );
  }
  return null;
}

function invalidPointReason(xValue, yValue, context, screen, checkCorner = true) {
  const x = numberFrom(xValue);
  const y = numberFrom(yValue);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 'non-finite coordinate';
  if (x < 0 || y < 0) return 'negative coordinate';
  if (screen.width > 0 && x >= screen.width) return 'x coordinate outside screen';
  if (screen.height > 0 && y >= screen.height) return 'y coordinate outside screen';
  if (
    checkCorner &&
    !context &&
    screen.width > 0 &&
    screen.height > 0
  ) {
    const cornerWidth = Math.max(20, Math.round(screen.width * STATUS_BAR_CORNER_RATIO));
    const statusBarHeight = Math.max(
      20,
      Math.round(screen.height * STATUS_BAR_HEIGHT_RATIO),
    );
    if (
      y < statusBarHeight &&
      (x < cornerWidth || x > screen.width - cornerWidth)
    ) {
      return 'uncontextualized status-bar corner coordinate';
    }
  }
  return null;
}

function normalizeCandidates(candidates) {
  const filtered = candidates.filter((candidate) => candidate && candidate.type);
  if (!filtered.length) return [];

  const firstTime = filtered.find((candidate) => Number.isFinite(candidate.atMs))?.atMs;
  let previousElapsed = 0;
  return filtered.map((candidate) => {
    const elapsedMs = Number.isFinite(candidate.atMs) && Number.isFinite(firstTime)
      ? Math.max(0, candidate.atMs - firstTime)
      : previousElapsed;
    const step = {
      ...candidate,
      delayMs: Math.max(0, Math.round(elapsedMs - previousElapsed)),
    };
    delete step.atMs;
    previousElapsed = elapsedMs;
    return step;
  });
}

function withActionContext(step, context) {
  return context ? { ...step, context } : step;
}

function extractActionContext(value) {
  const bundleName = firstTextValue(
    value.BUNDLE,
    value.bundleName,
    value.packageName,
    value.bundle,
  );
  const abilityName = firstTextValue(
    value.ABILITY,
    value.abilityName,
    value.activity,
    value.ability,
  );
  const widget = findWidgetContext(value);
  if (!bundleName && !abilityName && !widget) return null;
  return {
    ...(bundleName ? { bundleName } : {}),
    ...(abilityName ? { abilityName } : {}),
    ...(widget ? { widget } : {}),
  };
}

function findWidgetContext(root) {
  const queue = [];
  for (const value of Object.values(root || {})) {
    if (value && typeof value === 'object') queue.push(value);
  }

  let best = null;
  let bestScore = 0;
  while (queue.length) {
    const candidate = queue.shift();
    if (Array.isArray(candidate)) {
      queue.push(...candidate.filter((value) => value && typeof value === 'object'));
      continue;
    }

    const text = firstKeyValue(candidate, [
      'text',
      'originalText',
      'label',
      'description',
      'contentDescription',
      'hint',
      'TEXT',
    ]);
    const id = firstKeyValue(candidate, [
      'id',
      'resourceId',
      'accessibilityId',
      'key',
      'ID',
    ]);
    const type = firstKeyValue(candidate, [
      'className',
      'componentType',
      'widgetType',
      'TYPE',
    ]);
    const bounds = firstKeyValue(candidate, ['bounds', 'rect', 'frame', 'BOUNDS']);
    const score =
      (text ? 4 : 0) +
      (id ? 3 : 0) +
      (type ? 2 : 0) +
      (bounds ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = {
        ...(text ? { text: String(text) } : {}),
        ...(id ? { id: String(id) } : {}),
        ...(type ? { type: String(type) } : {}),
        ...(bounds ? { bounds: cloneSerializable(bounds) } : {}),
      };
    }

    for (const value of Object.values(candidate)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return bestScore > 0 ? best : null;
}

function firstKeyValue(value, keys) {
  for (const key of keys) {
    if (value?.[key] !== undefined && value[key] !== null && value[key] !== '') {
      return value[key];
    }
  }
  return null;
}

function firstTextValue(...values) {
  const value = values.find(
    (candidate) =>
      candidate !== undefined &&
      candidate !== null &&
      String(candidate).trim() !== '',
  );
  return value === undefined ? null : String(value).trim();
}

function cloneSerializable(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function findTimeMs(value) {
  for (const key of ['timestampMs', 'timeMs', 'elapsedMs']) {
    const number = numberFrom(value[key]);
    if (Number.isFinite(number)) return number;
  }
  for (const key of ['timestamp', 'time']) {
    const number = numberFrom(value[key]);
    if (Number.isFinite(number)) return number * 1000;
  }
  return null;
}

function findLineTimeMs(line) {
  const match = line.match(/^\s*\[\s*(\d+(?:\.\d+)?)\s*\]/);
  return match ? Number(match[1]) * 1000 : null;
}

function extractNumbers(value) {
  return [...String(value).matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
}

function numberFrom(value) {
  if (typeof value === 'number') return value;
  if (value === null || value === undefined || value === '') return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function parseInputValue(value) {
  const source = String(value || '').trim();
  if (/^-/.test(source)) return Number.parseInt(source, 16);
  if (/^(?:0x)?f{8}$/i.test(source)) return -1;
  return Number.parseInt(source.replace(/^0x/i, ''), 16);
}

function normalizeKeyCode(code) {
  const value = String(code || '').trim();
  if (/^KEYCODE_/i.test(value)) return value.toUpperCase();
  const aliases = {
    back: 'KEYCODE_BACK',
    home: 'KEYCODE_HOME',
    enter: 'KEYCODE_ENTER',
    power: 'KEYCODE_POWER',
  };
  return aliases[value.toLowerCase()] || value;
}

function normalizeGestureDuration(value) {
  let duration = numberFrom(value);
  if (!Number.isFinite(duration) || duration <= 0) return 300;
  if (duration > 1_000_000) duration /= 1_000_000;
  else if (duration > 40_000) duration /= 1_000;
  return Math.min(40_000, Math.max(50, Math.round(duration)));
}

function normalizeLongPressDuration(value) {
  const duration = normalizeGestureDuration(value);
  return Math.max(500, duration);
}

function getScreenScale(source, target) {
  const sourceWidth = numberFrom(source?.width);
  const sourceHeight = numberFrom(source?.height);
  const targetWidth = numberFrom(target?.width);
  const targetHeight = numberFrom(target?.height);
  return {
    x: sourceWidth > 0 && targetWidth > 0 ? targetWidth / sourceWidth : 1,
    y: sourceHeight > 0 && targetHeight > 0 ? targetHeight / sourceHeight : 1,
  };
}

function scaleCoordinate(value, scale) {
  return Math.round(numberFrom(value) * scale);
}

async function captureDeviceContext(
  session,
  device,
  phase,
  {
    parameterSchema = [],
    parameters = {},
    action = null,
    actionIndex = null,
    includeLayout = true,
  } = {},
) {
  const focusResult = await callOptionalDevice(device, 'getCurrentFocus');
  const snapshotResult = includeLayout
    ? await callOptionalDevice(device, 'getUiTextSnapshot')
    : { value: null, skipped: true };
  const screenshotResult = hasSensitiveParameters(parameterSchema)
    ? { value: null, skipped: true }
    : await callOptionalDevice(device, 'screenshotPng');
  for (const [label, result] of [
    ['前台窗口', focusResult],
    ['界面布局', snapshotResult],
    ['截图', screenshotResult],
  ]) {
    if (result.error) {
      session.diagnostics.push(`${phase} ${label}采集失败: ${result.error}`);
    }
  }

  const sensitiveValues = collectSensitiveValues(parameterSchema, parameters);
  const snapshot = snapshotResult.value
    ? redactSensitiveData(
        {
          text: snapshotResult.value.text || '',
          values: snapshotResult.value.values || [],
          layout: snapshotResult.value.layout || null,
        },
        sensitiveValues,
      )
    : null;
  let screenshotFile = null;
  if (Buffer.isBuffer(screenshotResult.value) && screenshotResult.value.length) {
    screenshotFile = join(session.outputDir, `${safeSegment(phase)}.png`);
    try {
      await writeFile(screenshotFile, screenshotResult.value);
      session.screenshots[phase] = screenshotFile;
    } catch (error) {
      session.diagnostics.push(`${phase} 截图写入失败: ${error.message}`);
      screenshotFile = null;
    }
  }

  if (!focusResult.value && !snapshot && !screenshotFile) return null;
  const context = {
    phase,
    capturedAt: new Date().toISOString(),
    ...(Number.isInteger(actionIndex) ? { actionIndex } : {}),
    ...(action ? { action: redactSensitiveData(action, sensitiveValues) } : {}),
    focus: redactSensitiveData(focusResult.value, sensitiveValues),
    snapshot,
    screenshotFile,
  };
  session.contexts.push(context);
  return context;
}

async function callOptionalDevice(device, method) {
  if (typeof device?.[method] !== 'function') return { value: null, skipped: true };
  try {
    return { value: await device[method]() };
  } catch (error) {
    return { value: null, error: error.message };
  }
}

function hasSensitiveParameters(schema) {
  return (schema || []).some((parameter) => parameter?.sensitive);
}

function collectSensitiveValues(schema, parameters) {
  return (schema || [])
    .filter((parameter) => parameter?.sensitive)
    .map((parameter) => parameters?.[parameter.id])
    .filter(
      (value) =>
        value !== undefined &&
        value !== null &&
        String(value) !== '' &&
        String(value) !== '[已隐藏]',
    )
    .map(String)
    .sort((left, right) => right.length - left.length);
}

function redactSensitiveData(value, sensitiveValues) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return sensitiveValues.reduce(
      (text, sensitive) => text.split(sensitive).join('[已隐藏]'),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveData(entry, sensitiveValues));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactSensitiveData(entry, sensitiveValues),
      ]),
    );
  }
  return value;
}

function summarizeContext(context) {
  return {
    phase: context.phase,
    capturedAt: context.capturedAt,
    actionIndex: context.actionIndex ?? null,
    action: context.action || null,
    focus: context.focus,
    text: String(context.snapshot?.text || '').slice(0, 4000),
    values: (context.snapshot?.values || []).slice(0, 100),
  };
}

function assessRecordingQuality(session, timeline) {
  const issues = [];
  let score = 100;
  const addIssue = (message, penalty) => {
    if (!issues.includes(message)) issues.push(message);
    score -= penalty;
  };
  const stepCount = session.steps.length;
  const durationMs = elapsedBetween(session.startedAt, session.stoppedAt);

  if (!stepCount) {
    return {
      level: 'unusable',
      score: 0,
      issues: ['未记录到可回放动作'],
    };
  }
  if (timeline.rejectedStepCount > 0) {
    addIssue(`已丢弃 ${timeline.rejectedStepCount} 个异常坐标动作`, 30);
  }
  if (timeline.remoteStepCount > 0 && timeline.streamStepCount > 0) {
    const alignmentRatio =
      timeline.matchedStepCount /
      Math.max(timeline.remoteStepCount, timeline.streamStepCount);
    if (alignmentRatio < 0.7) {
      addIssue(
        `远端与实时动作流差异较大（对齐 ${timeline.matchedStepCount}/${Math.max(
          timeline.remoteStepCount,
          timeline.streamStepCount,
        )}）`,
        25,
      );
    }
  }
  if (stepCount <= 1 && durationMs >= 3000) {
    addIssue('录制时长较长，但记录到的动作过少', 25);
  }
  if (timeline.quality === 'missing') {
    addIssue('动作时间信息缺失', 15);
  }
  const expectedActionContexts = Math.min(
    Math.max(timeline.streamStepCount, session.liveActionEventCount),
    Math.max(1, stepCount),
  );
  if (
    expectedActionContexts > 0 &&
    session.actionContextCount < Math.ceil(expectedActionContexts * 0.5)
  ) {
    addIssue(
      `逐动作界面证据不足（${session.actionContextCount}/${expectedActionContexts}）`,
      20,
    );
  }
  if (stepCount <= 1 && durationMs >= 2000 && hasMajorContextTransition(session.contexts)) {
    addIssue('开始与结束界面发生跳转，但记录动作过少', 20);
  }

  score = Math.max(0, Math.min(100, score));
  return {
    level: score < 30 ? 'unusable' : issues.length ? 'review_required' : 'good',
    score,
    issues,
  };
}

function hasMajorContextTransition(contexts) {
  const start = contexts.find((context) => context.phase === 'recording-start');
  const stop = [...contexts]
    .reverse()
    .find((context) => context.phase === 'recording-stop');
  const startFocus = focusIdentity(start?.focus);
  const stopFocus = focusIdentity(stop?.focus);
  return Boolean(startFocus && stopFocus && startFocus !== stopFocus);
}

function focusIdentity(focus) {
  if (!focus) return '';
  return [
    focus.bundleName,
    focus.packageName,
    focus.abilityName,
    focus.activity,
    focus.currentFocus,
  ]
    .filter(Boolean)
    .map(String)
    .join('|');
}

function elapsedBetween(startedAt, stoppedAt) {
  const start = Date.parse(startedAt);
  const stop = Date.parse(stoppedAt);
  return Number.isFinite(start) && Number.isFinite(stop)
    ? Math.max(0, stop - start)
    : 0;
}

function attachOutput(session, child, device) {
  let pendingStdout = '';
  let pendingStderr = '';
  const handleLine = (source, line) => {
    if (!String(line).trim()) return;
    const receivedAt = Date.now();
    enqueueRawLiveLine(session, source, line, receivedAt);
    if (source === 'stderr') {
      session.diagnostics.push(`recording process: ${String(line).trim()}`);
      return;
    }

    session.outputLines.push({ line, at: receivedAt, source });
    const firstNewCandidate = session.liveCandidates.length;
    parseJsonLine(String(line).trim(), session.liveCandidates, receivedAt);
    parseUiRecordLine(String(line).trim(), session.liveCandidates, receivedAt);
    parseGeteventLine(String(line).trim(), session.liveCandidates, receivedAt);
    const parsedCandidates = session.liveCandidates.slice(firstNewCandidate);
    if (parsedCandidates.length) {
      parsedCandidates.forEach((candidate) => {
        session.liveActionEventCount += 1;
        scheduleActionContext(
          session,
          device,
          candidate,
          session.liveActionEventCount,
        );
      });
      return;
    }
    const marker = liveActionMarkerFromLine(line);
    if (marker) {
      session.liveActionEventCount += 1;
      scheduleActionContext(
        session,
        device,
        marker,
        session.liveActionEventCount,
      );
    }
  };
  const consumeChunk = (source, chunk) => {
    const pending = source === 'stdout' ? pendingStdout : pendingStderr;
    const lines = `${pending}${String(chunk)}`.split(/\r?\n/);
    if (source === 'stdout') pendingStdout = lines.pop() || '';
    else pendingStderr = lines.pop() || '';
    for (const line of lines) handleLine(source, line);
  };
  const flush = () => {
    if (pendingStdout.trim()) handleLine('stdout', pendingStdout);
    if (pendingStderr.trim()) handleLine('stderr', pendingStderr);
    pendingStdout = '';
    pendingStderr = '';
  };

  child.stdout?.on('data', (chunk) => consumeChunk('stdout', chunk));
  child.stdout?.on('end', flush);
  child.stdout?.on('close', flush);
  child.stderr?.on('data', (chunk) => consumeChunk('stderr', chunk));
  child.stderr?.on('end', flush);
  child.stderr?.on('close', flush);
  child.on?.('error', (error) => {
    session.diagnostics.push(`recording process error: ${error.message}`);
  });
  return flush;
}

function enqueueRawLiveLine(session, source, line, receivedAt) {
  const sensitiveValues = collectSensitiveValues(
    session.parameterSchema,
    session.runtimeParameters,
  );
  const entry = {
    receivedAt: new Date(receivedAt).toISOString(),
    receivedAtMs: receivedAt,
    source,
    line: redactSensitiveData(String(line), sensitiveValues),
  };
  session.rawLiveWriteQueue = session.rawLiveWriteQueue
    .then(() => appendFile(session.rawLiveFile, `${JSON.stringify(entry)}\n`, 'utf8'))
    .catch((error) => {
      if (!session.rawLiveWriteFailed) {
        session.rawLiveWriteFailed = true;
        session.diagnostics.push(`raw-live.jsonl write failed: ${error.message}`);
      }
    });
}

function scheduleActionContext(session, device, candidate, actionIndex) {
  const action = { ...candidate };
  delete action.atMs;
  session.actionContextQueue = session.actionContextQueue
    .then(() =>
      captureDeviceContext(session, device, `action-${String(actionIndex).padStart(3, '0')}`, {
        parameterSchema: session.parameterSchema,
        parameters: session.runtimeParameters,
        action,
        actionIndex,
        includeLayout: session.provider !== 'hdc',
      }),
    )
    .catch((error) => {
      session.diagnostics.push(
        `action-${String(actionIndex).padStart(3, '0')} context capture failed: ${error.message}`,
      );
    });
}

async function stopProcess(child, diagnostics) {
  if (!child || (child.exitCode !== null && child.exitCode !== undefined)) return;
  try {
    child.stdin?.write('\u0003');
  } catch (error) {
    diagnostics.push(`发送录制停止信号失败: ${error.message}`);
  }
  try {
    child.kill('SIGINT');
  } catch (error) {
    diagnostics.push(`停止录制进程失败: ${error.message}`);
  }
  if (await waitForExit(child, 1000)) return;

  try {
    child.kill();
  } catch (error) {
    diagnostics.push(`强制停止录制进程失败: ${error.message}`);
  }
  await waitForExit(child, 1000);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null && child.exitCode !== undefined) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(exited);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once?.('exit', () => finish(true));
    child.once?.('close', () => finish(true));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function sanitizeParameters(schema, values) {
  const result = {};
  for (const parameter of schema) {
    if (!(parameter.id in (values || {}))) continue;
    if (parameter.sensitive) {
      result[parameter.id] = '[已隐藏]';
      continue;
    }
    result[parameter.id] = values[parameter.id];
  }
  return result;
}

function applyValidationDuration(parameters, schema, validationDurationMs) {
  const requestedMs = Number(validationDurationMs);
  if (!Number.isFinite(requestedMs) || requestedMs <= 0) {
    return clone(parameters);
  }
  const durationParameter = (schema || []).find(
    (parameter) => parameter.type === 'duration' && parameter.id === 'duration',
  );
  if (!durationParameter) return clone(parameters);
  if (
    durationParameter.visibleWhen &&
    parameters?.[durationParameter.visibleWhen.parameterId] !==
      durationParameter.visibleWhen.equals
  ) {
    return clone(parameters);
  }

  const durationMs = Math.min(60_000, Math.max(1000, Math.round(requestedMs)));
  return {
    ...clone(parameters),
    [durationParameter.id]: {
      amount: durationMs / 1000,
      unit: '秒',
    },
  };
}

function applyReplayValidationOverrides(
  parameters,
  schema,
  validationDurationMs,
  workflowId,
) {
  const result = applyValidationDuration(
    parameters,
    schema,
    validationDurationMs,
  );
  if (
    workflowId === WECHAT_MEDIA_WORKFLOW_ID &&
    result.sendMode !== 'duration'
  ) {
    return {
      ...result,
      sendMode: 'count',
      count: 1,
    };
  }
  return result;
}

function parameterizeTrajectory(steps, schema, values) {
  const textParameters = schema.filter(
    (parameter) =>
      parameter.type === 'text' &&
      values?.[parameter.id] !== undefined &&
      values?.[parameter.id] !== null &&
      String(values[parameter.id]) !== '',
  );
  if (!textParameters.length) return steps;

  return steps.map((step) => {
    if (step.type !== 'input_text') return step;
    let text = String(step.text ?? '');
    for (const parameter of textParameters) {
      const value = String(values[parameter.id]);
      if (text.includes(value)) {
        text = text.split(value).join(`{{${parameter.id}}}`);
      }
    }
    return text === step.text ? step : { ...step, text };
  });
}

function resolveParameterTemplate(value, parameters) {
  return String(value ?? '').replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (_, id) =>
    formatRuntimeParameter(parameters[id]),
  );
}

function formatRuntimeParameter(value) {
  if (value && typeof value === 'object' && 'amount' in value) {
    return `${value.amount}${value.unit || ''}`;
  }
  return String(value ?? '');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function restoreRuntimeParameters(schema, values) {
  const restored = clone(values);
  for (const parameter of schema || []) {
    if (
      parameter.sensitive &&
      (restored[parameter.id] === '[已隐藏]' ||
        restored[parameter.id] === undefined)
    ) {
      delete restored[parameter.id];
    }
  }
  return restored;
}

function allValidationChecksPassed(checks) {
  return (
    Array.isArray(checks) &&
    checks.length > 0 &&
    checks.every((check) => check?.status === 'passed')
  );
}

async function findTrajectoryFiles(root) {
  const results = [];

  async function visit(directory, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
      } else if (entry.isFile() && entry.name === 'trajectory.json') {
        results.push(path);
      }
    }
  }

  await visit(root, 0);
  return results;
}

function safeSegment(value) {
  const segment = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!segment) return '未命名';
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(segment) ? `_${segment}` : segment;
}

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '_',
    pad(date.getHours()),
    '-',
    pad(date.getMinutes()),
    '-',
    pad(date.getSeconds()),
  ].join('');
}
