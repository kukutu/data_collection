import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename, posix } from 'node:path';

const RECORDER_BUNDLE = 'com.huawei.hmos.screenrecorder';
const RECORDER_ABILITY = 'com.huawei.hmos.screenrecorder.ServiceExtAbility';

export async function startHarmonySystemScreenRecorder({
  hdcPath = process.env.HDC_PATH || 'hdc',
  serial = '',
  outputFile,
  fileName = buildRecordingFileName(outputFile),
  remoteDir = '/data/local/tmp',
  queryTimeoutMs = 20_000,
  queryIntervalMs = 500,
  cleanupGallery = true,
  runHdc = execHdc,
}) {
  if (!outputFile) throw new Error('outputFile is required');

  const remoteFile = posix.join(remoteDir, fileName);
  const errors = [];
  const diagnostics = [];
  let status = 'starting';
  let stopped = false;
  let stopPromise = null;
  let galleryUri = '';

  const startResult = await runHdc(
    hdcPath,
    buildHarmonyRecorderStartArgs({ serial, fileName }),
  );
  appendDiagnostics(diagnostics, '系统录屏启动', startResult);
  status = 'recording';

  return {
    stop() {
      if (!stopPromise) {
        stopped = true;
        status = 'stopping';
        stopPromise = finishRecording();
      }
      return stopPromise;
    },
    snapshot,
  };

  function snapshot() {
    return {
      mode: 'harmony_system',
      status,
      fileName,
      galleryUri,
      remoteFile,
      outputFile,
      errors: errors.slice(),
      diagnostics: diagnostics.slice(),
      stopped,
    };
  }

  async function finishRecording() {
    try {
      const stopResult = await runHdc(
        hdcPath,
        buildHarmonyRecorderStopArgs({ serial }),
      );
      appendDiagnostics(diagnostics, '系统录屏停止', stopResult);

      galleryUri = await waitForMediaUri({
        hdcPath,
        serial,
        fileName,
        queryTimeoutMs,
        queryIntervalMs,
        runHdc,
      });

      const copyResult = await runHdc(
        hdcPath,
        buildHarmonyMediaCopyArgs({ serial, galleryUri, remoteFile }),
      );
      appendDiagnostics(diagnostics, '系统录屏复制', copyResult);

      const pullResult = await runHdc(
        hdcPath,
        buildHarmonyRecordingPullArgs({ serial, remoteFile, outputFile }),
      );
      appendDiagnostics(diagnostics, '系统录屏拉取', pullResult);

      const fileStats = await stat(outputFile);
      if (!fileStats.isFile() || fileStats.size <= 0) {
        throw new Error('系统录屏文件为空');
      }

      status = 'completed';
    } catch (error) {
      errors.push(`系统屏幕录制失败: ${error.message}`);
      status = 'failed';
    } finally {
      await cleanupGeneratedFiles({
        hdcPath,
        serial,
        remoteFile,
        galleryUri,
        cleanupGallery,
        runHdc,
        diagnostics,
      });
    }

    return snapshot();
  }
}

export function buildHarmonyRecorderStartArgs({ serial = '', fileName }) {
  if (!fileName) throw new Error('fileName is required');
  return [
    ...targetArgs(serial),
    'shell',
    'aa',
    'start',
    '-b',
    RECORDER_BUNDLE,
    '-a',
    RECORDER_ABILITY,
    '--ps',
    'CustomizedFileName',
    fileName,
  ];
}

export function buildHarmonyRecorderStopArgs({ serial = '' } = {}) {
  return [
    ...targetArgs(serial),
    'shell',
    'aa',
    'start',
    '-b',
    RECORDER_BUNDLE,
    '-a',
    RECORDER_ABILITY,
  ];
}

export function buildHarmonyMediaQueryArgs({ serial = '', fileName }) {
  return [...targetArgs(serial), 'shell', 'mediatool', 'query', fileName, '-u'];
}

export function buildHarmonyMediaCopyArgs({
  serial = '',
  galleryUri,
  remoteFile,
}) {
  return [
    ...targetArgs(serial),
    'shell',
    'mediatool',
    'recv',
    galleryUri,
    remoteFile,
  ];
}

export function buildHarmonyRecordingPullArgs({
  serial = '',
  remoteFile,
  outputFile,
}) {
  return [
    ...targetArgs(serial),
    'file',
    'recv',
    remoteFile,
    outputFile,
  ];
}

export function parseHarmonyMediaUri(output, fileName = '') {
  const matches = String(output || '').match(/file:\/\/media\/[^\s"]+/g) || [];
  if (!fileName) return matches[0] || '';
  return matches.find((uri) => uri.endsWith(`/${fileName}`)) || '';
}

async function waitForMediaUri({
  hdcPath,
  serial,
  fileName,
  queryTimeoutMs,
  queryIntervalMs,
  runHdc,
}) {
  const deadline = Date.now() + Math.max(1_000, Number(queryTimeoutMs) || 20_000);
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const result = await runHdc(
        hdcPath,
        buildHarmonyMediaQueryArgs({ serial, fileName }),
      );
      const uri = parseHarmonyMediaUri(result.stdout, fileName);
      if (uri) return uri;
    } catch (error) {
      lastError = error;
    }

    await sleep(Math.max(100, Number(queryIntervalMs) || 500));
  }

  const suffix = lastError ? `: ${lastError.message}` : '';
  throw new Error(`未找到系统录屏媒体文件 ${fileName}${suffix}`);
}

async function cleanupGeneratedFiles({
  hdcPath,
  serial,
  remoteFile,
  galleryUri,
  cleanupGallery,
  runHdc,
  diagnostics,
}) {
  try {
    const result = await runHdc(hdcPath, [
      ...targetArgs(serial),
      'shell',
      'rm',
      '-f',
      remoteFile,
    ]);
    appendDiagnostics(diagnostics, '系统录屏临时文件清理', result);
  } catch (error) {
    diagnostics.push(`系统录屏临时文件清理失败: ${error.message}`);
  }

  if (!cleanupGallery || !galleryUri) return;
  try {
    const result = await runHdc(hdcPath, [
      ...targetArgs(serial),
      'shell',
      'mediatool',
      'delete',
      galleryUri,
    ]);
    appendDiagnostics(diagnostics, '系统录屏媒体库清理', result);
  } catch (error) {
    diagnostics.push(`系统录屏媒体库清理失败: ${error.message}`);
  }
}

function buildRecordingFileName(outputFile) {
  const stem = basename(outputFile || 'screen_record.mp4', '.mp4')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${stem || 'screen_record'}_${Date.now()}_${randomUUID().slice(0, 8)}.mp4`;
}

function targetArgs(serial) {
  return serial ? ['-t', serial] : [];
}

function appendDiagnostics(diagnostics, label, result = {}) {
  const output = [result.stdout, result.stderr]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' | ');
  if (output) diagnostics.push(`${label}: ${output}`);
}

function execHdc(command, args) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
