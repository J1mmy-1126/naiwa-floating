/**
 * 奶蛙 · 桌面悬浮窗主进程
 *
 * 职责：
 *  1. 无框透明置顶窗口（悬浮球态 ⇄ 对话面板态）
 *  2. 全局光标轮询 → 推给渲染层驱动眼睛跟随
 *  3. 主进程接管拖拽（光标飞出窗口也不脱手）
 *  4. 大模型 API 代理转发（无 CORS）：一次性 + SSE 流式，429 限流自动重试
 *  5. 能力底座：userData 存储 API / MCP / Skill；MCP stdio 最小 JSON-RPC 客户端
 *  6. 本地历史：userData/naiwa-history.json，图片内容不落地
 *
 * 自检：npx electron . --shot  会自动截取两种形态后退出
 */
const { app, BrowserWindow, ipcMain, screen, Menu, safeStorage } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BALL = { w: 240, h: 312 };   // 悬浮球态窗口尺寸
const PANEL = { w: 434, h: 672 };  // 对话面板态窗口尺寸
const HISTORY_LIMIT = 20;
const HISTORY_MAX_BYTES = 2 * 1024 * 1024;

let win = null;
let dragTimer = null;
let dragOrigin = null;
let pinned = true;

const streams = new Map();    // streamId -> AbortController
const mcpRuntime = new Map(); // serverId -> { child, seq, pending, buf, tools }

function createWindow(opts = {}) {
  const shotMode = !!opts.shot; // 自检截图时用不透明窗口，否则 Windows 下 capturePage 全黑
  win = new BrowserWindow({
    width: BALL.w,   // 注意：BrowserWindow 只认 width/height，展开 {w, h} 会被静默忽略退回默认 800x600
    height: BALL.h,
    frame: false,
    transparent: !shotMode,
    backgroundColor: shotMode ? '#14100a' : '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win.show());
  win.loadFile('frog.html');

  // 全局光标轮询（约 30fps）：眼睛跟随的数据源，蛙会"看"屏幕上任何位置的鼠标
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    win.webContents.send('frog:cursor', { x: p.x, y: p.y, wx: b.x, wy: b.y });
  }, 33);
}

/* ---------- 拖拽：主进程轮询光标移窗，比 CSS drag 更跟手 ----------
   注意：必须用 setBounds 钉住尺寸。Windows 高分屏（如 150% 缩放）下 frameless+transparent
   窗口每次 setPosition 都会因 DIP↔物理像素往返换算膨胀 ~1px，拖几秒窗口就大一圈。 */
let curSize = { ...BALL };
ipcMain.on('frog:drag-start', () => {
  if (dragTimer) return;
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  dragOrigin = { cx: p.x, cy: p.y, wx: b.x, wy: b.y };
  dragTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    win.setBounds({
      x: dragOrigin.wx + p.x - dragOrigin.cx,
      y: dragOrigin.wy + p.y - dragOrigin.cy,
      width: curSize.w,
      height: curSize.h
    });
  }, 16);
});
ipcMain.on('frog:drag-end', () => {
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
});

/* ---------- 球态 ⇄ 面板态：切换尺寸并始终留在可视区内 ---------- */
ipcMain.handle('frog:mode', (e, mode) => {
  const size = mode === 'panel' ? PANEL : BALL;
  curSize = { ...size };
  const b = win.getBounds();
  const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
  const nx = Math.min(Math.max(b.x, wa.x), wa.x + wa.width - size.w);
  const ny = Math.min(Math.max(b.y, wa.y), wa.y + wa.height - size.h);
  win.setBounds({ x: nx, y: ny, width: size.w, height: size.h });
  return true;
});

/* ---------- 置顶开关 ---------- */
ipcMain.handle('frog:pin', (e, on) => {
  pinned = !!on;
  win.setAlwaysOnTop(pinned, 'screen-saver');
  return pinned;
});

