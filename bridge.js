// 扩展这一侧：负责开关状态，以及把导出内容（thread.md + 图片）打包成一个 zip，像普通下载一样保存
const OK_HOST = /(^|\.)(discordapp\.com|discordapp\.net)$/; // 只取 Discord 自家图片
const MAX_EDGE = 1568; // 图片最长边超过这个就缩小（AI 看图本来也只按这个尺寸）

// ---------------- 开关状态告诉页面脚本（页面脚本读不到扩展存储） ----------------
const sendState = async () => {
  const { enabled } = await chrome.storage.local.get('enabled');
  window.postMessage({ type: 'dce-enabled', on: !!enabled }, location.origin);
};
chrome.storage.onChanged.addListener((c, area) => area === 'local' && 'enabled' in c && sendState());
sendState();

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  if (e.data?.type === 'dce-state-req') sendState();
  if (e.data?.type === 'dce-export-cancel') exportCtrl?.abort();
  if (e.data?.type === 'dce-export-req') {
    const progress = (text) => window.postMessage({ type: 'dce-progress', text }, location.origin);
    exportCtrl = new AbortController();
    exportZip(e.data.payload, progress, exportCtrl.signal)
      .catch((err) => ({ ok: false, error: String(err?.message || err) }))
      .then((res) => window.postMessage({ type: 'dce-export-res', id: e.data.id, res }, location.origin));
  }
});

// ---------------- 打包导出 ----------------
const IMAGE_TIMEOUT = 20000; // 单张图片 20 秒还没下完就跳过，免得整个导出卡死
let exportCtrl = null; // 用来中途停止导出

async function exportZip({ name, markdown, images }, progress, signal) {
  const files = [];
  const seenPixels = new Map(); // 画面指纹 → 第一次出现的图片路径
  let saved = 0;
  let failed = 0;
  for (let i = 0; i < images.length; i++) {
    if (signal.aborted) return { ok: false, cancelled: true };
    const im = images[i];
    progress(`⏳ 打包图片 ${i + 1}/${images.length}…（点此停止）`);
    let blob = null;
    if (/^images\/[\w.-]+$/.test(im.path)) {
      try {
        blob = await getImage(im.url, AbortSignal.any([signal, AbortSignal.timeout(IMAGE_TIMEOUT)]));
      } catch (err) {
        if (signal.aborted) return { ok: false, cancelled: true };
        console.warn('[Discord导出] 图片没取到', im.url, err);
      }
    }
    let line;
    if (!blob) {
      failed++;
      line = `🖼 （图片没能下载）${im.path}`;
    } else {
      // 按画面判断重复：文件里藏的数据（比如酒馆角色卡）不同也算同一张
      const fp = await fingerprint(blob);
      if (fp && seenPixels.has(fp)) {
        line = `🖼 （画面同 ${seenPixels.get(fp)}，不重复附图）`;
      } else {
        files.push({ name: im.path, data: stripPngText(await shrink(blob)) });
        if (fp) seenPixels.set(fp, im.path);
        saved++;
        line = `🖼 ${im.path}`;
      }
    }
    markdown = markdown.replace(`🖼 ${im.path}`, () => line);
  }
  if (signal.aborted) return { ok: false, cancelled: true };
  files.unshift({ name: 'thread.md', data: new TextEncoder().encode(markdown) });

  const a = document.createElement('a');
  a.href = URL.createObjectURL(makeZip(files));
  a.download = safeName(name) + '.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return { ok: true, file: a.download, saved, failed };
}

// Windows 文件名不允许 < > : " / \ | ? *，换成长得像的全角字符，而不是一律变成下划线
const FULL_WIDTH = { '<': '＜', '>': '＞', ':': '：', '"': '＂', '/': '／', '\\': '＼', '|': '｜', '?': '？', '*': '＊' };
const safeName = (s) =>
  String(s)
    .replace(/[<>:"/\\|?*]/g, (c) => FULL_WIDTH[c])
    .replace(/[\x00-\x1f]/g, '')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80) || 'Discord帖子';

// 等一个结果，但停止/超时信号一来就不等了
const untilAbort = (promise, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    promise.then(resolve, reject);
  });

async function getImage(url, signal) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !OK_HOST.test(u.hostname)) throw new Error('不是 Discord 的图片地址');
  try {
    const r = await fetch(u.href, { signal });
    if (r.ok) return await r.blob();
  } catch (err) {
    if (signal.aborted) throw err; // 是停止或超时，不是跨域问题
    // 被浏览器跨域规则拦下时，交给扩展后台去取
  }
  const res = await untilAbort(chrome.runtime.sendMessage({ type: 'dce-fetch', url: u.href }), signal);
  if (!res?.ok) throw new Error(res?.error || '后台取图失败');
  const bin = atob(res.b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: res.type });
}

// 画面指纹：把图片解码成像素再算哈希，只看“长什么样”，不看文件里藏了什么
// GIF 只能解出第一帧，为免把不同动图当成一样，GIF 按整个文件比
async function fingerprint(blob) {
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  try {
    if (blob.type === 'image/gif') return 'gif:' + hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    return `${c.width}x${c.height}:` + hex(await crypto.subtle.digest('SHA-256', px));
  } catch {
    return null; // 解码失败就不去重，照常放进去
  }
}

// 去掉 PNG 里藏的文字数据（比如酒馆角色卡的提示词）和来源凭证元数据，画面完全不变，文件能小一半
function stripPngText(bytes) {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 8 || SIG.some((v, i) => bytes[i] !== v)) return bytes; // 不是 PNG
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const keep = [bytes.subarray(0, 8)];
  for (let p = 8; p + 12 <= bytes.length; ) {
    const end = p + 12 + dv.getUint32(p);
    if (end > bytes.length) return bytes; // 文件结构不对，原样保留
    const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    if (!['tEXt', 'iTXt', 'zTXt', 'caBX'].includes(type)) keep.push(bytes.subarray(p, end));
    p = end;
  }
  const out = new Uint8Array(keep.reduce((s, k) => s + k.length, 0));
  let o = 0;
  for (const k of keep) {
    out.set(k, o);
    o += k.length;
  }
  return out;
}

// 大图缩小（格式不变，文件名也就不用变）；GIF 等其它格式原样保留
async function shrink(blob) {
  const original = async () => new Uint8Array(await blob.arrayBuffer());
  if (!/^image\/(png|jpeg|webp)$/.test(blob.type)) return original();
  try {
    const bmp = await createImageBitmap(blob);
    const scale = MAX_EDGE / Math.max(bmp.width, bmp.height);
    if (scale >= 1) {
      bmp.close();
      return original();
    }
    const c = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return new Uint8Array(await (await c.convertToBlob({ type: blob.type, quality: 0.9 })).arrayBuffer());
  } catch {
    return original();
  }
}

// ---------------- 最简 zip 生成（不压缩，图片本身已是压缩格式；文件名用 UTF-8） ----------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(d) {
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) c = CRC_TABLE[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // 文件名是 UTF-8
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true);
    parts.push(lh, name, f.data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch, name);

    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
