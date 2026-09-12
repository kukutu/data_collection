export function findHarmonyHomeTarget(
  layout,
  { resourceId = '', texts = [] } = {},
) {
  const expectedTexts = normalizeValues(texts);
  const resourceMatches = [];
  let textMatch = null;

  for (const node of flattenLayout(layout)) {
    const attributes = node.attributes;
    const ids = [
      attributes.id,
      attributes.key,
      attributes.resourceId,
      attributes.accessibilityId,
    ].map((value) => String(value || ''));
    if (resourceId && ids.includes(String(resourceId))) {
      resourceMatches.push(node);
      continue;
    }

    if (
      !textMatch &&
      expectedTexts.some((expected) =>
        [
          attributes.text,
          attributes.originalText,
          attributes.description,
          attributes.label,
        ].some((value) => String(value || '').trim() === expected),
      )
    ) {
      textMatch = node;
    }
  }

  if (resourceMatches.length) {
    resourceMatches.sort((left, right) => nodeArea(right) - nodeArea(left));
    return resourceMatches[0];
  }
  return textMatch;
}

export function findHarmonyHomeFolders(layout) {
  const folders = [];
  const seen = new Set();

  for (const node of flattenLayout(layout)) {
    const id = String(node.attributes.id || node.attributes.key || '');
    const clickable =
      node.attributes.clickable === true ||
      String(node.attributes.clickable) === 'true';
    if (!id.startsWith('Folder_accessibility_') || !clickable) continue;

    const key = `${node.centerX}:${node.centerY}`;
    if (seen.has(key)) continue;
    seen.add(key);
    folders.push(node);
  }

  return folders;
}

export function buildHarmonyHomePageSwipe(screen, direction = 'left') {
  const width = Math.max(1, Number(screen?.width) || 1);
  const height = Math.max(1, Number(screen?.height) || 1);
  const left = direction === 'left';
  return {
    x1: Math.round(width * (left ? 0.82 : 0.18)),
    y1: Math.round(height * 0.72),
    x2: Math.round(width * (left ? 0.18 : 0.82)),
    y2: Math.round(height * 0.72),
    durationMs: 300,
  };
}

function flattenLayout(layout) {
  const nodes = [];

  function visit(node) {
    if (!node || typeof node !== 'object') return;
    const attributes =
      node.attributes && typeof node.attributes === 'object'
        ? node.attributes
        : node.attrs && typeof node.attrs === 'object'
          ? node.attrs
          : node;
    const bounds = normalizeBounds(
      attributes.bounds ?? attributes.rect ?? attributes.frame,
    );
    const visible =
      attributes.visible === undefined ||
      attributes.visible === true ||
      String(attributes.visible) === 'true';
    const enabled =
      attributes.enabled === undefined ||
      attributes.enabled === true ||
      String(attributes.enabled) === 'true';
    if (bounds && visible && enabled) {
      nodes.push({
        attributes,
        bounds,
        centerX: Math.round((bounds.x1 + bounds.x2) / 2),
        centerY: Math.round((bounds.y1 + bounds.y2) / 2),
      });
    }
    for (const child of node.children || []) visit(child);
  }

  visit(layout);
  return nodes;
}

function normalizeBounds(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const match = value.match(
      /\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/,
    );
    if (!match) return null;
    return {
      x1: Number(match[1]),
      y1: Number(match[2]),
      x2: Number(match[3]),
      y2: Number(match[4]),
    };
  }

  const x1 = finiteNumber(value.x1 ?? value.left ?? value.x);
  const y1 = finiteNumber(value.y1 ?? value.top ?? value.y);
  const x2 = finiteNumber(
    value.x2 ?? value.right ?? (x1 == null ? null : x1 + Number(value.width || 0)),
  );
  const y2 = finiteNumber(
    value.y2 ?? value.bottom ?? (y1 == null ? null : y1 + Number(value.height || 0)),
  );
  if ([x1, y1, x2, y2].some((entry) => entry == null)) return null;
  if (x2 <= x1 || y2 <= y1) return null;
  return { x1, y1, x2, y2 };
}

function normalizeValues(values) {
  const source = Array.isArray(values) ? values : [values];
  return source.map((value) => String(value || '').trim()).filter(Boolean);
}

function nodeArea(node) {
  const bounds = node?.bounds;
  if (!bounds) return 0;
  return Math.max(0, bounds.x2 - bounds.x1) * Math.max(0, bounds.y2 - bounds.y1);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