/* ---------- 右键菜单 ---------- */
ipcMain.on('frog:menu', () => {
  Menu.buildFromTemplate([
    { label: '展开 / 收起面板', click: () => win.webContents.send('frog:menu-action', 'toggle') },
    { label: '新对话', click: () => win.webContents.send('frog:menu-action', 'new-chat') },
    { type: 'separator' },
    {
      label: '窗口置顶', type: 'checkbox', checked: pinned,
      click: (it) => {
        pinned = it.checked;
        win.setAlwaysOnTop(pinned, 'screen-saver');
        win.webContents.send('frog:menu-action', 'pinned', pinned);
      }
    },
    { type: 'separator' },
    { label: '退出奶蛙', click: () => app.quit() }
  ]).popup({ window: win });
});

/* ---------- 本地资源读取：把 assets 图片转 base64 给渲染层（避免 file:// 污染 canvas） ---------- */
ipcMain.handle('frog:read-asset', (e, name) => {
  const safe = path.basename(String(name || '')); // 只允许取 assets 目录下的文件名，防路径穿越
  const file = path.join(__dirname, 'assets', safe);
  if (!fs.existsSync(file)) throw new Error('资源不存在: ' + safe);
  return fs.readFileSync(file).toString('base64');
});

/* ---------- 大模型 API 代理：主进程直连（无 CORS），429 等待 2.5s 重试一次 ---------- */
function httpError(status, text) {
  let detail = '';
  try {
    const j = JSON.parse(text);
    detail = j.error?.message || j.message || '';
  } catch {}
  const map = {
    401: 'API Key 无效或未授权',
    403: '没有权限调用该模型',
    404: '接口地址或模型名可能有误',
    429: '调用太频繁'
  };
  const err = new Error((map[status] || `HTTP ${status}`) + (detail ? `（${detail}）` : ''));
  err.status = status;
  return err;
}

ipcMain.handle('frog:chat', async (e, { baseUrl, apiKey, payload }) => {
  const call = async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (apiKey || '')
      },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    if (!res.ok) throw httpError(res.status, text);
    return JSON.parse(text);
  };
  try {
    return await call();
  } catch (err) {
    if (err.status !== 429) throw err;
    await new Promise(r => setTimeout(r, 2500));
    return await call();
  }
});

async function pumpSSE(body, send) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let doneSent = false;
  const handleData = (data) => {
    if (data === '[DONE]') {
      if (!doneSent) { doneSent = true; send({ done: true }); }
      return;
    }
    let j;
    try { j = JSON.parse(data); } catch { return; }
    const delta = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content ?? '';
    if (delta) send({ delta });
    if (j.usage) send({ usage: j.usage });
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      handleData(line.slice(5).trim());
      if (doneSent) return;
    }
  }
  buf += decoder.decode();
  buf.split('\n').forEach(line => {
    line = line.replace(/\r$/, '');
    if (line.startsWith('data:')) handleData(line.slice(5).trim());
  });
  if (!doneSent) send({ done: true });
}

ipcMain.handle('frog:chat-stream', (e, { id, baseUrl, apiKey, payload }) => {
  const streamId = String(id || `s${Date.now()}`);
  const sender = e.sender;
  const ctrl = new AbortController();
  streams.set(streamId, ctrl);
  const send = (obj) => {
    if (!sender.isDestroyed()) sender.send('frog:stream-chunk', { id: streamId, ...obj });
  };

  (async () => {
    try {
      const call = () => fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (apiKey || '')
        },
        body: JSON.stringify({ ...payload, stream: true }),
        signal: ctrl.signal
      });
      let res = await call();
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 2500));
        res = await call();
      }
      if (!res.ok) throw httpError(res.status, await res.text());
      const ct = res.headers.get('content-type') || '';
      if (res.body && (ct.includes('text/event-stream') || ct.includes('stream'))) {
        await pumpSSE(res.body, send);
      } else {
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content;
        send({ delta: typeof content === 'string' ? content : JSON.stringify(content || '') });
        send({ done: true, usage: data.usage || null });
      }
    } catch (err) {
      if (ctrl.signal.aborted) send({ error: '已停止生成', aborted: true, done: true });
      else send({ error: err.message || String(err), done: true });
    } finally {
      streams.delete(streamId);
    }
  })();

  return { id: streamId };
});

