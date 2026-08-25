import { spawn } from 'node:child_process';

import { config } from '../config.js';

const DEFAULT_LOG_FILE = config.capture.portMappingRemoteFile;

export function buildPortMappingScript({
  packageName,
  logFile = DEFAULT_LOG_FILE,
  intervalSec = 0.5,
}) {
  if (!packageName) throw new Error('packageName is required');

  return [
    `LOG_FILE="${escapeShellDoubleQuoted(logFile)}"`,
    'echo "TIME, PROTO, LOCAL_IP, REMOTE_IP, STATE, PID_PROGRAM" > "$LOG_FILE"',
    'while true; do',
    '  CURRENT_TIME=$(date +%H:%M:%S)',
    `  netstat -anp 2>/dev/null | grep "${escapeShellDoubleQuoted(packageName)}" | while read line; do`,
    '    echo "$CURRENT_TIME $line" >> "$LOG_FILE"',
    '  done',
    `  sleep ${Number(intervalSec) || 0.5}`,
    'done',
  ].join('\n');
}

export function startDevicePortLogger({
  tool = process.env.HDC_PATH ? 'hdc' : 'adb',
  packageName,
  logFile = DEFAULT_LOG_FILE,
  intervalSec = 0.5,
}) {
  const script = buildPortMappingScript({ packageName, logFile, intervalSec });
  const args = tool === 'hdc'
    ? ['shell', script]
    : ['shell', 'sh', '-c', script];

  return spawn(tool, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

export function buildPullMappingArgs({ tool = 'adb', remoteFile = DEFAULT_LOG_FILE, localDir = '.' }) {
  if (tool === 'hdc') return ['file', 'recv', remoteFile, localDir];
  return ['pull', remoteFile, localDir];
}

function escapeShellDoubleQuoted(value) {
  return String(value).replace(/["\\$`]/g, '\\$&');
}
