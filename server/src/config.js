import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const defaultCodexHome =
  process.platform === 'win32' && process.env.USERPROFILE ? join(process.env.USERPROFILE, '.codex') : '';
const localWindowsTools = {
  hdc: 'F:\\hdc\\windows\\toolchains\\hdc.exe',
  tshark: 'F:\\wireshark\\tshark.exe',
  ffmpeg:
    'F:\\ffmpeg\\ffmpeg-2025-12-18-git-78c75d546a-full_build\\bin\\ffmpeg.exe',
};

export const config = {
  server: {
    port: Number(process.env.PORT || 5177),
  },
  llm: {
    model: process.env.OPENAI_MODEL || 'gpt-5.5',
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.codexzh.com/v1',
  },
  codex: {
    command:
      process.env.CODEX_CLI_PATH ||
      (process.platform === 'win32' ? join(dirname(process.execPath), 'codex.cmd') : 'codex'),
    home: process.env.CODEX_HOME_PATH || defaultCodexHome || process.env.CODEX_HOME || '',
    model: process.env.CODEX_MODEL || '',
    timeoutMs: Number(process.env.CODEX_TIMEOUT_MS || 120000),
  },
  adb: {
    uiDumpRemoteFile: process.env.UI_DUMP_REMOTE_FILE || '/sdcard/window.xml',
  },
  hdc: {
    path: resolveExecutable(process.env.HDC_PATH, localWindowsTools.hdc, 'hdc'),
    serial: process.env.HDC_SERIAL || '',
    screenRemoteFile:
      process.env.HDC_SCREEN_REMOTE_FILE || '/data/local/tmp/android-controller-screen.png',
    layoutRemoteFile:
      process.env.HDC_LAYOUT_REMOTE_FILE || '/data/local/tmp/android-controller-layout.json',
  },
  screen: {
    defaultWidth: Number(process.env.DEFAULT_SCREEN_WIDTH || 1080),
    defaultHeight: Number(process.env.DEFAULT_SCREEN_HEIGHT || 2400),
  },
  capture: {
    interfaceName: process.env.CAPTURE_INTERFACE_NAME || 'WLAN3',
    sessionsRoot: process.env.CAPTURE_SESSIONS_ROOT || join(process.cwd(), 'data_collect'),
    portMappingRemoteFile: process.env.PORT_MAPPING_REMOTE_FILE || '/data/local/tmp/port_mapping.txt',
    tsharkPath: resolveExecutable(process.env.TSHARK_PATH, localWindowsTools.tshark, 'tshark'),
    ffmpegPath: resolveExecutable(process.env.FFMPEG_PATH, localWindowsTools.ffmpeg, 'ffmpeg'),
    pythonPath: process.env.PYTHON || 'python',
    screenFps: Number(process.env.CAPTURE_SCREEN_FPS || 1),
    portMappingIntervalSec: Number(process.env.CAPTURE_PORT_MAPPING_INTERVAL_SEC || 0.5),
    extractorScript: process.env.GET_PCAP_SCRIPT || '',
  },
  recordings: {
    root: process.env.RECORDINGS_ROOT || join(process.cwd(), 'data', 'recordings'),
  },
};

function resolveExecutable(configured, localPath, fallback) {
  if (configured) return configured;
  if (process.platform === 'win32' && existsSync(localPath)) return localPath;
  return fallback;
}