ipcMain.handle('frog:stream-abort', (e, id) => {
  const ctrl = streams.get(String(id));
  if (!ctrl) return false;
  ctrl.abort();
  return true;
});

/* ---------- 能力存储：API / MCP / Skill ---------- */
function capsFile() { return path.join(app.getPath('userData'), 'naiwa-capabilities.json'); }
function historyFile() { return path.join(app.getPath('userData'), 'naiwa-history.json'); }
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}
function defaultCaps() {
  return {
    version: 1, apis: [], activeApiId: null, mcps: [], skills: [],
    persona: '', route: { chat: '', code: '', vision: '' },
    localTools: { enabled: false, roots: [os.homedir()], autoRead: true } // 默认白名单：用户主目录（不硬编码任何个人路径）
  };
}
function normalizeCaps(c) {
  const d = defaultCaps();
  return {
    version: 1,
    apis: Array.isArray(c?.apis) ? c.apis : d.apis,
    activeApiId: c?.activeApiId || null,
    mcps: Array.isArray(c?.mcps) ? c.mcps : d.mcps,
    skills: Array.isArray(c?.skills) ? c.skills : d.skills,
    persona: typeof c?.persona === 'string' ? c.persona : '',
    route: {
      chat: typeof c?.route?.chat === 'string' ? c.route.chat : '',
      code: typeof c?.route?.code === 'string' ? c.route.code : '',
      vision: typeof c?.route?.vision === 'string' ? c.route.vision : ''
    },
    localTools: {
      enabled: !!c?.localTools?.enabled,
      roots: Array.isArray(c?.localTools?.roots) && c.localTools.roots.length
        ? c.localTools.roots.map(String) : d.localTools.roots,
      autoRead: c?.localTools?.autoRead !== false
    }
  };
}

/* API Key 静态加密：Windows 走 DPAPI（safeStorage），文件被拷走也无法直接读出明文 */
function sealKey(k) {
  if (!k) return k;
  try {
    if (safeStorage.isEncryptionAvailable()) return 'enc1:' + safeStorage.encryptString(String(k)).toString('base64');
  } catch {}
  return String(k); // 不可加密时原样存储（README 有说明）
}
function openKey(k) {
  if (typeof k !== 'string' || !k.startsWith('enc1:')) return k || '';
  try { return safeStorage.decryptString(Buffer.from(k.slice(5), 'base64')); }
  catch { return ''; } // 解密失败（换了系统用户等）按空处理，让用户重填
}
ipcMain.handle('frog:caps-load', () => {
  const raw = readJson(capsFile(), defaultCaps());
  if (Array.isArray(raw?.apis)) raw.apis = raw.apis.map(a => ({ ...a, apiKey: openKey(a?.apiKey) }));
  return normalizeCaps(raw);
});
ipcMain.handle('frog:caps-save', (e, caps) => {
  const clean = normalizeCaps(caps);
  clean.apis = clean.apis.map(a => ({ ...a, apiKey: sealKey(a.apiKey) }));
  writeJson(capsFile(), clean);
  clean.apis = clean.apis.map(a => ({ ...a, apiKey: openKey(a.apiKey) })); // 回传渲染层仍是明文，保持内存态一致
  return clean;
});

