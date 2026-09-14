import { execFile, spawn } from 'node:child_process';

import { config } from '../config.js';

const DEFAULT_LOG_FILE = config.capture.portMappingRemoteFile;

export function buildPortMappingScript({
  packageName,
  fallbackPackageName = '',
  logFile = DEFAULT_LOG_FILE,
  intervalSec = 0.5,
  transport = 'adb',
}) {
  if (!packageName) throw new Error('packageName is required');

  const isHdc = transport === 'hdc';
  const captureCommand = isHdc
    ? [
        `APP_PACKAGE="${escapeShellDoubleQuoted(packageName)}"`,
        `APP_FALLBACK_PACKAGE="${escapeShellDoubleQuoted(fallbackPackageName)}"`,
        'APP_UID=""',
        'APP_UID_SOURCE=""',
        'for APP_CANDIDATE in "$APP_PACKAGE" "$APP_FALLBACK_PACKAGE"; do',
        '  [ -n "$APP_CANDIDATE" ] || continue',
        '  for PID in $(pidof "$APP_CANDIDATE" 2>/dev/null); do',
        '    UID_LINE=$(grep "^Uid:" "/proc/$PID/status" 2>/dev/null | head -n 1)',
        '    set -- $UID_LINE',
        '    if [ -n "$2" ]; then APP_UID="$2"; APP_UID_SOURCE="pidof:$APP_CANDIDATE"; break; fi',
        '  done',
        '  [ -n "$APP_UID" ] && break',
        'done',
        'if [ -z "$APP_UID" ]; then',
        '  for APP_CANDIDATE in "$APP_PACKAGE" "$APP_FALLBACK_PACKAGE"; do',
        '    [ -n "$APP_CANDIDATE" ] || continue',
        '    UID_LINE=$(bm dump -n "$APP_CANDIDATE" 2>/dev/null | grep ' + "'\"uid\":'" + ' | head -n 1)',
        '    set -- $UID_LINE',
        '    if [ -n "$2" ]; then APP_UID=${2%,}; APP_UID_SOURCE="bm-dump:$APP_CANDIDATE"; break; fi',
        '  done',
        'fi',
        'echo "# APP_PACKAGE=$APP_PACKAGE" >> "$LOG_FILE"',
        'if [ -n "$APP_FALLBACK_PACKAGE" ]; then echo "# APP_FALLBACK_PACKAGE=$APP_FALLBACK_PACKAGE" >> "$LOG_FILE"; fi',
        'echo "# APP_UID=${APP_UID:-unknown}" >> "$LOG_FILE"',
        'echo "# UID_SOURCE=${APP_UID_SOURCE:-unknown}" >> "$LOG_FILE"',
        'if [ -n "$APP_UID" ]; then',
        '  echo "# MATCH_MODE=uid-filtered-proc-net" >> "$LOG_FILE"',
        '  echo "# UID_COLUMNS=8,9,10" >> "$LOG_FILE"',
        'else',
        '  echo "# MATCH_MODE=all-device-sockets-fallback" >> "$LOG_FILE"',
        'fi',
        'while true; do',
        '  CURRENT_TIME=$(date +%H:%M:%S)',
        '  if [ -n "$APP_UID" ]; then',
        '    for PROC_FILE in /proc/net/tcp /proc/net/tcp6 /proc/net/udp /proc/net/udp6; do',
        '      [ -r "$PROC_FILE" ] || continue',
        '      PROTO=${PROC_FILE##*/}',
        '      while read -r line; do',
        '        set -- $line',
        '        if [ "${8}" = "$APP_UID" ] || [ "${9}" = "$APP_UID" ] || [ "${10}" = "$APP_UID" ]; then echo "$CURRENT_TIME $PROTO $line" >> "$LOG_FILE"; fi',
        '      done < "$PROC_FILE"',
        '    done',
        '  else',
        '    netstat -an 2>/dev/null | grep -E "^(tcp|tcp6|udp|udp6)[[:space:]]" | while read -r line; do',
        '      echo "$CURRENT_TIME $line" >> "$LOG_FILE"',
        '    done',
        '  fi',
        `  sleep ${Math.max(0.1, Number(intervalSec) || 0.5)}`,
        'done',
      ].join('\n')
    : [
        'while true; do',
        '  CURRENT_TIME=$(date +%H:%M:%S)',
        `  netstat -anp 2>/dev/null | grep -F "${escapeShellDoubleQuoted(packageName)}" | while read line; do`,
        '    echo "$CURRENT_TIME $line" >> "$LOG_FILE"',
        '  done',
        `  sleep ${Math.max(0.1, Number(intervalSec) || 0.5)}`,
        'done',
      ].join('\n');

  return [
    `LOG_FILE="${escapeShellDoubleQuoted(logFile)}"`,
    'echo "TIME, PROTO, LOCAL_IP, REMOTE_IP, STATE, PID_PROGRAM" > "$LOG_FILE"',
    captureCommand,
  ].join('\n');
}

export function startDevicePortLogger({
  tool,
  toolPath,
  transport = tool === 'hdc' ? 'hdc' : 'adb',
  serial = '',
  packageName,
  fallbackPackageName = '',
  logFile = DEFAULT_LOG_FILE,
  intervalSec = 0.5,
}) {
  const script = buildPortMappingScript({
    packageName,
    fallbackPackageName,
    logFile,
    intervalSec,
    transport,
  });
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
