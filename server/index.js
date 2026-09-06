import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

import { adb } from './src/adb.js';
import { ActionRecorder } from './src/action-recorder.js';
import { loadApps, installedKnownApps } from './src/app-registry.js';
import { CaptureManager } from './src/capture/manager.js';
import { config } from './src/config.js';
import { createDeviceController } from './src/device-controller.js';
import { TaskManager } from './src/harness.js';
import { createHdcAdapter } from './src/hdc.js';
import { getWorkflowCatalog } from './src/workflow-registry.js';

const root = process.cwd();
const publicDir = join(root, 'public');
const apps = loadApps();
const workflowCatalog = getWorkflowCatalog(apps);
const hdc = createHdcAdapter({
  apps,
  hdcPath: config.hdc.path,
  serial: config.hdc.serial,
  remoteScreenFile: config.hdc.screenRemoteFile,
  remoteLayoutFile: config.hdc.layoutRemoteFile,
});
const device = createDeviceController({ adbAdapter: adb, hdcAdapter: hdc });
const captureManager = new CaptureManager({
  device,
  hdcPath: config.hdc.path,
});
const manager = new TaskManager({
  adb: device,
  apps,
  captureManager,
  workflows: workflowCatalog,
});
const actionRecorder = new ActionRecorder({ device, apps, workflows: workflowCatalog });
await actionRecorder.loadFromDisk();

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/api/device' && req.method === 'GET') {
      return sendJson(res, await device.getDeviceStatus());
    }

    if (url.pathname === '/api/apps' && req.method === 'GET') {
      const packages = await device.getInstalledPackages().catch(() => '');
      return sendJson(res, installedKnownApps(apps, packages));
    }

    if (url.pathname === '/api/workflows' && req.method === 'GET') {
      const packages = await device.getInstalledPackages().catch(() => '');
      return sendJson(
        res,
        getWorkflowCatalog(installedKnownApps(apps, packages), {
          verifiedWorkflowIds: actionRecorder.getVerifiedWorkflowIds(),
        }),
      );
    }

    if (url.pathname === '/api/tasks' && req.method === 'POST') {
      const body = await readJson(req);
      const task = manager.start({
        taskText: body.taskText,
        apiKey: body.apiKey,
        useModel: Boolean(body.useModel),
        parseMode: body.parseMode,
        capture: body.capture,
        workflowId: body.workflowId,
        parameters: body.parameters,
      });
      return sendJson(res, task, 202);
    }

    if (url.pathname === '/api/tasks/current' && req.method === 'GET') {
      return sendJson(res, manager.currentSnapshot() || {});
    }

    if (url.pathname === '/api/recordings' && req.method === 'GET') {
      return sendJson(res, actionRecorder.list());
    }

    if (url.pathname === '/api/recordings/start' && req.method === 'POST') {
      const body = await readJson(req);
      return sendJson(res, await actionRecorder.start(body), 202);
    }

    const recordingStopMatch = url.pathname.match(/^\/api\/recordings\/([^/]+)\/stop$/);
    if (recordingStopMatch && req.method === 'POST') {
      return sendJson(res, await actionRecorder.stop(recordingStopMatch[1]));
    }

    const recordingRepairMatch = url.pathname.match(/^\/api\/recordings\/([^/]+)\/repair$/);
    if (recordingRepairMatch && req.method === 'POST') {
      const body = await readJson(req);
      return sendJson(res, await actionRecorder.repair(recordingRepairMatch[1], body));
    }

    const recordingReplayMatch = url.pathname.match(/^\/api\/recordings\/([^/]+)\/replay$/);
    if (recordingReplayMatch && req.method === 'POST') {
      const body = await readJson(req);
      actionRecorder.replay(recordingReplayMatch[1], body).catch(() => {});
      return sendJson(
        res,
        actionRecorder.snapshot(recordingReplayMatch[1]),
        202,
      );
    }

    const recordingMatch = url.pathname.match(/^\/api\/recordings\/([^/]+)$/);
    if (recordingMatch && req.method === 'GET') {
      const recording = actionRecorder.snapshot(recordingMatch[1]);
      return recording
        ? sendJson(res, recording)
        : sendJson(res, { error: 'recording not found' }, 404);
    }

    const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch && req.method === 'GET') {
      const task = manager.snapshot(taskMatch[1]);
      return task ? sendJson(res, task) : sendJson(res, { error: 'task not found' }, 404);
    }

    const stopMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/stop$/);
    if (stopMatch && req.method === 'POST') {
      return sendJson(res, { stopped: manager.stop(stopMatch[1]) });
    }

    const continueMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/continue$/);
    if (continueMatch && req.method === 'POST') {
      return sendJson(res, { continued: manager.continue(continueMatch[1]) });
    }

    const captureMatch = url.pathname.match(/^\/api\/captures\/([^/]+)$/);
    if (captureMatch && req.method === 'GET') {
      const capture = captureManager.snapshot(captureMatch[1]);
      return capture
        ? sendJson(res, capture)
        : sendJson(res, { error: 'capture session not found' }, 404);
    }

    if (url.pathname === '/api/capture/config' && req.method === 'GET') {
      return sendJson(res, {
        interfaceName: config.capture.interfaceName,
        outputRoot: config.capture.sessionsRoot,
        screenFps: config.capture.screenFps,
        recordScreen: true,
        recordPortMapping: true,
      });
    }

    if (url.pathname === '/api/screenshot.png' && req.method === 'GET') {
      const png = await device.screenshotPng();
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
      });
      res.end(png);
      return;
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    return sendJson(res, { error: error.message }, 500);
  }
});

function sendJson(res, payload, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload, null, 2));
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1024 * 1024) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function serveStatic(pathname, res) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const candidate = normalize(join(publicDir, requested));

  if (!candidate.startsWith(publicDir) || !existsSync(candidate)) {
    sendJson(res, { error: 'not found' }, 404);
    return;
  }

  res.writeHead(200, {
    'Content-Type': mimeTypes[extname(candidate)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  createReadStream(candidate).pipe(res);
}

function listen(port) {
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Stop the existing controller before restarting.`);
      process.exitCode = 1;
      return;
    }
    throw error;
  });

  server.listen(port, () => {
    console.log(`Android controller running at http://localhost:${port}`);
  });
}

listen(config.server.port);
