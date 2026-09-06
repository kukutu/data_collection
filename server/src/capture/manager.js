import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { config } from '../config.js';
import { findInterfaceByName, listCaptureInterfaces } from './interface.js';
import { startTsharkCapture } from './tshark.js';
import {
  pullDevicePortLog,
  startDevicePortLogger,
} from './device-log.js';
import { startHarmonySystemScreenRecorder } from './harmony-screen-recorder.js';
import { startScreenRecorder } from './screen-recorder.js';
import { buildCaptureReport } from './report.js';
import { runExtractor } from './extractor.js';

export class CaptureManager {
  constructor({
    sessionsRoot = config.capture.sessionsRoot,
    device,
    tshark = config.capture.tsharkPath,
    ffmpeg = config.capture.ffmpegPath,
    hdcPath = config.hdc.path,
    adbPath = process.env.ADB_PATH || 'adb',
    screenFps = config.capture.screenFps,
    portMappingIntervalSec = config.capture.portMappingIntervalSec,
    listInterfaces = listCaptureInterfaces,
    startCapture = startTsharkCapture,
    startLogger = startDevicePortLogger,
    pullMapping = pullDevicePortLog,
    createSystemScreenRecorder = startHarmonySystemScreenRecorder,
    createScreenRecorder = startScreenRecorder,
    runExtraction = runExtractor,
  } = {}) {
    this.sessionsRoot = sessionsRoot;
    this.device = device;
    this.tshark = tshark;
    this.ffmpeg = ffmpeg;
    this.hdcPath = hdcPath;
    this.adbPath = adbPath;
    this.screenFps = screenFps;
    this.portMappingIntervalSec = portMappingIntervalSec;
    this.listInterfaces = listInterfaces;
    this.startCapture = startCapture;
    this.startLogger = startLogger;
    this.pullMapping = pullMapping;
    this.createSystemScreenRecorder = createSystemScreenRecorder;
    this.createScreenRecorder = createScreenRecorder;
    this.runExtraction = runExtraction;
    this.sessions = new Map();
    this.activeSessionId = null;
  }

