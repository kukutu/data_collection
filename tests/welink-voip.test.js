import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getCameraState,
  hasMeetingControls,
  isConnected,
  isScreenSharing,
} from '../server/src/skills/welink-voip.js';

const node = (id, text = '', extra = {}) => ({
  attributes: { id, text, bounds: '[0,0][100,100]', ...extra },
  children: [],
});

const snap = children => ({
  layout: { attributes: { bounds: '[0,0][1280,2832]' }, children },
  values: children.map(child => child.attributes.text).filter(Boolean),
});

test('WeLink requires a real meeting surface, not only the page root', () => {
  assert.equal(isConnected(snap([node('meeting_page_root')])), false);
  assert.equal(isConnected(snap([node('meeting_page_root'), node('HWMVideoItem')])), true);
  assert.equal(isConnected(snap([node('meeting_page_root'), node('confTimeSection-ElapsedTime', '00:12')])), true);
});

test('WeLink camera state follows the Harmony control suffix', () => {
  assert.equal(getCameraState(snap([node('HWMConfCtrlMenuItem-2-1')])), false);
  assert.equal(getCameraState(snap([node('HWMConfCtrlMenuItem-2-0')])), true);
  assert.equal(getCameraState(snap([])), null);
});

test('WeLink sharing requires an active status label', () => {
  assert.equal(isScreenSharing(snap([node('meeting_page_root'), node('', '共享屏幕')])), false);
  assert.equal(isScreenSharing(snap([node('meeting_page_root'), node('', '停止共享')])), true);
});

test('WeLink controls are considered visible only with the hangup and timer nodes', () => {
  assert.equal(hasMeetingControls(snap([node('HWMHeaderMenuItemHangup')])), false);
  assert.equal(hasMeetingControls(snap([
    node('HWMHeaderMenuItemHangup'),
    node('confTimeSection-ElapsedTime', '00:12'),
  ])), true);
});
