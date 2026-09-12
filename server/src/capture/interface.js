import { execFile } from 'node:child_process';

const TSHARK = process.env.TSHARK_PATH || 'tshark';

export function parseTsharkInterfaces(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => {
      const match = line.match(/^(\d+)\.\s+(.+?)(?:\s+\((.+)\))?$/);
      if (!match) return null;
      return {
        index: Number(match[1]),
        device: match[2],
        name: match[3] || match[2],
        raw: line,
      };
    })
    .filter(Boolean);
}

export function findInterfaceByName(interfaces, name) {
  const target = normalizeInterfaceName(name);
  return (
    interfaces.find((item) => normalizeInterfaceName(item.name) === target) ||
    interfaces.find((item) => normalizeInterfaceName(item.device) === target) ||
    null
  );
}

export async function listCaptureInterfaces({ tshark = TSHARK } = {}) {
  const output = await execText(tshark, ['-D']);
  return parseTsharkInterfaces(output);
}

function normalizeInterfaceName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function execText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', timeout: 15000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}
