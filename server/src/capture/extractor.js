import { spawn } from 'node:child_process';

import { config } from '../config.js';

export function buildExtractorCommand({
  python = process.env.PYTHON || 'python',
  script = config.capture.extractorScript,
  pcapFile,
  mappingFile,
  outputDir,
  tshark = process.env.TSHARK_PATH || 'tshark',
}) {
  if (!pcapFile) throw new Error('pcapFile is required');
  if (!mappingFile) throw new Error('mappingFile is required');
  if (!outputDir) throw new Error('outputDir is required');
  if (!script) throw new Error('GET_PCAP_SCRIPT or script is required');

  return {
    command: python,
    args: [
      script,
      '--pcap',
      pcapFile,
      '--mapping',
      mappingFile,
      '--out',
      outputDir,
      '--tshark',
      tshark,
    ],
  };
}

export function runExtractor(options) {
  const { command, args } = buildExtractorCommand(options);
  return spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}
