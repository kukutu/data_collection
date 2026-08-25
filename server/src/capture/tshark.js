import { spawn } from 'node:child_process';

const TSHARK = process.env.TSHARK_PATH || 'tshark';

export function buildTsharkCaptureArgs({ interfaceRef, outputFile, hostIp }) {
  if (!interfaceRef) throw new Error('interfaceRef is required');
  if (!outputFile) throw new Error('outputFile is required');

  const args = ['-i', interfaceRef];
  if (hostIp) args.push('-f', `host ${hostIp}`);
  args.push('-w', outputFile);
  return args;
}

export function startTsharkCapture({ tshark = TSHARK, interfaceRef, outputFile, hostIp }) {
  const args = buildTsharkCaptureArgs({ interfaceRef, outputFile, hostIp });
  return spawn(tshark, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}