/* ---------- 本地工具：白名单目录内的文件操作与 PowerShell 命令（渲染层先弹用户确认） ---------- */
const LOCAL_READ_MAX = 64 * 1024;
const LOCAL_OUT_MAX = 32 * 1024;
function localRoots(lt) {
  const arr = Array.isArray(lt?.roots) && lt.roots.length ? lt.roots : defaultCaps().localTools.roots;
  return arr.map(r => path.resolve(String(r)));
}
function assertInRoots(p, roots) {
  const rp = path.resolve(String(p || ''));
  const ok = roots.some(r => rp === r || rp.startsWith(r + path.sep));
  if (!ok) throw new Error('路径不在白名单内：' + rp);
  return rp;
}
function clipText(s, max) {
  s = String(s || '');
  return s.length > max ? s.slice(0, max) + `\n…（已截断，共 ${s.length} 字）` : s;
}
ipcMain.handle('frog:local-call', async (e, { name, args }) => {
  const lt = normalizeCaps(readJson(capsFile(), defaultCaps())).localTools;
  if (!lt?.enabled) throw new Error('本地工具未启用，请在能力配置中开启');
  const roots = localRoots(lt);
  const a = args || {};
  switch (name) {
    case 'local_list_dir': {
      const dir = assertInRoots(a.path || roots[0], roots);
      const items = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 200)
        .map(d => (d.isDirectory() ? '[目录] ' : '[文件] ') + d.name);
      return { dir, count: items.length, items: items.join('\n') };
    }
    case 'local_read_file': {
      const fp = assertInRoots(a.path, roots);
      const st = fs.statSync(fp);
      if (st.size > 8 * 1024 * 1024) throw new Error('文件过大（>8MB），请换更小的文件或指定片段');
      const text = fs.readFileSync(fp).toString('utf8');
      const max = Math.min(+a.maxBytes || LOCAL_READ_MAX, LOCAL_READ_MAX);
      return { path: fp, bytes: st.size, content: clipText(text, max) };
    }
    case 'local_write_file': {
      const fp = assertInRoots(a.path, roots);
      const content = String(a.content ?? '');
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content, 'utf8');
      return { path: fp, bytes: Buffer.byteLength(content) };
    }
    case 'local_run_command': {
      const cmd = String(a.command || '').trim();
      if (!cmd) throw new Error('命令为空');
      const cwd = a.cwd ? assertInRoots(a.cwd, roots) : roots[0];
      const timeoutMs = Math.min(Math.max(+a.timeoutMs || 30000, 1000), 120000);
      return await new Promise((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { cwd });
        let out = '', err = '';
        const timer = setTimeout(() => {
          try { child.kill(); } catch {}
          reject(new Error(`命令超时（${timeoutMs / 1000}s），已终止`));
        }, timeoutMs);
        child.stdout.on('data', d => { if (out.length < LOCAL_OUT_MAX) out += d.toString('utf8'); });
        child.stderr.on('data', d => { if (err.length < LOCAL_OUT_MAX) err += d.toString('utf8'); });
        child.on('error', e2 => { clearTimeout(timer); reject(e2); });
        child.on('close', code => {
          clearTimeout(timer);
          resolve({ cwd, exitCode: code, stdout: clipText(out, LOCAL_OUT_MAX), stderr: clipText(err, LOCAL_OUT_MAX) });
        });
      });
    }
    default:
      throw new Error('未知本地工具：' + name);
  }
});

/* ---------- 本地历史：只存文字与摘要，图片内容不落地 ---------- */
function cleanHistoryMessages(messages) {
  const arr = Array.isArray(messages) ? messages.slice(-HISTORY_LIMIT) : [];
  return arr.map(m => {
    let content = m?.content;
    if (Array.isArray(content)) {
      const text = content.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n');
      const hasImg = content.some(p => p && p.type === 'image_url');
      content = text + (hasImg ? (text ? '\n' : '') + '[图片已省略]' : '');
    }
    return {
      role: m?.role === 'assistant' ? 'assistant' : 'user',
      content: String(content || ''),
      ts: m?.ts || Date.now()
    };
  });
}
ipcMain.handle('frog:history-load', () => readJson(historyFile(), null));
ipcMain.handle('frog:history-save', (e, session) => {
  const clean = {
    version: 1,
    session: {
      id: String(session?.id || 's' + Date.now()),
      createdAt: session?.createdAt || Date.now(),
      mode: ['chat', 'code', 'vision'].includes(session?.mode) ? session.mode : 'chat',
      summary: session?.summary ? String(session.summary).slice(0, 1200) : null,
      messages: cleanHistoryMessages(session?.messages)
    }
  };
  let text = JSON.stringify(clean);
  while (text.length > HISTORY_MAX_BYTES && clean.session.messages.length > 1) {
    clean.session.messages.shift();
    text = JSON.stringify(clean);
  }
  writeJson(historyFile(), clean);
  return true;
});
ipcMain.handle('frog:history-clear', () => {
  try { fs.unlinkSync(historyFile()); } catch {}
  return true;
});