  async start({
    taskId,
    appName,
    businessName,
    packageName,
    bundleName,
    phoneIp,
    interfaceName = config.capture.interfaceName,
    outputRoot,
    deviceStatus,
    recordScreen = true,
    recordPortMapping = true,
    extractorScript = config.capture.extractorScript,
  }) {
    if (this.activeSessionId) throw new Error('已有采集任务正在运行');
    if (!packageName) throw new Error('packageName is required');
    if (!interfaceName) throw new Error('interfaceName or CAPTURE_INTERFACE_NAME is required');

    const status = deviceStatus || (await this.device?.getDeviceStatus?.());
    if (!status?.connected) throw new Error('采集前未检测到已连接设备');

    const transport = status.provider === 'hdc' ? 'hdc' : 'adb';
    const serial = status.serial || '';
    const interfaces = await this.listInterfaces({ tshark: this.tshark });
    const captureInterface = findInterfaceByName(interfaces, interfaceName);
    if (!captureInterface) {
      throw new Error(
        `capture interface not found: ${interfaceName}; available: ${interfaces
          .map((item) => item.name)
          .join(', ')}`,
      );
    }

    const id = randomUUID();
    const root = resolve(outputRoot || this.sessionsRoot);
    const outputDir = join(
      root,
      safeSegment(appName || packageName),
      safeSegment(businessName || '未分类'),
      `${formatTimestamp(new Date())}-${id.slice(0, 8)}`,
    );
    await mkdir(outputDir, { recursive: true });

    const session = {
      id,
      taskId,
      status: 'starting',
      appName,
      businessName,
      packageName,
      bundleName,
      matchName: transport === 'hdc' ? bundleName || packageName : packageName,
      phoneIp,
      transport,
      serial,
      interfaceName: captureInterface.name,
      interfaceRef: captureInterface.device,
      outputDir,
      pcapFile: join(outputDir, 'traffic.pcapng'),
      screenRecordingFile: join(outputDir, 'screen_record.mp4'),
      mappingFile: join(outputDir, 'port_mapping.txt'),
      mappingRemoteFile: config.capture.portMappingRemoteFile,
      extractedDir: join(outputDir, 'extracted'),
      reportFile: join(outputDir, 'report.md'),
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      finishedAt: null,
      marks: [],
      errors: [],
      diagnostics: [],
      extractionStatus: extractorScript ? 'pending' : 'skipped',
      recordScreen,
      recordPortMapping,
      screenRecordingMode: recordScreen ? 'pending' : 'disabled',
      extractorScript: extractorScript || null,
      tsharkProc: null,
      portLoggerProc: null,
      screenRecorder: null,
      extractorProc: null,
      finalizePromise: null,
      tsharkStopped: false,
      portLoggerStopped: false,
    };

    this.sessions.set(id, session);
    this.activeSessionId = id;

    try {
      session.tsharkProc = this.startCapture({
        tshark: this.tshark,
        interfaceRef: session.interfaceRef,
        outputFile: session.pcapFile,
        hostIp: phoneIp,
      });
      attachProcessErrors(session, session.tsharkProc, 'Wireshark');
      await waitForProcessStart(session.tsharkProc);

      if (recordPortMapping) {
        session.portLoggerProc = this.startLogger({
          transport,
          serial,
          toolPath: this.toolPath(transport),
          packageName: session.matchName,
          logFile: session.mappingRemoteFile,
          intervalSec: this.portMappingIntervalSec,
        });
        attachProcessErrors(session, session.portLoggerProc, '端口映射');
        await waitForProcessStart(session.portLoggerProc);
      }

      if (recordScreen) {
        if (transport === 'hdc') {
          try {
            session.screenRecorder = await this.createSystemScreenRecorder({
              hdcPath: this.hdcPath,
              serial,
              outputFile: session.screenRecordingFile,
              fileName: `capture_${formatTimestamp(new Date())}_${id.slice(0, 8)}.mp4`,
            });
            session.screenRecordingMode = 'harmony_system';
          } catch (error) {
            session.diagnostics.push(`鸿蒙系统录屏启动失败，使用截图回退: ${error.message}`);
            session.screenRecorder = this.createFrameRecorder({
              outputDir,
              outputFile: session.screenRecordingFile,
            });
            session.screenRecordingMode = 'screenshot_fallback';
          }
        } else {
          session.screenRecorder = this.createFrameRecorder({
            outputDir,
            outputFile: session.screenRecordingFile,
          });
          session.screenRecordingMode = 'screenshot_fallback';
        }
      }

      session.status = 'capturing';
      return this.snapshot(id);
    } catch (error) {
      session.errors.push(`采集启动失败: ${error.message}`);
      await this.stop(id, { reason: 'failed' }).catch((stopError) => {
        session.errors.push(`采集收尾失败: ${stopError.message}`);
      });
      throw error;
    }
  }

  mark(id, label = 'mark') {
    const session = this.#get(id);
    session.marks.push({ label, at: new Date().toISOString() });
    return this.snapshot(id);
  }

  async stop(id, { reason = 'completed' } = {}) {
    const session = this.#get(id);
    if (!session.finalizePromise) {
      session.finalizePromise = this.#finalize(session, reason);
    }
    await session.finalizePromise;
    return this.snapshot(id);
  }

  snapshot(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    const {
      tsharkProc,
      portLoggerProc,
      screenRecorder,
      extractorProc,
      finalizePromise,
      ...rest
    } = session;
    return {
      ...rest,
      components: {
        tshark: processStatus(tsharkProc, session.tsharkStopped),
        portMapping: processStatus(portLoggerProc, session.portLoggerStopped),
        screen: screenRecorder?.snapshot?.() || {
          status: session.recordScreen ? 'not_started' : 'disabled',
        },
        extractor: processStatus(extractorProc),
      },
    };
  }

  async #finalize(session, reason) {
    const failedBeforeStop = session.status === 'failed';
    session.status = 'stopping';
    session.stoppedAt = new Date().toISOString();

    await stopChildProcess(session.portLoggerProc, session.errors, '端口映射');
    session.portLoggerStopped = true;

    if (session.screenRecorder) {
      try {
        const result = await session.screenRecorder.stop();
        session.screenFrameCount = result.frameCount;
        session.errors.push(...(result.errors || []));
        session.diagnostics.push(...(result.diagnostics || []));
      } catch (error) {
        session.errors.push(`屏幕录制收尾失败: ${error.message}`);
      }
    }

    await stopChildProcess(session.tsharkProc, session.errors, 'Wireshark');
    session.tsharkStopped = true;

