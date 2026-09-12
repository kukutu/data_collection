import test from 'node:test';
import assert from 'node:assert/strict';

import {
  executeUiMessage,
  inspectUiMessageSnapshot,
} from '../server/src/ui-message.js';

const INPUT_ID = 'id_text_input';
const SEND_ID = 'send_hot_area';

test('inspectUiMessageSnapshot finds the largest matching resource node', () => {
  const state = inspectUiMessageSnapshot(
    snapshot([
      node({ id: INPUT_ID, text: 'FACT', bounds: '[0,0][10,10]' }),
      node({ id: INPUT_ID, text: 'FACT', bounds: '[100,200][900,300]' }),
      node({ id: SEND_ID, bounds: '[900,200][1000,300]' }),
    ]),
    {
      inputResourceId: INPUT_ID,
      sendResourceId: SEND_ID,
      message: 'FACT',
    },
  );

  assert.equal(state.inputNode.attributes.bounds, '[100,200][900,300]');
  assert.equal(state.inputText, 'FACT');
  assert.ok(state.sendNode);
  assert.equal(state.messageCount, 0);
});

test('inspectUiMessageSnapshot ignores accessibility descriptions as editor text', () => {
  const state = inspectUiMessageSnapshot(
    snapshot([
      node({
        id: INPUT_ID,
        description: '单指双击即可输入内容，双击并按住即可说话',
      }),
      node({ id: 'message-card', text: 'FACT' }),
    ]),
    {
      inputResourceId: INPUT_ID,
      sendResourceId: SEND_ID,
      message: 'FACT',
    },
  );

  assert.equal(state.inputText, '');
  assert.equal(state.messageCount, 1);
});

test('executeUiMessage validates editor state and confirms a new message bubble', async () => {
  const snapshots = [
    snapshot([node({ id: INPUT_ID })]),
    snapshot([node({ id: INPUT_ID, focused: 'true' })]),
    snapshot([
      node({ id: INPUT_ID, text: 'FACT', focused: 'true' }),
      node({ id: SEND_ID, bounds: '[900,200][1000,300]' }),
    ]),
    snapshot([
      node({ id: INPUT_ID }),
      node({ id: 'message-card', text: 'FACT', bounds: '[600,100][900,180]' }),
    ]),
  ];
  const device = fakeDevice(snapshots);

  const result = await executeUiMessage({
    device,
    message: 'FACT',
    inputResourceId: INPUT_ID,
    sendResourceId: SEND_ID,
    readyChecks: 1,
    confirmationChecks: 1,
    pollMs: 50,
    focusWaitMs: 100,
    sleep: async () => {},
  });

  assert.equal(result.sent, true);
  assert.equal(result.autoSubmitted, false);
  assert.deepEqual(device.inputs, [{ text: 'FACT', clearExisting: false }]);
  assert.deepEqual(device.taps, [
    { x: 500, y: 250 },
    { x: 950, y: 250 },
  ]);
});

test('executeUiMessage accepts an auto-submitted message after text injection', async () => {
  const snapshots = [
    snapshot([node({ id: INPUT_ID })]),
    snapshot([node({ id: INPUT_ID, focused: 'true' })]),
    snapshot([
      node({ id: INPUT_ID }),
      node({ id: 'message-card', text: 'FACT', bounds: '[600,100][900,180]' }),
    ]),
  ];
  const device = fakeDevice(snapshots);

  const result = await executeUiMessage({
    device,
    message: 'FACT',
    inputResourceId: INPUT_ID,
    sendResourceId: SEND_ID,
    readyChecks: 1,
    confirmationChecks: 1,
    pollMs: 50,
    focusWaitMs: 100,
    sleep: async () => {},
  });

  assert.equal(result.sent, true);
  assert.equal(result.autoSubmitted, true);
  assert.equal(device.taps.length, 1);
});

test('executeUiMessage retries when the first focus attempt is lost', async () => {
  const snapshots = [
    snapshot([node({ id: INPUT_ID })]),
    snapshot([node({ id: INPUT_ID })]),
    snapshot([node({ id: INPUT_ID })]),
    snapshot([node({ id: INPUT_ID })]),
    snapshot([node({ id: INPUT_ID, focused: 'true' })]),
    snapshot([
      node({ id: INPUT_ID, text: 'FACT', focused: 'true' }),
      node({ id: SEND_ID, bounds: '[900,200][1000,300]' }),
    ]),
    snapshot([
      node({ id: INPUT_ID }),
      node({ id: 'message-card', text: 'FACT', bounds: '[600,100][900,180]' }),
    ]),
  ];
  const device = fakeDevice(snapshots);
  const retries = [];

  const result = await executeUiMessage({
    device,
    message: 'FACT',
    inputResourceId: INPUT_ID,
    sendResourceId: SEND_ID,
    attempts: 2,
    readyChecks: 1,
    confirmationChecks: 1,
    pollMs: 50,
    focusWaitMs: 100,
    sleep: async () => {},
    onRetry: (retry) => retries.push(retry),
  });

  assert.equal(result.sent, true);
  assert.equal(result.attempt, 2);
  assert.equal(retries.length, 1);
  assert.equal(device.inputs.length, 2);
});

test('executeUiMessage can confirm a virtualized chat when the editor clears after send', async () => {
  const existingMessages = [
    node({ id: 'message-card-1', text: 'FACT' }),
    node({ id: 'message-card-2', text: 'FACT' }),
  ];
  const snapshots = [
    snapshot([node({ id: INPUT_ID }), ...existingMessages]),
    snapshot([node({ id: INPUT_ID, focused: 'true' }), ...existingMessages]),
    snapshot([
      node({ id: INPUT_ID, text: 'FACT', focused: 'true' }),
      node({ id: SEND_ID, bounds: '[900,200][1000,300]' }),
      ...existingMessages,
    ]),
    snapshot([node({ id: INPUT_ID }), ...existingMessages]),
  ];
  const device = fakeDevice(snapshots);

  const result = await executeUiMessage({
    device,
    message: 'FACT',
    inputResourceId: INPUT_ID,
    sendResourceId: SEND_ID,
    confirmOnEditorClear: true,
    readyChecks: 1,
    confirmationChecks: 1,
    pollMs: 50,
    focusWaitMs: 100,
    sleep: async () => {},
  });

  assert.equal(result.sent, true);
  assert.equal(result.editorClearConfirmed, true);
  assert.equal(result.messageCountDelta, 0);
  assert.equal(device.taps.length, 2);
});

function fakeDevice(snapshots) {
  let index = 0;
  return {
    taps: [],
    inputs: [],
    async getUiTextSnapshot() {
      const value = snapshots[Math.min(index, snapshots.length - 1)];
      index += 1;
      return value;
    },
    async tap(point) {
      this.taps.push(point);
    },
    async inputText(text, options) {
      this.inputs.push({ text, ...options });
    },
  };
}

function snapshot(children) {
  return {
    text: '',
    layout: {
      attributes: { bounds: '[0,0][1280,2832]' },
      children,
    },
  };
}

function node({
  id,
  text = '',
  description = '',
  focused = 'false',
  bounds = '[100,200][900,300]',
}) {
  return {
    attributes: {
      id,
      key: id,
      text,
      originalText: text,
      description,
      focused,
      visible: 'true',
      bounds,
    },
    children: [],
  };
}
