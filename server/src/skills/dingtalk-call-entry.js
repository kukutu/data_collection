export function dingtalkNodes(snapshot) {
  const result = [];
  function visit(node, parents = []) {
    if (!node) return;
    const item = { ...node.attributes, parents, node };
    result.push(item);
    for (const child of node.children || []) visit(child, [...parents, item]);
  }
  visit(snapshot?.layout);
  return result;
}

export async function tapDingtalkNode(device, node) {
  const b = node?.bounds?.match(/-?\d+/g)?.map(Number);
  if (!b || b.length !== 4 || b[2] <= b[0] || b[3] <= b[1]) throw new Error('钉钉目标控件不可用');
  await device.tap({ x: Math.round((b[0] + b[2]) / 2), y: Math.round((b[1] + b[3]) / 2) });
}

export function firstDingtalkConversation(snapshot) {
  return dingtalkNodes(snapshot).filter(n => n.id === 'session_title' && n.visible !== 'false')
    .filter(n => n.bounds && n.bounds !== '[0,0][0,0]')
    .sort((a, b) => Number(a.bounds.match(/-?\d+/g)[1]) - Number(b.bounds.match(/-?\d+/g)[1]))[0];
}

export async function openDingtalkFirstConversation({ device, sleep }) {
  for (let i = 0; i < 5; i++) {
    const s = await device.getUiTextSnapshot({ attempts: 2, timeoutMs: 8000 });
    if (s.values.includes('挂断') || s.values.includes('会议信息')) throw new Error('钉钉已有通话，请先手动结束');
    const all = dingtalkNodes(s);
    const home = all.find(n => n.id === 'home_tab_im_im');
    const first = firstDingtalkConversation(s);
    if (home && first) {
      await tapDingtalkNode(device, first);
      await sleep(600);
      const chat = await device.getUiTextSnapshot({ attempts: 2, timeoutMs: 8000 });
      const call = dingtalkNodes(chat).find(n => n.id === 'chat_bar_menu_tele');
      if (!call) throw new Error('消息页第一个会话不支持通话，不会改选其他人');
      await tapDingtalkNode(device, call);
      return;
    }
    if (home) await tapDingtalkNode(device, home);
    else await device.keyevent('BACK');
    await sleep(500);
  }
  throw new Error('未找到钉钉消息页第一个会话');
}