    if (session.recordPortMapping) {
      try {
        await this.pullMapping({
          transport: session.transport,
          serial: session.serial,
          toolPath: this.toolPath(session.transport),
          remoteFile: session.mappingRemoteFile,
          localFile: session.mappingFile,
        });
      } catch (error) {
        session.errors.push(`拉取端口映射失败: ${error.message}`);
      }
    }

    if (session.extractorScript) {
      try {
        await mkdir(session.extractedDir, { recursive: true });
        session.extractorProc = this.runExtraction({
          python: config.capture.pythonPath,
          script: session.extractorScript,
          pcapFile: session.pcapFile,
          mappingFile: session.mappingFile,
          outputDir: session.extractedDir,
          tshark: this.tshark,
        });
        attachProcessErrors(session, session.extractorProc, '流量提取');
        const exitCode = await waitForProcessExit(session.extractorProc);
        if (exitCode === 0) {
          session.extractionStatus = 'completed';
        } else {
          session.extractionStatus = 'failed';
          session.errors.push(`流量提取退出码: ${exitCode}`);
        }
      } catch (error) {
        session.extractionStatus = 'failed';
        session.errors.push(`流量提取失败: ${error.message}`);
      }
    }

    session.status =
      reason === 'stopped'
        ? 'stopped'
        : reason === 'failed' || failedBeforeStop
          ? 'failed'
          : 'completed';
    session.finishedAt = new Date().toISOString();
    try {
      await writeFile(session.reportFile, buildCaptureReport(session), 'utf8');
    } finally {
      if (this.activeSessionId === session.id) this.activeSessionId = null;
    }
  }

  toolPath(transport) {
    return transport === 'hdc' ? this.hdcPath : this.adbPath;
  }

  createFrameRecorder({ outputDir, outputFile }) {
    return this.createScreenRecorder({
      device: this.device,
      outputDir,
      outputFile,
      ffmpeg: this.ffmpeg,
      fps: this.screenFps,
    });
  }

  #get(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`capture session not found: ${id}`);
    return session;
  }
}

function attachProcessErrors(session, child, label) {
  child?.stderr?.on('data', (chunk) => {
    const message = String(chunk).trim();
    if (message) session.diagnostics.push(`${label}: ${message}`);
  });
  child?.on?.('error', (error) => {
    session.errors.push(`${label}: ${error.message}`);
  });
  child?.on?.('exit', (code) => {
    if (session.status === 'capturing' && code !== 0) {
      session.errors.push(`${label}提前退出，退出码: ${code}`);
      session.status = 'failed';
    }
  });
}

function waitForProcessStart(child) {
  if (!child?.once) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener?.('error', onError);
      child.removeListener?.('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error) => finish(error);
    const onExit = (code) => finish(new Error(`process exited during startup with code ${code}`));
    const timer = setTimeout(() => {
      if (child.exitCode !== null && child.exitCode !== undefined) {
        finish(new Error(`process exited during startup with code ${child.exitCode}`));
        return;
      }
      finish();
    }, 200);

    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function waitForProcessExit(child, timeoutMs = 10_000) {
  if (!child) return Promise.resolve(0);
  if (child.exitCode !== null && child.exitCode !== undefined) {
    return Promise.resolve(child.exitCode);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code ?? 1);
    };
    const timer = setTimeout(() => finish(1), timeoutMs);
    child.once?.('exit', (code) => finish(code));
    child.once?.('error', () => finish(1));
  });
}

async function stopChildProcess(child, errors, label) {
  if (!child || (child.exitCode !== null && child.exitCode !== undefined)) return;

  const exitPromise = waitForProcessExit(child, 5_000);
  try {
    child.kill('SIGINT');
  } catch (error) {
    errors.push(`${label}停止失败: ${error.message}`);
  }

  const exitCode = await exitPromise;
  if (exitCode === 1 && child.exitCode === null) {
    try {
      child.kill();
    } catch (error) {
      errors.push(`${label}强制停止失败: ${error.message}`);
    }
    await waitForProcessExit(child, 1_000);
  }
}

function processStatus(child, stopped = false) {
  if (!child) return 'disabled';
  if (stopped) return 'stopped';
  if (child.exitCode !== null && child.exitCode !== undefined) {
    return `exited:${child.exitCode}`;
  }
  return 'running';
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
