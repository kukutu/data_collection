import test from 'node:test';
import assert from 'node:assert/strict';
import { isYangshipinLiveRoom, yangshipinLiveCards } from '../server/src/skills/yangshipin-live.js';
import { parseTaskFallback } from '../server/src/task-parser.js';
import { loadApps } from '../server/src/app-registry.js';
import { getWorkflowCatalog } from '../server/src/workflow-registry.js';

const node = (text, bounds) => ({ attributes: { text, bounds }, children: [] });
const snapshot = children => ({ layout: { children } });
test('Yangshipin distinguishes the narrow room handle from the side panel header', () => {
  assert.equal(isYangshipinLiveRoom(snapshot([
    node('9万人次观看', '[934,187][1224,240]'), node('我来说几句...', '[266,2573][897,2699]'),
    node('更\n多\n直\n播', '[1224,1476][1266,1656]'),
    node('评论', '[0,1181][176,1321]'),
  ])), true);
  assert.equal(isYangshipinLiveRoom(snapshot([node('更多直播', '[461,171][672,233]')])), false);
  assert.equal(isYangshipinLiveRoom(snapshot([
    node('9万人次观看', '[934,187][1224,240]'), node('我来说几句...', '[266,2573][897,2699]'),
    node('评论', '[0,1181][176,1321]'),
  ])), true);
});
test('Yangshipin targets side-panel preview images rather than their non-clickable titles', () => {
  const s = snapshot([node('更多直播', '[461,171][672,233]'),
    node('逆风翻盘！郑钦文2026美网绝境反击之路', '[461,596][1224,702]'),
    node('3.9万人次观看', '[637,554][814,596]')]);
  const cards = yangshipinLiveCards(s, { width: 1280, height: 2832 });
  assert.equal(cards.length, 1);
  assert.ok(cards[0].y < 596 && cards[0].y > 260);
});
test('Yangshipin live text parses to the dedicated live intent', () => {
  const parsed = parseTaskFallback('看30秒央视频直播，每5秒切换一次直播', loadApps());
  assert.equal(parsed.intent, 'live_entry');
  assert.equal(parsed.appName, '央视频');
  assert.equal(parsed.durationMs, 30000);
});

test('Yangshipin exposes verified live viewing and switching parameters', () => {
  const w = getWorkflowCatalog(loadApps()).find(w => w.id === 'live:yangshipin:live-browse');
  assert.equal(w.status, 'verified');
  assert.equal(w.params.find(p => p.id === 'switchInterval').label, '切换间隔');
  assert.deepEqual(w.params.map(p => p.id), ['duration', 'switchInterval']);
});
