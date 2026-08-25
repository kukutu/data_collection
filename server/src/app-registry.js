import { readFileSync } from 'node:fs';

const appsUrl = new URL('../../data/apps.json', import.meta.url);

export function loadApps() {
  return JSON.parse(readFileSync(appsUrl, 'utf8'));
}

export function findAppByName(apps, nameOrText) {
  const text = String(nameOrText || '').trim().toLowerCase();
  if (!text) return null;

  const candidates = [];
  for (const app of apps) {
    for (const alias of [app.name, ...(app.aliases || [])]) {
      const normalized = String(alias).toLowerCase();
      if (text === normalized || text.includes(normalized)) {
        candidates.push({ app, alias: normalized });
      }
    }
  }

  candidates.sort((a, b) => b.alias.length - a.alias.length);
  return candidates[0]?.app || null;
}

export function installedKnownApps(apps, packageListText) {
  const installed = new Set(
    String(packageListText)
      .split(/\r?\n/)
      .map((line) => line.replace(/^package:/, '').trim())
      .filter(Boolean),
  );

  return apps.map((app) => ({
    ...app,
    installed: installed.has(app.packageName),
  }));
}
