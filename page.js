// Discord 帖子导出 —— 运行在页面里，只读取浏览器里已经加载/渲染出来的内容。
// 默认不动页面：你自己滚动浏览，滚过的消息会被自动记下来，点按钮时把记下的全部导出。
// 不读 Token、不自己请求 Discord 接口。
(() => {
  if (window.__dceLoaded) return;
  window.__dceLoaded = true;

  const NORMAL_TYPES = new Set([0, 19, 20, 21, 23]); // 普通消息/回复/指令消息等，其余视为系统消息
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const states = new Map(); // 每个帖子各自的记录：频道ID → { recs, users }
  let busy = false; // 正在导出或自动加载
  let autoScrolling = false;
  let exporting = false; // 正在打包图片（这时点按钮 = 停止）
  let cancelled = false;
  let holdLabelUntil = 0; // 结果提示保留一会儿再恢复计数
  let enabled = false; // 开关：点浏览器工具栏上的扩展图标切换；关着时不显示按钮、不记录

  // ---------------- 按钮 ----------------
  const box = document.createElement('div');
  Object.assign(box.style, { position: 'fixed', right: '18px', bottom: '90px', zIndex: 99999, display: 'none', gap: '6px' });
  const mkBtn = (text, title) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.title = title;
    Object.assign(b.style, {
      padding: '8px 12px', borderRadius: '18px', border: 'none', background: '#5865f2', color: '#fff',
      font: '14px sans-serif', cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,.35)', opacity: '0.9',
    });
    box.appendChild(b);
    return b;
  };
  const upBtn = mkBtn('⤒', '可选：自动往上滚到帖子开头，边滚边记录（再点一次停止）');
  const downBtn = mkBtn('⤓', '可选：自动往下滚到最新消息，边滚边记录（再点一次停止）');
  const btn = mkBtn('📥 导出', '导出你已经浏览过的消息');
  document.body.appendChild(box);
  const setBtn = (t) => (btn.textContent = t);
  const flash = (t) => {
    setBtn(t);
    holdLabelUntil = Date.now() + 8000;
  };

  // 当前打开的帖子（侧边栏打开时页面上有两个列表，帖子在后面那个）
  function current() {
    const lists = document.querySelectorAll('ol[data-list-id="chat-messages"]');
    const ol = lists[lists.length - 1];
    const p = parseLiId(ol?.querySelector('li[id^="chat-messages-"]')?.id);
    if (!p) return null;
    const key = p.ch || location.pathname;
    if (!states.has(key)) states.set(key, { recs: new Map(), users: new Map() });
    return { ol, chId: p.ch, listCount: lists.length, st: states.get(key) };
  }

  // 把页面上现在有的消息记下来（已记过的跳过）
  function grab() {
    const c = current();
    if (!c) return null;
    for (const li of c.ol.querySelectorAll('li[id^="chat-messages-"]')) {
      const p = parseLiId(li.id);
      if (!p || (c.chId && p.ch !== c.chId)) continue;
      if (c.st.recs.get(p.id)?.ok) continue;
      c.st.recs.set(p.id, parseMessage(li, p.id, c.st));
    }
    return c;
  }

  // 开关状态由扩展传过来
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.type !== 'dce-enabled') return;
    enabled = e.data.on;
    box.style.display = enabled ? 'flex' : 'none';
    if (!enabled && autoScrolling) stopAuto();
  });
  window.postMessage({ type: 'dce-state-req' }, location.origin);

  // 开着时持续记录：你滚到哪，就记到哪
  setInterval(() => {
    if (!enabled || busy) return;
    const c = grab();
    if (Date.now() > holdLabelUntil) setBtn(c ? `📥 导出（已记录 ${c.st.recs.size} 条）` : '📥 导出');
  }, 600);

  btn.addEventListener('click', () => {
    if (autoScrolling) return stopAuto();
    if (exporting) {
      // 打包途中再点一次：停止导出
      window.postMessage({ type: 'dce-export-cancel' }, location.origin);
      setBtn('⏹ 正在停止…');
      return;
    }
    if (busy) return;
    busy = true;
    exportNow()
      .catch((e) => {
        console.error('[Discord导出]', e);
        flash('❌ 导出失败');
        alert('导出失败：' + e.message);
      })
      .finally(() => (busy = false));
  });

  // 自动滚动：dir = -1 往上到开头，+1 往下到最新；滚动中点任意一个滚动按钮都是停止
  function startAuto(dir, b, icon) {
    if (autoScrolling) return stopAuto();
    if (busy) return;
    busy = autoScrolling = true;
    cancelled = false;
    b.textContent = '⏹';
    grab();
    scrollPhase(dir)
      .catch((e) => console.error('[Discord导出]', e))
      .finally(() => {
        busy = autoScrolling = false;
        b.textContent = icon;
        const n = grab()?.st.recs.size ?? 0;
        flash(cancelled ? `已停止，记录 ${n} 条` : `✅ 已到${dir < 0 ? '开头' : '最新'}，共记录 ${n} 条`);
      });
  }
  upBtn.addEventListener('click', () => startAuto(-1, upBtn, '⤒'));
  downBtn.addEventListener('click', () => startAuto(+1, downBtn, '⤓'));

  function stopAuto() {
    cancelled = true;
    setBtn('⏹ 正在停止…');
  }

  // ---------------- 导出 ----------------
  async function exportNow() {
    const c = grab();
    if (!c || !c.st.recs.size) return alert('还没有记录到消息。请先打开一个帖子，并滚动浏览你想导出的部分。');

    const title = prompt(
      `将导出你浏览过的 ${c.st.recs.size} 条消息。\n确认标题（也会用作 zip 文件名）：`,
      guessTitle(c.ol, c.listCount),
    );
    if (title === null) return;
    setBtn('⏳ 整理中…');
    const name = title.trim() || 'Discord帖子';
    const guildId = location.pathname.split('/')[2] || '@me';
    const link = `${location.origin}/channels/${guildId}/${c.chId || ''}`;
    const { markdown, images } = render(name, link, c.st, c.chId);
    exporting = true;
    let res;
    try {
      res = await sendToExtension({ name: `${name} ${stamp(new Date())}`, markdown, images });
    } finally {
      exporting = false;
    }
    if (res.cancelled) return flash('⏹ 已停止导出');
    if (!res.ok) throw new Error(res.error || '保存失败');
    flash(`✅ ${c.st.recs.size} 条，图 ${res.saved} 张`);
    if (res.failed) alert(`已下载 ${res.file}\n其中 ${res.failed} 张图片没能取到（可能链接已过期），文本里已标注。`);
  }

  // （可选功能）沿一个方向滚动，每一步都记录。
  // 判断到头的方法：滚了但位置没动，并且等一会儿 Discord 也没加载出新消息 → 到头了。
  // （不看“滚动条是不是 0”，因为 Discord 顶部可能留几像素空白，会导致永远停不下来）
  async function scrollPhase(dir) {
    let idle = 0;
    while (!cancelled) {
      const c = current();
      const sc = c && findScroller(c.ol);
      if (!sc) break;
      if (dir < 0 && c.chId && c.st.recs.has(c.chId)) break; // 已经记到论坛帖子的第一条
      const before = sc.scrollTop;
      const n = c.st.recs.size;
      const h = sc.scrollHeight;
      sc.scrollTop = before + dir * sc.clientHeight * 1.5;
      await sleep(300);
      grab();
      if (Math.abs(sc.scrollTop - before) > 1) {
        idle = 0;
      } else {
        await sleep(800); // 滚不动了：等等看 Discord 会不会再加载一批
        grab();
        if (c.st.recs.size === n && sc.scrollHeight === h) {
          if (++idle >= 4) break;
        } else idle = 0;
      }
      setBtn(`⏳ ${dir < 0 ? '往上加载' : '往下加载'}… 已记录 ${c.st.recs.size} 条（点 ⏹ 停止）`);
    }
  }

  // ---------------- 解析单条消息 ----------------
  function parseLiId(id) {
    const m = /^chat-messages-(?:(\d+)-)?(\d+)$/.exec(id || '');
    return m && { ch: m[1] || null, id: m[2] };
  }

  function fiberOf(el) {
    const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$'));
    return k ? el[k] : null;
  }

  // 从 React 内部数据里拿到这条消息的结构化对象（回复关系、附件、反应等都在里面）
  function findMessage(li, id) {
    const starts = [
      li.querySelector('#message-content-' + id),
      li.querySelector('#message-accessories-' + id),
      li.firstElementChild,
      li,
    ];
    for (const s of starts) {
      if (!s) continue;
      let f = fiberOf(s);
      for (let i = 0; f && i < 40; i++, f = f.return) {
        const m = f.memoizedProps?.message;
        if (m && m.id === id) return m;
      }
    }
    return null;
  }

  function parseMessage(li, id, st) {
    const msg = findMessage(li, id);
    const rec = { id, ok: !!msg, text: '', images: [], files: [], embeds: [], stickers: [], reactions: [] };

    // 正文：用页面上渲染好的文字（@提及、频道名、表情都已经是可读形式）
    const contentEl =
      li.querySelector('#message-content-' + id) ||
      [...li.querySelectorAll('[id^="message-content-"]')].find((e) => !e.closest('[id^="message-reply-context-"]'));
    if (contentEl) rec.text = tidy(domToText(contentEl));

    // 作者：页面上显示的名字（服务器昵称）优先
    const header = li.querySelector('[id^="message-username-"]');
    const headerName = header && (header.querySelector('[class*="username"]') || header).textContent.trim();
    if (msg?.author) {
      const a = msg.author;
      rec.aid = a.id;
      if (!st.users.has(a.id)) {
        st.users.set(a.id, { name: a.globalName || a.global_name || a.username, handle: a.username, bot: !!a.bot });
      }
      if (headerName) st.users.get(a.id).nick = headerName;
    } else if (headerName) {
      rec.aname = headerName;
    }

    // 回复关系
    const rc = li.querySelector('[id^="message-reply-context-"]');
    const isReply = msg ? msg.type === 19 : !!rc;
    if (isReply) {
      const ref = msg && (msg.messageReference || msg.message_reference);
      let refId = ref?.message_id || ref?.messageId || null;
      const c = rc?.querySelector('[id^="message-content-"]');
      if (!refId && c) refId = c.id.slice('message-content-'.length);
      rec.reply = { id: refId, preview: rc ? (rc.innerText || rc.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '' };
    }

    if (msg && !NORMAL_TYPES.has(msg.type)) {
      rec.sys =
        msg.type === 4 // 改帖子标题
          ? `帖子标题改为：${msg.content}`
          : (li.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    }

    addAttachments(rec, msg ? msg.attachments || [] : domImages(li));

    const snap = (msg?.messageSnapshots || msg?.message_snapshots)?.[0]?.message;
    if (snap) {
      rec.fwd = cleanRaw(snap.content || '');
      addAttachments(rec, snap.attachments || []);
    }

    for (const e of msg?.embeds || []) {
      rec.embeds.push({
        type: e.type,
        title: e.rawTitle ?? e.title ?? '',
        desc: e.rawDescription ?? e.description ?? '',
        url: e.url || '',
        site: e.provider?.name || '',
        author: e.author?.name || '',
        fields: (e.fields || []).map((f) => [f.rawName ?? f.name, f.rawValue ?? f.value]),
      });
      const img = e.image || (e.type === 'image' ? e.thumbnail : null);
      const u = img && (img.proxyURL || img.proxy_url || img.url);
      if (u) rec.images.push({ url: u, name: '' });
    }

    rec.stickers = (msg?.stickerItems || msg?.sticker_items || []).map((s) => s.name);
    rec.reactions = (msg?.reactions || []).map((r) => {
      const e = r.emoji || {};
      const n = r.count ?? (r.count_details?.normal || 0) + (r.count_details?.burst || 0);
      return `${e.id ? `:${e.name}:` : e.name}×${n}`;
    });
    if (msg?.poll) {
      rec.poll = {
        q: msg.poll.question?.text || '',
        a: (msg.poll.answers || []).map((x) => (x.poll_media || x.pollMedia)?.text || ''),
      };
    }
    return rec;
  }

  function addAttachments(rec, list) {
    for (const a of list) {
      const name = a.filename || a.name || 'file';
      const type = a.content_type || a.contentType || '';
      const url = a.url || a.proxy_url;
      if (type.startsWith('image/') || (!type && /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name))) {
        rec.images.push({ url, name });
      } else {
        rec.files.push({ name, size: a.size });
      }
    }
  }

  // 备用：拿不到 React 数据时，直接从页面上的图片元素取
  function domImages(li) {
    const acc = li.querySelector('[id^="message-accessories-"]');
    if (!acc) return [];
    const seen = new Set();
    const out = [];
    for (const img of acc.querySelectorAll('img')) {
      const src = img.currentSrc || img.src;
      if (!src || String(img.className).includes('emoji') || !src.includes('/attachments/') || seen.has(src)) continue;
      seen.add(src);
      out.push({ url: src, filename: decodeURIComponent(new URL(src).pathname.split('/').pop()), content_type: 'image/' });
    }
    return out;
  }

  // 把渲染好的消息正文转回纯文本（表情图片 → 表情字符或 :名字:，保留代码块、引用、链接）
  function domToText(node) {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) {
        out += n.nodeValue;
        continue;
      }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
      // 跳过“(已编辑)”标记及其中藏的时间，以及只给读屏软件用的隐藏文字
      if (tag === 'TIME' || /edited|timestampInline|hiddenVisually/.test(String(n.className))) continue;
      // 别的服务器的表情有时 alt 只有数字 ID，换成名字
      if (tag === 'IMG') out += /^:\d+:$/.test(n.alt) ? n.getAttribute('aria-label') || n.alt : n.alt || '';
      else if (tag === 'BR') out += '\n';
      else if (tag === 'PRE') out += '\n```\n' + n.textContent.replace(/\n$/, '') + '\n```\n';
      else if (tag === 'CODE') out += '`' + n.textContent + '`';
      else if (tag === 'A') {
        const t = domToText(n).trim();
        const plain = !n.href || t === n.href || n.href.startsWith(t.replace(/…$/, ''));
        // Discord 图片链接后面一长串签名参数没用（过期就失效），去掉省用量
        const h = /(^|\.)discordapp\.(com|net)$/.test(n.hostname) ? n.href.split('?')[0] : n.href;
        out += plain ? h || t : `[${t}](${h})`;
      } else if (tag === 'BLOCKQUOTE') {
        out += domToText(n).trim().split('\n').map((l) => '> ' + l).join('\n') + '\n';
      } else if (tag === 'LI') out += '\n- ' + domToText(n).trim();
      else if (/^H[1-6]$/.test(tag)) out += '\n' + domToText(n).trim() + '\n';
      else out += domToText(n);
    }
    return out;
  }

  // 去掉看不见的特殊字符、行尾空格、多余空行
  const tidy = (s) =>
    s.replace(/[\u200b\u2060\ufeff]/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  // 转发消息只有原始文本，简单处理一下特殊标记
  // nameOf：用户 ID → 显示名（认识的就写名字，不认识写“某人”）
  const cleanRaw = (s, nameOf) =>
    s
      .replace(/<a?:(\w+):\d+>/g, ':$1:')
      .replace(/<@!?(\d+)>/g, (_, id) => '@' + (nameOf?.(id) || '某人'))
      .replace(/<@&\d+>/g, '@某身份组')
      .replace(/<#\d+>/g, '#某频道')
      .replace(/<t:(\d+)(?::\w)?>/g, (_, t) => fmtFull(new Date(t * 1000)));

  // ---------------- 生成 Markdown ----------------
  function render(title, link, st, chId) {
    const recs = [...st.recs.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

    // 连续发言时 Discord 不显示作者栏：沿用上一条的作者
    let prev = null;
    for (const r of recs) {
      if (!r.aid && !r.aname && prev) {
        r.aid = prev.aid;
        r.aname = prev.aname;
      }
      prev = r;
    }

    const key = (r) => r.aid || 'name:' + (r.aname || '?');
    const people = new Map();
    for (const r of recs) {
      const k = key(r);
      if (people.has(k)) continue;
      const u = r.aid && st.users.get(r.aid);
      people.set(k, { name: u ? u.nick || u.name : r.aname || '未知', handle: u?.handle, bot: u?.bot, count: 0 });
    }
    const dup = {};
    for (const p of people.values()) dup[p.name] = (dup[p.name] || 0) + 1;
    for (const p of people.values()) p.label = dup[p.name] > 1 && p.handle ? `${p.name}(@${p.handle})` : p.name;

    const nameOf = (id) => {
      const u = st.users.get(id);
      return people.get(id)?.label || (u && (u.nick || u.name));
    };
    const idx = new Map(recs.map((r, i) => [r.id, i + 1]));
    const width = Math.max(3, String(recs.length).length);
    const images = [];
    const body = [];
    let day = '';

    recs.forEach((r, i) => {
      const n = i + 1;
      const t = snowDate(r.id);
      const p = people.get(key(r));
      p.count++;
      if (ymd(t) !== day) {
        day = ymd(t);
        body.push(`—— ${day} ——`);
      }
      let head = `[${n}] ${hm(t)} ${p.label}`;
      if (r.reply) {
        head += r.reply.id && idx.has(r.reply.id) ? ` ↩#${idx.get(r.reply.id)}` : ` ↩(未导出或已删除：${r.reply.preview || '?'})`;
      }
      const lines = [head];
      if (r.sys) lines.push(`[系统] ${r.sys}`);
      else if (r.text) lines.push(r.text);
      if (r.fwd && r.fwd !== r.text) lines.push(`[转发] ${r.fwd}`);
      r.images.forEach((im, k) => {
        const path = `images/${String(n).padStart(width, '0')}-${k + 1}.${extOf(im)}`;
        images.push({ url: im.url, path });
        lines.push(`🖼 ${path}`);
      });
      for (const f of r.files) lines.push(`📎 ${f.name}${f.size ? ` (${fmtSize(f.size)})` : ''}`);
      for (const e of r.embeds) {
        const s = embedText(e, nameOf);
        if (s) lines.push(s);
      }
      for (const s of r.stickers) lines.push(`[贴纸: ${s}]`);
      if (r.poll) lines.push(`📊 投票：${r.poll.q}｜${r.poll.a.join(' / ')}`);
      if (r.reactions.length) lines.push(`反应：${r.reactions.join(' ')}`);
      body.push(lines.join('\n'), '');
    });

    const tzH = -new Date().getTimezoneOffset() / 60;
    const range = recs.length ? `${ymd(snowDate(recs[0].id))} ~ ${ymd(snowDate(recs[recs.length - 1].id))}` : '';
    const who = [...people.values()]
      .sort((a, b) => b.count - a.count)
      .map((p) => `${p.label}${p.bot ? '[机器人]' : ''} ${p.count}`)
      .join('、');
    const head = [
      `# ${title}`,
      `来源：${link}`,
      // 帖子 ID 里自带创建时间，不用滚到开头也能知道
      ...(chId ? [`发帖时间：${fmtFull(snowDate(chId))}`] : []),
      `导出于 ${fmtFull(new Date())}｜共 ${recs.length} 条｜${range}（UTC${tzH >= 0 ? '+' : ''}${tzH}）`,
      `参与者（发言数）：${who}`,
      // 论坛帖子的第一条消息 ID 就是帖子 ID，据此判断有没有包含开头
      recs[0]?.id === chId ? '范围：从帖子第一条开始。' : '范围：只含导出者浏览过的部分，可能没有帖子开头，中间也可能有跳过的段落。',
      '',
      '> 读法：每条以 [编号] 时间 作者 开头；“↩#5”= 回复第 5 条。🖼 是图片，路径相对本文件，需要看图时再打开；“画面同 xxx”表示和之前那张长得一模一样，不重复附图。:名字: 是服务器自定义表情；“反应”是别人点的表情回应及人数；[卡片] 是机器人发的嵌入内容。',
      '',
    ];
    return { markdown: head.join('\n') + '\n' + body.join('\n'), images };
  }

  function embedText(e, nameOf) {
    if (e.type === 'image' || e.type === 'gifv') return ''; // 图片已单独下载；GIF 链接正文里已有
    if (e.type === 'rich') {
      // 机器人消息的主要内容常在嵌入卡片里，完整保留；里面的 <@ID> 换成人名
      const parts = [e.author, e.title, e.desc, ...e.fields.map(([k, v]) => `${k}: ${v}`)]
        .filter(Boolean)
        .map((s) => cleanRaw(String(s), nameOf));
      return parts.length ? `[卡片] ${parts.join('\n')}${e.url ? '\n' + e.url : ''}` : '';
    }
    // 普通链接预览：链接本身正文里已有，这里只留标题和简短描述
    if (!e.title && !e.desc) return '';
    const desc = e.desc ? ` — ${e.desc.replace(/\s+/g, ' ').slice(0, 100)}` : '';
    return `🔗 预览：${e.site ? e.site + '｜' : ''}${e.title}${desc}`;
  }

  // ---------------- 小工具 ----------------
  function findScroller(ol) {
    for (let e = ol?.parentElement; e && e !== document.body; e = e.parentElement) {
      const oy = getComputedStyle(e).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && e.scrollHeight > e.clientHeight) return e;
    }
    return null;
  }

  function guessTitle(ol, listCount) {
    // 帖子名在网页标题里是带引号的，名字里可能本身就有“ | ”，所以优先取引号里的整段
    const quoted = /"([^"]+)"/.exec(document.title)?.[1];
    const fromDoc = quoted || document.title
      .replace(/^\(\d+\)\s*/, '')
      .replace(/^•\s*/, '')
      .split(/\s+[|\-]\s+/)
      .filter((s) => s && s !== 'Discord')[0]
      ?.replace(/^#/, '');
    if (listCount === 1 && fromDoc) return fromDoc;
    for (let e = ol.parentElement, i = 0; e && e !== document.body && i < 15; e = e.parentElement, i++) {
      const h = [...e.querySelectorAll('h1, h2')].find((x) => !ol.contains(x) && x.textContent.trim());
      if (h) return h.textContent.trim().slice(0, 80);
    }
    return fromDoc || 'Discord帖子';
  }

  function extOf(im) {
    const m =
      /\.([a-z0-9]{2,5})$/i.exec(im.name || '') || /\.([a-z0-9]{2,5})$/i.exec(new URL(im.url, location.href).pathname);
    return m ? m[1].toLowerCase() : 'png';
  }

  // 消息 ID 里本身就编码了发送时间
  const snowDate = (id) => new Date(Number((BigInt(id) >> 22n) + 1420070400000n));
  const p2 = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const hm = (d) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const fmtFull = (d) => `${ymd(d)} ${hm(d)}`;
  const stamp = (d) => `${ymd(d).replace(/-/g, '')}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.ceil(b / 1024) + 'KB');

  function sendToExtension(payload) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const fail = () => resolve({ ok: false, error: '扩展没有响应，试试刷新页面' });
      let timer = setTimeout(fail, 30000);
      const onMsg = (e) => {
        if (e.source !== window) return;
        if (e.data?.type === 'dce-progress') {
          setBtn(e.data.text); // 打包进度；有进度就说明扩展还活着，重新计时
          clearTimeout(timer);
          timer = setTimeout(fail, 30000);
          return;
        }
        if (e.data?.type !== 'dce-export-res' || e.data.id !== id) return;
        window.removeEventListener('message', onMsg);
        clearTimeout(timer);
        resolve(e.data.res);
      };
      window.addEventListener('message', onMsg);
      window.postMessage({ type: 'dce-export-req', id, payload }, location.origin);
    });
  }
})();
