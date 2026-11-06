// 后台：① 工具栏图标当开关；② 页面那边取图被跨域拦住时，代为取图
const OK_HOST = /(^|\.)(discordapp\.com|discordapp\.net)$/; // 只取 Discord 自家图片

// ---------------- 开关：点工具栏图标切换，图标上显示 ON ----------------
const showBadge = (on) => {
  chrome.action.setBadgeText({ text: on ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#5865f2' });
};
const syncBadge = async () => showBadge((await chrome.storage.local.get('enabled')).enabled);
chrome.runtime.onStartup.addListener(syncBadge);
chrome.runtime.onInstalled.addListener(syncBadge);
chrome.action.onClicked.addListener(async () => {
  const on = !(await chrome.storage.local.get('enabled')).enabled;
  await chrome.storage.local.set({ enabled: on });
  showBadge(on);
});

// ---------------- 代为取图 ----------------
async function fetchImage(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !OK_HOST.test(u.hostname)) throw new Error('不是 Discord 的图片地址');
  const r = await fetch(u.href, { signal: AbortSignal.timeout(20000) }); // 20 秒取不到就放弃
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const bytes = new Uint8Array(await r.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { ok: true, b64: btoa(bin), type: r.headers.get('content-type') || '' };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'dce-fetch') return;
  fetchImage(msg.url).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // 异步回复
});
