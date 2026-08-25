import { dirname, join } from 'node:path';

const defaultCodexHome =
  process.platform === 'win32' && process.env.USERPROFILE ? join(process.env.USERPROFILE, '.codex') : '';

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
  screen: {
    defaultWidth: Number(process.env.DEFAULT_SCREEN_WIDTH || 1080),
    defaultHeight: Number(process.env.DEFAULT_SCREEN_HEIGHT || 2400),
  },
  capture: {
    interfaceName: process.env.CAPTURE_INTERFACE_NAME || '',
    sessionsRoot: process.env.CAPTURE_SESSIONS_ROOT || 'captures',
    portMappingRemoteFile: process.env.PORT_MAPPING_REMOTE_FILE || '/data/local/tmp/port_mapping.txt',
    extractorScript: process.env.GET_PCAP_SCRIPT || '',
  },
};
