import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

import { adb } from './src/adb.js';
import { loadApps, installedKnownApps } from './src/app-registry.js';
import { config } from './src/config.js';
import { TaskManager } from './src/harness.js';

const root = process.cwd();
const publicDir = join(root, 'public');
const apps = loadApps();
const manager = new TaskManager({ adb, apps });

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
      return sendJson(res, await adb.getDeviceStatus());
    }

    if (url.pathname === '/api/apps' && req.method === 'GET') {
      const packages = await adb.getInstalledPackages().catch(() => '');
      return sendJson(res, installedKnownApps(apps, packages));
    }

    if (url.pathname === '/api/tasks' && req.method === 'POST') {
      const body = await readJson(req);
      const task = manager.start({
        taskText: body.taskText,
        apiKey: body.apiKey,
        useModel: Boolean(body.useModel),
        parseMode: body.parseMode,
      });
      return sendJson(res, task, 202);
    }

    if (url.pathname === '/api/tasks/current' && req.method === 'GET') {
      return sendJson(res, manager.currentSnapshot() || {});
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

    if (url.pathname === '/api/screenshot.png' && req.method === 'GET') {
      const png = await adb.screenshotPng();
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

function listen(port, attemptsLeft = 20) {
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE' && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
      return;
    }
    throw error;
  });

  server.listen(port, () => {
    const actual = server.address().port;
    console.log(`Android controller running at http://localhost:${actual}`);
  });
}

listen(config.server.port);
