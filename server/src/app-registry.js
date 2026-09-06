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
  const source = String(packageListText || '');
  const installedAndroid = new Set(
    source
      .split(/\r?\n/)
      .map((line) => line.replace(/^package:/, '').trim())
      .filter((line) => /^[A-Za-z0-9_.$]+$/.test(line)),
  );

  return apps.map((app) => {
    const androidInstalled = Boolean(app.packageName && installedAndroid.has(app.packageName));
    const harmonyInstalled = Boolean(
      app.harmonyBundleName && source.includes(app.harmonyBundleName),
    );
    const installedVia = androidInstalled ? 'adb' : harmonyInstalled ? 'hdc' : null;
    return {
      ...app,
      installed: Boolean(installedVia),
      installedVia,
    };
  });
}
