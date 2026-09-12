import { execFile, spawn } from 'node:child_process';

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
    `  netstat -anp 2>/dev/null | grep -F "${escapeShellDoubleQuoted(packageName)}" | while read line; do`,
    '    echo "$CURRENT_TIME $line" >> "$LOG_FILE"',
    '  done',
    `  sleep ${Math.max(0.1, Number(intervalSec) || 0.5)}`,
    'done',
  ].join('\n');
}

export function startDevicePortLogger({
  tool,
  toolPath,
  transport = tool === 'hdc' ? 'hdc' : 'adb',
  serial = '',
  packageName,
  logFile = DEFAULT_LOG_FILE,
  intervalSec = 0.5,
}) {
  const script = buildPortMappingScript({ packageName, logFile, intervalSec });
  const executable = toolPath || tool || (transport === 'hdc' ? 'hdc' : 'adb');
  const args =
    transport === 'hdc'
      ? [...(serial ? ['-t', serial] : []), 'shell', script]
      : [...(serial ? ['-s', serial] : []), 'shell', 'sh', '-c', script];

  return spawn(executable, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

export function buildPullMappingArgs({
  tool = 'adb',
  transport = tool === 'hdc' ? 'hdc' : 'adb',
  serial = '',
  remoteFile = DEFAULT_LOG_FILE,
  localFile = '',
  localDir = '.',
}) {
  const destination = localFile || localDir;
  if (transport === 'hdc') {
    return [...(serial ? ['-t', serial] : []), 'file', 'recv', remoteFile, destination];
  }
  return [...(serial ? ['-s', serial] : []), 'pull', remoteFile, destination];
}

export function pullDevicePortLog({
  tool,
  toolPath,
  transport = tool === 'hdc' ? 'hdc' : 'adb',
  serial = '',
  remoteFile = DEFAULT_LOG_FILE,
  localFile,
}) {
  if (!localFile) throw new Error('localFile is required');
  const executable = toolPath || tool || (transport === 'hdc' ? 'hdc' : 'adb');
  const args = buildPullMappingArgs({
    transport,
    serial,
    remoteFile,
    localFile,
  });

  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 5 * 1024 * 1024,
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

function escapeShellDoubleQuoted(value) {
  return String(value).replace(/["\\$`]/g, '\\$&');
}
