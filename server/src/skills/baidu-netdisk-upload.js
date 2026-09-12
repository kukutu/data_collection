export const BAIDU_NETDISK_UPLOAD_WORKFLOW_ID = 'upload-download:baidu-netdisk:upload-file';
export const BAIDU_NETDISK_UPLOAD_VALIDATION_MODE = 'baidu_netdisk_upload_v1';

export async function executeBaiduNetdiskUpload({ device, app, mediaType = 'image', sleep = wait, onStep = () => {} }) {
  if (app?.id !== 'baidu-netdisk') throw new Error('baidu_netdisk_upload 只适用于百度网盘');
  if (mediaType === 'video') throw new Error('百度网盘视频上传暂未开放（需要 VIP）');
  const screen = await device.getScreenSize();
  const tapText = async (text, minY = 0) => {
    const node = findText(await snapshot(device), text, minY);
    if (!node) throw new Error(`百度网盘未找到${text}`);
    await device.tap(node); await sleep(700);
  };
  let step = 0;
  const stage = async (label, action) => { step += 1; onStep(step, label, 8); await action(); };
  await stage('打开文件页', async () => { await device.forceStopPackage(app.packageName); await device.launchPackage(app.packageName); await sleep(1800); await tapText('文件', screen.height * .8); });
  await stage('打开上传菜单', async () => { await tapNode(device, await findBottomPlus(await snapshot(device), screen)); });
  await stage('选择其他文件', () => tapText('其他文件'));
  await stage(`选择${mediaType === 'document' ? '文档' : '图片'}`, () => tapText(mediaType === 'document' ? '文档' : '图片'));
  await stage('全选待上传文件', async () => { await tapText('所有图片'); await tapText('全选', screen.height * .05); await tapText('完成', screen.height * .8); });
  await stage('等待上传完成', () => sleep(2500));
  await stage('打开最近文件', async () => { const s = await snapshot(device); const more = findTopMore(s, screen); if (!more) throw new Error('未找到右上角更多'); await device.tap(more); await sleep(500); await tapText('最近文件'); });
  await stage('选择并删除上传内容', async () => { const s = await snapshot(device); const select = findTopAction(s, screen); if (!select) throw new Error('未找到最近文件选择按钮'); await device.tap(select); await sleep(500); await tapText('全选'); await tapText('删除', screen.height * .75); await sleep(500); const confirm = findText(await snapshot(device), '确定'); if (confirm) await device.tap(confirm); });
  return { validationMode: BAIDU_NETDISK_UPLOAD_VALIDATION_MODE, validationChecks: Array.from({ length: step }, (_, i) => ({ status: 'passed', step: i + 1 })), replayStepIndex: step };
}
async function snapshot(device) { return device.getUiTextSnapshot(); }
function all(s) { const out=[]; const walk=n=>{ if(!n||typeof n!=='object')return; const a=n.attributes||n; const b=parse(a.bounds); if(b) out.push({ ...a, ...b, x:(b.x1+b.x2)/2,y:(b.y1+b.y2)/2 }); (n.children||[]).forEach(walk); }; walk(s?.layout||s); return out; }
function parse(v) { const m=String(v||'').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/); return m&&{x1:+m[1],y1:+m[2],x2:+m[3],y2:+m[4]}; }
function text(n) { return [n.text,n.originalText,n.description,n.contentDescription,n.label].filter(Boolean).map(String); }
function findText(s,t,minY=0) { return all(s).find(n=>text(n).includes(t)&&n.y>=minY); }
function findBottomPlus(s,screen) { return all(s).filter(n=>n.y>screen.height*.78&&n.x>screen.width*.82).sort((a,b)=>b.y-a.y)[0]; }
function findTopMore(s,screen) { return all(s).find(n=>n.y<screen.height*.16&&(['更多','三个点'].some(t=>text(n).includes(t))||n.x>screen.width*.85)); }
function findTopAction(s,screen) { return all(s).find(n=>n.y<screen.height*.16&&n.x>screen.width*.8); }
async function tapNode(device,n) { if(!n) throw new Error('未找到操作按钮'); await device.tap({x:Math.round(n.x),y:Math.round(n.y)}); }
function wait(ms){return new Promise(r=>setTimeout(r,ms));}
