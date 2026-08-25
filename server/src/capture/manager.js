import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { findInterfaceByName, listCaptureInterfaces } from './interface.js';
import { startTsharkCapture } from './tshark.js';
import { buildCaptureReport } from './report.js';
import { config } from '../config.js';

export class CaptureManager {
  constructor({ sessionsRoot = config.capture.sessionsRoot } = {}) {
    this.sessionsRoot = sessionsRoot;
    this.sessions = new Map();
  }

  async start({
    appName,
    packageName,
    phoneIp,
    interfaceName = config.capture.interfaceName,
    tshark,
  }) {
    if (!packageName) throw new Error('packageName is required');
    if (!interfaceName) throw new Error('interfaceName or CAPTURE_INTERFACE_NAME is required');

    const interfaces = await listCaptureInterfaces({ tshark });
    const captureInterface = findInterfaceByName(interfaces, interfaceName);
    if (!captureInterface) throw new Error(`capture interface not found: ${interfaceName}`);

    const id = randomUUID();
    const dir = join(this.sessionsRoot, id);
    await mkdir(dir, { recursive: true });

    const rawPcap = join(dir, 'raw.pcapng');
    const startedAt = new Date().toISOString();
    const proc = startTsharkCapture({
      tshark,
      interfaceRef: captureInterface.device,
      outputFile: rawPcap,
      hostIp: phoneIp,
    });

    const session = {
      id,
      status: 'capturing',
      appName,
      packageName,
      phoneIp,
      interfaceName,
      interfaceRef: captureInterface.device,
      rawPcap,
      mappingFile: join(dir, 'port_mapping.txt'),
      extractedDir: join(dir, 'extracted'),
      reportFile: join(dir, 'report.md'),
      startedAt,
      stoppedAt: null,
      marks: [],
      errors: [],
      proc,
    };

    proc.stderr?.on('data', (chunk) => session.errors.push(String(chunk)));
    proc.on('exit', (code) => {
      if (session.status === 'capturing') session.status = code === 0 ? 'stopped' : 'failed';
    });

    this.sessions.set(id, session);
    return this.snapshot(id);
  }

  mark(id, label = 'mark') {
    const session = this.#get(id);
    session.marks.push({ label, at: new Date().toISOString() });
    return this.snapshot(id);
  }

  async stop(id) {
    const session = this.#get(id);
    if (session.status === 'capturing') {
      session.proc.kill('SIGINT');
      session.status = 'stopped';
      session.stoppedAt = new Date().toISOString();
    }

    const report = buildCaptureReport(session);
    await writeFile(session.reportFile, report, 'utf8');
    return this.snapshot(id);
  }

  snapshot(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    const { proc, ...rest } = session;
    return rest;
  }

  #get(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`capture session not found: ${id}`);
    return session;
  }
}