/* ---------- MCP stdio 最小客户端：用户显式添加 command/args 后才可连接 ---------- */
function mcpSend(rt, msg) {
  rt.child.stdin.write(JSON.stringify(msg) + '\n');
}
function mcpRequest(rt, method, params, timeout = 10000) {
  const id = ++rt.seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rt.pending.delete(id);
      reject(new Error(method + ' 超时'));
    }, timeout);
    rt.pending.set(id, { resolve, reject, timer });
    mcpSend(rt, { jsonrpc: '2.0', id, method, params });
  });
}
async function mcpEnsure(server) {
  let rt = mcpRuntime.get(server.id);
  if (rt && !rt.child.killed) return rt;

  const args = Array.isArray(server.args) ? server.args : [];
  const winNpx = process.platform === 'win32' && /^npx(\.cmd)?$/i.test(String(server.command || ''));
  const child = winNpx
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', server.command, ...args])
    : spawn(String(server.command || ''), args, { shell: false });

  rt = { child, seq: 0, pending: new Map(), buf: '', tools: [] };
  child.stdout.on('data', d => {
    rt.buf += d.toString('utf8');
    let idx;
    while ((idx = rt.buf.indexOf('\n')) >= 0) {
      const line = rt.buf.slice(0, idx).replace(/\r$/, '');
      rt.buf = rt.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id && rt.pending.has(msg.id)) {
        const p = rt.pending.get(msg.id);
        rt.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  });
  child.stderr.on('data', () => {});
  child.on('error', err => {
    for (const p of rt.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    rt.pending.clear();
    mcpRuntime.delete(server.id);
  });
  child.on('exit', () => {
    for (const p of rt.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('MCP 进程已退出'));
    }
    rt.pending.clear();
    mcpRuntime.delete(server.id);
  });

  try {
    mcpRuntime.set(server.id, rt);
    await mcpRequest(rt, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'naiwa-floating', version: '1.0.0' }
    });
    mcpSend(rt, { jsonrpc: '2.0', method: 'notifications/initialized' });
    const res = await mcpRequest(rt, 'tools/list', {});
    rt.tools = Array.isArray(res?.tools) ? res.tools : [];
    return rt;
  } catch (err) {
    try { child.kill(); } catch {}
    mcpRuntime.delete(server.id);
    throw err;
  }
}
function loadMcpServer(id) {
  const caps = normalizeCaps(readJson(capsFile(), defaultCaps()));
  const server = caps.mcps.find(s => s.id === id);
  if (!server) throw new Error('MCP 服务器不存在');
  return { caps, server };
}
ipcMain.handle('frog:mcp-refresh', async (e, id) => {
  const { caps, server } = loadMcpServer(String(id));
  try {
    const rt = await mcpEnsure(server);
    server.status = 'connected';
    server.lastError = null;
    server.tools = rt.tools.map(t => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object' }
    }));
  } catch (err) {
    server.status = 'error';
    server.lastError = err.message || String(err);
  }
  writeJson(capsFile(), caps);
  if (server.status !== 'connected') throw new Error(server.lastError);
  return server;
});
ipcMain.handle('frog:mcp-call', async (e, { serverId, name, args }) => {
  const { server } = loadMcpServer(String(serverId));
  const rt = await mcpEnsure(server);
  return await mcpRequest(rt, 'tools/call', { name: String(name), arguments: args || {} }, 20000);
});
ipcMain.handle('frog:mcp-stop', (e, id) => {
  const rt = mcpRuntime.get(String(id));
  if (rt) {
    try { rt.child.kill(); } catch {}
    mcpRuntime.delete(String(id));
  }
  return true;
});

/* ---------- 自检截图模式：--shot 等青蛙管道就绪后截取两种形态 ---------- */
if (process.argv.includes('--shot')) {
  app.whenReady().then(() => {
    const shot1 = path.join(os.tmpdir(), 'naiwa-ball.png');
    const shot2 = path.join(os.tmpdir(), 'naiwa-panel.png');
    const waitFrogReady = async () => {
      for (let i = 0; i < 40; i++) { // 最多等 10s，慢机/缓存被占也能截到
        try {
          const v = await win.webContents.executeJavaScript("document.body.dataset.frogReady || ''");
          if (v) return v;
        } catch {}
        await new Promise(r => setTimeout(r, 250));
      }
      return '';
    };
    setTimeout(async () => {
      try {
        await waitFrogReady();
        await new Promise(r => setTimeout(r, 300)); // 等首帧合成
        fs.writeFileSync(shot1, (await win.webContents.capturePage()).toPNG());
        win.webContents.send('frog:menu-action', 'toggle');
        setTimeout(async () => {
          fs.writeFileSync(shot2, (await win.webContents.capturePage()).toPNG());
          app.quit();
        }, 2000);
      } catch (err) {
        console.error('截图失败:', err);
        app.quit();
      }
    }, 1500);
  });
}

/* ---------- 自检：--shot-run 触发奔跑动作，每秒截一帧（验证动作动画尺寸/是否异常放大） ---------- */
if (process.argv.includes('--shot-run')) {
  app.whenReady().then(() => {
    const waitFrogReady = async () => {
      for (let i = 0; i < 40; i++) {
        try {
          const v = await win.webContents.executeJavaScript("document.body.dataset.frogReady || ''");
          if (v) return v;
        } catch {}
        await new Promise(r => setTimeout(r, 250));
      }
      return '';
    };
    setTimeout(async () => {
      try {
        await waitFrogReady();
        await win.webContents.executeJavaScript(`(async () => {
          if (typeof ensureAction === 'function') ensureAction('run'); // 动作素材已改懒加载，先预热
          for (let i = 0; i < 40 && !actionSrc.run; i++) await new Promise(r => setTimeout(r, 100));
          showAction('run');
        })()`);
        for (let i = 0; i < 4; i++) {
          await new Promise(r => setTimeout(r, 1000));
          fs.writeFileSync(path.join(os.tmpdir(), `naiwa-run-t${i}.png`), (await win.webContents.capturePage()).toPNG());
          const cls = await win.webContents.executeJavaScript("document.body.className + '|' + (document.body.dataset.mode||'')");
          console.log(`[shot-run] t${i} bounds=${JSON.stringify(win.getBounds())} body=${cls}`);
        }
        app.quit();
      } catch (err) {
        console.error('截图失败:', err);
        app.quit();
      }
    }, 1500);
  });
}

/* ---------- 临时诊断：--shot-drag 静止光标下启动拖拽定时器，观察窗口尺寸是否漂移 ---------- */
if (process.argv.includes('--shot-drag')) {
  app.whenReady().then(() => {
    setTimeout(async () => {
      try {
        console.log('[shot-drag] t0 bounds=' + JSON.stringify(win.getBounds()));
        await win.webContents.executeJavaScript('frogAPI.dragStart()');
        for (let i = 1; i <= 10; i++) {
          await new Promise(r => setTimeout(r, 500));
          console.log(`[shot-drag] t${i} bounds=` + JSON.stringify(win.getBounds()));
        }
        await win.webContents.executeJavaScript('frogAPI.dragEnd()');
        app.quit();
      } catch (err) {
        console.error('诊断失败:', err);
        app.quit();
      }
    }, 2500);
  });
}

app.whenReady().then(() => createWindow({ shot: process.argv.includes('--shot') || process.argv.includes('--shot-run') }));
app.on('window-all-closed', () => {
  for (const rt of mcpRuntime.values()) {
    try { rt.child.kill(); } catch {}
  }
  app.quit();
});
