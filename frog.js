/* ===================== 工具 ===================== */
const $ = id => document.getElementById(id);

/* ===================== 奶蛙形象：原版立绘 + 抠底 + 3D 眼修复 + 瞳孔分层跟随 ===================== */
const IMG_SRC = 'naiwa-src.png'; // 用户提供的设计素材（3D 渲染小黄蛙）

function buildFrogStage(container, uid) {
  container.innerHTML = `
    <div class="frog-stage">
      <img class="body-img" draggable="false" alt="奶蛙">
      <svg class="frog-eyes" id="eyes-${uid}"></svg>
    </div>`;
}

function eyesSVG(g, uid) {
  const lid = -(g.iris.r * 2 + 12); // 眼皮平时藏在眼眶 clip 上方
  return `<defs>
      <clipPath id="iris-${uid}"><circle cx="${g.iris.cx}" cy="${g.iris.cy}" r="${g.iris.r}"/></clipPath>
      <clipPath id="lidc-${uid}"><circle cx="${g.iris.cx}" cy="${g.iris.cy}" r="${g.iris.r + 3}"/></clipPath>
    </defs>
    <g clip-path="url(#iris-${uid})">
      <image class="pupil" href="${g.pupilURL}" x="${g.pupil.cx - g.pupil.r}" y="${g.pupil.cy - g.pupil.r}" width="${g.pupil.r * 2}" height="${g.pupil.r * 2}"/>
    </g>
    <g clip-path="url(#lidc-${uid})">
      <ellipse class="eyelid" style="--lid:${lid}px" cx="${g.iris.cx}" cy="${g.iris.cy}" rx="${g.iris.r + 2.5}" ry="${g.iris.r + 3.5}" fill="#E7CF7A" stroke="rgba(118,88,28,.5)" stroke-width="2.5"/>
    </g>
    <circle class="eye-anchor" cx="${g.iris.cx}" cy="${g.iris.cy}" r="1" fill="none"/>`;
}

async function prepareNaiwa() {
  const b64 = await frogAPI.readAsset(IMG_SRC); // 主进程转 base64，避免 file:// 污染 canvas
  const img = await new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = 'data:image/png;base64,' + b64;
  });

  const W = img.naturalWidth, H = img.naturalHeight;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const frame = ctx.getImageData(0, 0, W, H);
  const px = frame.data, n = W * H;

  /* --- 1. flood fill 标记背景连通区：透明像素、近白像素、中性色阴影（R≈G≈B），身体饱和黄不受影响 --- */
  const bg = new Uint8Array(n);
  const isBG = i => {
    const p = i * 4;
    if (px[p + 3] < 10) return true;
    const r = px[p], g = px[p + 1], b = px[p + 2];
    if (r > 246 && g > 246 && b > 246) return true;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return mx - mn < 32 && mn > 200; // 地面软阴影（含偏暖灰阶）
  };
  const stack = [];
  const seed = i => { if (!bg[i] && isBG(i)) { bg[i] = 1; stack.push(i); } };
  for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
  while (stack.length) {
    const i = stack.pop(), x = i % W;
    if (x > 0) seed(i - 1);
    if (x < W - 1) seed(i + 1);
    if (i >= W) seed(i - W);
    if (i < n - W) seed(i + W);
  }

  /* --- 2. 眼睛检测（提前执行：虹膜区域设为保护区，避免封闭背景补全时误抠眼白/高光） --- */
  let iris = null, pupil = null, guard = null;
  {
    const bI = { x0: 1e9, y0: 1e9, x1: -1, y1: -1 }, bP = { x0: 1e9, y0: 1e9, x1: -1, y1: -1 };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, p = i * 4;
      if (px[p + 3] < 200) continue;
      if (px[p + 1] > 100 && px[p + 1] - px[p] > 30 && px[p + 1] - px[p + 2] > 20 && px[p] < 150) {
        if (x < bI.x0) bI.x0 = x; if (x > bI.x1) bI.x1 = x;
        if (y < bI.y0) bI.y0 = y; if (y > bI.y1) bI.y1 = y;
      }
    }
    if (bI.x1 > 0) {
      guard = { x0: bI.x0 - 6, y0: bI.y0 - 6, x1: bI.x1 + 6, y1: bI.y1 + 6 };
      const icx = (bI.x0 + bI.x1) / 2, icy = (bI.y0 + bI.y1) / 2;
      iris = { cx: icx, cy: icy, r: ((bI.x1 - bI.x0) + (bI.y1 - bI.y0)) / 4 + .5 };
      for (let y = bI.y0; y <= bI.y1; y++) for (let x = bI.x0; x <= bI.x1; x++) {
        const p = (y * W + x) * 4;
        if (px[p] < 90 && px[p + 1] < 90 && px[p + 2] < 90) {
          if (x < bP.x0) bP.x0 = x; if (x > bP.x1) bP.x1 = x;
          if (y < bP.y0) bP.y0 = y; if (y > bP.y1) bP.y1 = y;
        }
      }
      if (bP.x1 > 0) {
        pupil = { cx: (bP.x0 + bP.x1) / 2, cy: (bP.y0 + bP.y1) / 2, r: ((bP.x1 - bP.x0) + (bP.y1 - bP.y0)) / 4 + 2.5 };
      }
    }
  }
  if (!guard) guard = { x0: 105, y0: 25, x1: 150, y1: 65 }; // 眼部实测区域（检测失败时的保护圈）

  /* --- 3. 封闭背景补全：两腿之间等 flood fill 不可达的背景色区域，按 isBG 全图补标 --- */
  const inGuard = (x, y) => x >= guard.x0 && x <= guard.x1 && y >= guard.y0 && y <= guard.y1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (bg[i] || inGuard(x, y)) continue;
    if (isBG(i)) bg[i] = 1;
  }

  /* --- 4. 背景区亮度→alpha 映射：纯白全透，地面软阴影转柔和半透明灰影（低封顶避免实心灰块） --- */
  for (let i = 0; i < n; i++) {
    if (!bg[i]) continue;
    const p = i * 4;
    if (px[p + 3] < 10) continue;
    const v = Math.min(px[p], px[p + 1], px[p + 2]);
    px[p + 3] = Math.max(0, Math.min(90, (252 - v) * 3.2));
    if (px[p + 3] > 0) { // 阴影中性灰化，避免偏色
      const g = (px[p] + px[p + 1] + px[p + 2]) / 3;
      px[p] = px[p + 1] = px[p + 2] = g;
    }
  }
  /* 与背景相邻的前景抗锯齿过渡像素：按亮度渐变 alpha，消除白边 */
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (bg[i]) continue;
    const p = i * 4;
    const v = Math.min(px[p], px[p + 1], px[p + 2]);
    if (v <= 240 || px[p + 3] < 10) continue;
    const nearBG = (x > 0 && bg[i - 1]) || (x < W - 1 && bg[i + 1]) || (y > 0 && bg[i - W]) || (y < H - 1 && bg[i + W]);
    if (nearBG) px[p + 3] = Math.min(px[p + 3], Math.max(0, Math.min(90, (252 - v) * 3.2)));
  }

  /* --- 3. 内容包围盒（含阴影） --- */
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (px[(y * W + x) * 4 + 3] > 8) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error('素材解析失败');

  if (!iris || !pupil) { iris = { cx: 127, cy: 44, r: 9.5 }; pupil = { cx: 127, cy: 44, r: 6.5 }; } // 眼部检测失败兜底（实测坐标）

  /* --- 5. 瞳孔修补：底图上的瞳孔用虹膜径向色填充（瞳孔移走后不留黑洞） --- */
  {
    const pr = pupil.r;
    const sample = (sx, sy) => {
      let r = 0, g = 0, b = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = Math.round(sx) + dx, yy = Math.round(sy) + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const p = (yy * W + xx) * 4;
        r += px[p]; g += px[p + 1]; b += px[p + 2]; c++;
      }
      return c ? [r / c, g / c, b / c] : [120, 170, 70];
    };
    for (let dy = -pr - 1; dy <= pr + 1; dy++) for (let dx = -pr - 1; dx <= pr + 1; dx++) {
      if (dx * dx + dy * dy > (pr + 1) * (pr + 1)) continue;
      const x = Math.round(pupil.cx + dx), y = Math.round(pupil.cy + dy);
      const d = Math.hypot(dx, dy) || 1;
      const s = sample(pupil.cx + dx / d * (pr + 3.5), pupil.cy + dy / d * (pr + 3.5));
      const p = (y * W + x) * 4;
      px[p] = s[0]; px[p + 1] = s[1]; px[p + 2] = s[2];
    }
  }

  /* --- 6. 瞳孔 sprite：从原像素抠圆形（含高光），圆缘 1px 渐变 --- */
  const pr = Math.ceil(pupil.r) + 1;
  const spCv = document.createElement('canvas');
  spCv.width = spCv.height = pr * 2;
  const spCtx = spCv.getContext('2d', { willReadFrequently: true });
  spCtx.drawImage(cv, Math.round(pupil.cx) - pr, Math.round(pupil.cy) - pr, pr * 2, pr * 2, 0, 0, pr * 2, pr * 2);
  const spFrame = spCtx.getImageData(0, 0, pr * 2, pr * 2);
  for (let y = 0; y < pr * 2; y++) for (let x = 0; x < pr * 2; x++) {
    const d = Math.hypot(x - pr + .5, y - pr + .5);
    const p = (y * pr * 2 + x) * 4;
    if (d > pr) spFrame.data[p + 3] = 0;
    else if (d > pr - 1) spFrame.data[p + 3] *= pr - d;
  }
  spCtx.putImageData(spFrame, 0, 0);

  /* --- 7. 裁剪底图输出，坐标转内容坐标系 --- */
  ctx.putImageData(frame, 0, 0);
  const cut = document.createElement('canvas');
  cut.width = x1 - x0 + 1; cut.height = y1 - y0 + 1;
  cut.getContext('2d').drawImage(cv, -x0, -y0);
  iris.cx -= x0; iris.cy -= y0;
  pupil.cx -= x0; pupil.cy -= y0;

  return {
    url: cut.toDataURL('image/png'),
    pupilURL: spCv.toDataURL('image/png'),
    iris, pupil,
    W: cut.width, H: cut.height
  };
}

/* 构建球态 + 面板 mini 两个实例 */
buildFrogStage($('ballFrog'), 'b');
buildFrogStage($('miniFrog'), 'm');
prepareNaiwa().then(g => {
  document.querySelectorAll('.frog-stage').forEach(s => s.style.setProperty('--ar', `${g.W} / ${g.H}`));
  document.querySelectorAll('.frog-stage .body-img').forEach(im => { im.src = g.url; });
  document.querySelectorAll('.frog-stage .frog-eyes').forEach((el, idx) => {
    el.setAttribute('viewBox', `0 0 ${g.W} ${g.H}`);
    el.innerHTML = eyesSVG(g, idx ? 'm' : 'b');
  });
  document.body.dataset.frogReady = '1'; // 供 --shot 自检等待就绪信号
}).catch(err => {
  console.error('奶蛙素材管道失败:', err);
  document.body.dataset.frogReady = 'err';
});

/* ===================== 眼睛跟随鼠标（全局光标驱动） ===================== */
let mode = 'ball';
let pupilTgt = { x: 0, y: 0 }, pupilCur = { x: 0, y: 0 };
const MAX_OFF = 2.5; // 瞳孔在虹膜内的最大位移（素材内容像素单位，3D 单眼幅度宜小）

frogAPI.onCursor(({ x, y, wx, wy }) => {
  const root = mode === 'ball' ? $('ballFrog') : $('miniFrog');
  const anchor = root.querySelector('.eye-anchor');
  if (!anchor) return;
  const r = anchor.getBoundingClientRect();
  const cx = wx + r.left, cy = wy + r.top; // eye-anchor 屏幕坐标 = 窗口位置 + 页面内位置
  let dx = x - cx, dy = y - cy;
  const d = Math.hypot(dx, dy) || 1;
  const k = Math.min(d / 160, 1) * MAX_OFF; // 越近看得越轻，越远转得越满
  pupilTgt = { x: dx / d * k, y: dy / d * k };
  wakeEyes();
});

/* 眼睛跟随：rAF 收敛后自动休眠、由光标事件唤醒，避免常驻 60fps 空转 */
let eyeRAF = null;
function eyeFrame() {
  eyeRAF = null;
  const dx = pupilTgt.x - pupilCur.x, dy = pupilTgt.y - pupilCur.y;
  if (Math.abs(dx) < 0.02 && Math.abs(dy) < 0.02) {
    pupilCur.x = pupilTgt.x; pupilCur.y = pupilTgt.y;
    return;
  }
  pupilCur.x += dx * 0.16;
  pupilCur.y += dy * 0.16;
  const t = `translate(${pupilCur.x.toFixed(2)}px, ${pupilCur.y.toFixed(2)}px)`;
  document.querySelectorAll('.pupil').forEach(p => { p.style.transform = t; });
  eyeRAF = requestAnimationFrame(eyeFrame);
}
function wakeEyes() { if (!eyeRAF) eyeRAF = requestAnimationFrame(eyeFrame); }

/* 眨眼：随机间隔，偶发连眨两下；时长与 lidBlink 动画（340ms）同步 */
(function scheduleBlink() {
  setTimeout(() => {
    document.body.classList.add('blink');
    setTimeout(() => {
      document.body.classList.remove('blink');
      if (Math.random() < 0.22) {
        setTimeout(() => {
          document.body.classList.add('blink');
          setTimeout(() => document.body.classList.remove('blink'), 340);
        }, 240);
      }
      scheduleBlink();
    }, 340);
  }, 2600 + Math.random() * 3400);
})();

/* ===================== 动作动画：拖动奔跑（带背景 GIF）/ 长按大笑（透明底 WebP） =====================
   内存策略：首次触发才读素材（懒加载），隐藏时清空 src 释放解码后的帧内存 */
const actionGif = $('actionGif');
const actionSrc = { run: null, laugh: null };
const actionLoading = {};
const ACTION_FILES = { run: ['naiwa-run.gif', 'image/gif'], laugh: ['naiwa-laugh.webp', 'image/webp'] };
function ensureAction(kind) {
  if (actionSrc[kind]) return Promise.resolve();
  if (!actionLoading[kind]) {
    actionLoading[kind] = frogAPI.readAsset(ACTION_FILES[kind][0])
      .then(b64 => { actionSrc[kind] = `data:${ACTION_FILES[kind][1]};base64,` + b64; })
      .catch(() => {});
  }
  return actionLoading[kind];
}
async function showAction(kind) {
  if (actionGif.dataset.kind === kind) return;
  await ensureAction(kind);
  if (!actionSrc[kind]) return;
  actionGif.src = actionSrc[kind];
  actionGif.dataset.kind = kind;
  document.body.classList.add('acting');
}
function hideAction() {
  document.body.classList.remove('acting');
  actionGif.dataset.kind = '';
  actionGif.removeAttribute('src'); // 释放动画帧解码内存
}

/* ===================== 拖拽 + 单击展开（球态整窗可拖，位移小视为点击） ===================== */
let downInfo = null;
let lpTimer = null;
const ballLayer = $('ballLayer');
ballLayer.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  downInfo = { x: e.screenX, y: e.screenY, t: Date.now() };
  ensureAction('run'); ensureAction('laugh'); // 预热素材，600ms 动作窗口内即可播放
  frogAPI.dragStart();
  document.body.classList.add('dragging');
  clearTimeout(lpTimer);
  lpTimer = setTimeout(() => {
    // 按住 600ms 没拖动 → 捧腹大笑；一旦开跑由 mousemove 切换成奔跑
    if (downInfo && actionGif.dataset.kind !== 'run') showAction('laugh');
  }, 600);
});
window.addEventListener('mousemove', e => {
  if (!downInfo) return;
  const moved = Math.hypot(e.screenX - downInfo.x, e.screenY - downInfo.y);
  if (moved > 8) {
    clearTimeout(lpTimer);
    showAction('run');
  }
});
window.addEventListener('mouseup', e => {
  if (!downInfo) return;
  frogAPI.dragEnd();
  document.body.classList.remove('dragging');
  clearTimeout(lpTimer); lpTimer = null;
  hideAction();
  const moved = Math.hypot(e.screenX - downInfo.x, e.screenY - downInfo.y);
  const dt = Date.now() - downInfo.t;
  downInfo = null;
  if (moved < 6 && dt < 600) setMode('panel');
});
window.addEventListener('contextmenu', e => {
  e.preventDefault();
  frogAPI.openMenu();
});

/* ===================== 形态切换 ===================== */
async function setMode(m) {
  mode = m;
  document.body.dataset.mode = m;
  await frogAPI.setMode(m);
  if (m === 'panel') setTimeout(() => $('questionInput').focus(), 120);
}
$('btnCollapse').addEventListener('click', () => setMode('ball'));
$('miniFrog').addEventListener('click', () => setMode('ball'));

/* Agent 模式：只改 system prompt 与输入组装，不改外观 */
function setAgentMode(m, toast = true) {
  if (!MODES[m]) return;
  state.mode = m;
  document.querySelectorAll('.mode-chip').forEach(c => c.classList.toggle('on', c.dataset.mode === m));
  if (toast) showToast(`奶蛙已切换到 ${m.toUpperCase()} 模式`);
  persistSession();
}
document.querySelectorAll('.mode-chip').forEach(chip =>
  chip.addEventListener('click', () => setAgentMode(chip.dataset.mode))
);

/* 流式 chunk 分发：渲染层按 id 归并 */
frogAPI.onStreamChunk(({ id, delta, done, error, aborted }) => {
  const h = streamHandlers.get(id);
  if (!h) return;
  if (done || error) streamHandlers.delete(id);
  h({ delta, done, error, aborted });
});

/* 右键菜单动作 */
frogAPI.onMenuAction((action, val) => {
  if (action === 'toggle') setMode(mode === 'ball' ? 'panel' : 'ball');
  else if (action === 'new-chat') newChat();
  else if (action === 'pinned') showToast(val ? '奶蛙已置顶' : '已取消置顶');
});

/* ===================== 状态与配置（localStorage key 沿用旧版，配置无缝继承） ===================== */
const STORAGE_KEY = 'guanxiangtai.config.v1';
const VOICE_KEY = 'guanxiangtai.voice.v1';
const PROVIDERS = {
  custom: { baseUrl: '', model: '' },
  deepseek: { baseUrl: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4.6v-flash' },
  dashscope: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-vl-plus' }
};
const MODES = {
  chat: { prompt: '日常对话模式：回答简洁、准确、友好。' },
  code: { prompt: '代码任务模式：先复述目标，再给最小可行步骤；涉及代码时优先给可直接运行的补丁/命令，并标注风险。' },
  vision: { prompt: '视觉分析模式：用户可能放图；先描述关键证据，再给结论；没有图片时正常文字回答，不要索要图片。' }
};
const state = {
  image: null, config: null, busy: false, history: [],
  summary: null, sessionId: 's' + Date.now(), createdAt: Date.now(),
  mode: 'chat', streamId: null, autoTools: true
};
let caps = { apis: [], activeApiId: null, mcps: [], skills: [], localTools: { enabled: false, roots: [], autoRead: true }, persona: '', route: { chat: '', code: '', vision: '' } };
const streamHandlers = new Map();

function uid(prefix) {
  return (window.crypto && crypto.randomUUID) ? prefix + crypto.randomUUID() : prefix + Date.now() + Math.random().toString(16).slice(2);
}
/* 模型路由：优先当前模式绑定的 API，其次全局选中的 API；不再回退旧配置，避免删除 API 后旧 Key 复活 */
function activeApi() {
  const byMode = caps.route?.[state.mode];
  const a = (byMode && caps.apis.find(x => x.id === byMode))
    || caps.apis.find(x => x.id === caps.activeApiId)
    || caps.apis[0] || null;
  return a ? { supportsStream: true, supportsTools: true, ...a } : null;
}
function enabledSkillsPrompt() {
  return caps.skills
    .filter(s => s.enabled && s.instructions)
    .map(s => `【Skill：${s.name}】\n${s.instructions}`)
    .join('\n\n');
}

function loadConfig() {
  try { state.config = JSON.parse(localStorage.getItem(STORAGE_KEY)) || null; }
  catch { state.config = null; }
}

async function saveCaps() {
  caps = await frogAPI.capsSave(caps);
  renderCapLists();
}

async function loadCaps() {
  try { caps = await frogAPI.capsLoad() || caps; } catch {}
  if (!caps.apis.length && state.config && state.config.apiKey) { // 旧版单配置迁移为第一个用户自接 API
    const api = {
      id: uid('api_'),
      name: `${state.config.provider || 'custom'} / ${state.config.model}`,
      provider: state.config.provider || 'custom',
      baseUrl: state.config.baseUrl,
      model: state.config.model,
      apiKey: state.config.apiKey,
      supportsStream: true,
      supportsTools: true,
      createdAt: Date.now()
    };
    caps.apis.push(api);
    caps.activeApiId = api.id;
    await saveCaps();
  }
  state.autoTools = localStorage.getItem('naiwa.autotools.v1') !== 'off';
  $('cfgAutoTools').checked = state.autoTools;
  renderCapLists();
}

async function persistSession() {
  try {
    await frogAPI.historySave({
      id: state.sessionId,
      createdAt: state.createdAt,
      mode: state.mode,
      summary: state.summary,
      messages: state.history
    });
  } catch {}
}

function messageToView(m) {
  if (typeof m.content === 'string') return { text: m.content.replace(/\n?\[图片已省略\]$/, ''), img: null };
  if (Array.isArray(m.content)) {
    const text = m.content.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n');
    const img = m.content.find(p => p && p.type === 'image_url')?.image_url?.url || null;
    return { text, img };
  }
  return { text: String(m.content || ''), img: null };
}

async function loadHistory() {
  const h = await frogAPI.historyLoad();
  const s = h?.session;
  if (!s) return;
  state.sessionId = s.id || state.sessionId;
  state.createdAt = s.createdAt || state.createdAt;
  state.summary = s.summary || null;
  if (MODES[s.mode]) setAgentMode(s.mode, false);
  state.history = Array.isArray(s.messages) ? s.messages : [];
  state.history.forEach(m => {
    const view = messageToView(m);
    addMessage(m.role === 'user' ? 'user' : 'ai', view.text, view.img);
  });
  if (state.history.length) hideEmpty();
}

/* ===================== 图片：选择 / 粘贴 / 拖放 ===================== */
const fileInput = $('fileInput'), imgStrip = $('imgStrip');

$('stripImg').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) setImageFromFile(fileInput.files[0]);
  fileInput.value = '';
});
window.addEventListener('paste', e => {
  if (mode !== 'panel') return;
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (item) setImageFromFile(item.getAsFile());
});
['dragover', 'drop'].forEach(ev => window.addEventListener(ev, e => e.preventDefault()));
window.addEventListener('drop', e => {
  const file = [...(e.dataTransfer.files || [])].find(f => f.type.startsWith('image/'));
  if (!file) return;
  setImageFromFile(file);
  if (mode === 'ball') setMode('panel'); // 拖图到蛙身上：自动展开面板
});
$('btnRemoveImg').addEventListener('click', () => {
  state.image = null;
  imgStrip.classList.remove('show');
});

function setImageFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight, MAX = 2048;
      if (Math.max(w, h) > MAX) {
        const scale = MAX / Math.max(w, h);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const compressed = canvas.toDataURL('image/jpeg', 0.9);
        applyImage(compressed, file.name, canvas.width, canvas.height, compressed.length * 0.75);
      } else {
        applyImage(reader.result, file.name, w, h, file.size);
      }
    };
    img.onerror = () => showToast('图片解析失败，换一张试试');
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function applyImage(dataURL, name, w, h, bytes) {
  state.image = { dataURL, name, width: w, height: h, sizeKB: Math.round(bytes / 1024) };
  $('stripImg').src = dataURL;
  $('stripMeta').innerHTML = `<b>${escapeHtml(name)}</b><br>${w}×${h} · ${state.image.sizeKB} KB`;
  imgStrip.classList.add('show');
  hideEmpty();
}

function hideEmpty() { const el = $('chatEmpty'); if (el) el.style.display = 'none'; }

/* ===================== 提问与主进程代理调用 ===================== */
const questionInput = $('questionInput'), btnSend = $('btnSend');

const SEND_ICON = btnSend.innerHTML;
const STOP_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>';
function setSendBusy(on) {
  btnSend.disabled = false;
  btnSend.innerHTML = on ? STOP_ICON : SEND_ICON;
  btnSend.title = on ? '停止生成' : '发送';
}
btnSend.addEventListener('click', () => {
  if (state.busy) {
    if (state.streamId) frogAPI.abortStream(state.streamId);
    return;
  }
  submitQuestion();
});
questionInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitQuestion(); }
});
document.querySelectorAll('.quick-chip[data-q]').forEach(chip =>
  chip.addEventListener('click', () => {
    if (!state.image) return showToast('快捷提问需要先放一张图片');
    questionInput.value = chip.dataset.q;
    submitQuestion();
  })
);

async function submitQuestion() {
  if (state.busy) return;
  if (listening) { try { recog.stop(); } catch {} }
  const q = questionInput.value.trim();
  if (!q) return showToast('先输入你的问题');

  const api = activeApi();
  if (!api) {
    openSettings();
    return showToast('奶蛙不内置模型：先添加并选中你的 API');
  }

  hideEmpty();
  $('suggestRow').innerHTML = '';
  await maybeCompressHistory(api);
  const imgURL = state.image ? state.image.dataURL : null;
  addMessage('user', q, imgURL);
  questionInput.value = '';
  autosizeInput();
  state.busy = true;
  setSendBusy(true);
  document.body.classList.add('busy'); // 奶蛙张嘴思考中
  let aiDiv = null;

  try {
    const tools = collectOpenAiTools();
    const useTools = state.autoTools && api.supportsTools !== false && tools.defs.length > 0;
    let answer = '';
    if (useTools) {
      const thinkingEl = addThinking('奶蛙正在调用工具…');
      answer = await callChatWithTools(q, api, tools, round => {
        const el = thinkingEl.querySelector('.thinking');
        if (el && el.lastChild) el.lastChild.textContent = `奶蛙正在调用工具…第 ${round} 轮`;
      });
      thinkingEl.remove();
      aiDiv = addMessage('ai', answer);
    } else {
      aiDiv = addMessage('ai', '');
      const bubble = aiDiv.querySelector('.bubble');
      bubble.innerHTML = '<span class="stream-cursor"></span>';
      answer = await callChatStream(q, api, acc => {
        bubble.innerHTML = renderRich(acc) + '<span class="stream-cursor"></span>';
        scrollChat();
      });
      bubble.innerHTML = renderRich(answer);
    }
    state.history.push({ role: 'assistant', content: answer, ts: Date.now() });
    trimHistory();
    attachMsgActions(aiDiv, q, answer);
    renderSuggestions(await buildSuggestions(api, q, answer));
    if (autoSpeak) speakText(answer);
    await persistSession();
  } catch (err) {
    if (aiDiv) aiDiv.remove();
    state.history.pop(); // 失败回滚本轮提问
    let msg = `⚠ 呱…出错了：${err.message}`;
    if (!state.image && state.mode === 'vision') msg += '\n提示：Vision 模式更偏向看图；纯文字可切到 Chat 模式。';
    addMessage('ai', msg);
  } finally {
    state.busy = false;
    state.streamId = null;
    setSendBusy(false);
    document.body.classList.remove('busy');
    scrollChat();
  }
}

const SUMMARY_THRESHOLD = 3000;
const KEEP_RECENT = 6;
function estimateHistoryChars(list) {
  return list.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);
}
async function maybeCompressHistory(api) {
  if (estimateHistoryChars(state.history) < SUMMARY_THRESHOLD) return;
  const old = state.history.slice(0, Math.max(0, state.history.length - KEEP_RECENT));
  if (old.length < 4) return;
  try {
    const data = await frogAPI.chat({
      baseUrl: api.baseUrl,
      apiKey: api.apiKey,
      payload: {
        model: api.model,
        messages: [
          { role: 'system', content: '你是上下文压缩器。把给定对话压缩成不超过 300 字的中文摘要，只保留用户目标、偏好、约束、未完成事项和关键事实，不要寒暄。' },
          { role: 'user', content: JSON.stringify(old).slice(0, 12000) }
        ]
      }
    });
    const summary = data.choices?.[0]?.message?.content;
    if (summary) {
      state.summary = ((state.summary ? state.summary + '\n' : '') + String(summary)).slice(-1200);
      state.history = state.history.slice(-KEEP_RECENT);
      showToast('奶蛙已压缩较早上下文');
      await persistSession();
    }
  } catch {} // 压缩失败不阻塞本轮提问
}

const DEFAULT_PERSONA = '你是「奶蛙」，一只悬浮在用户桌面上的黄色小青蛙助手，说话可以偶尔带一点"呱"的俏皮语气但不要影响信息量。用户可能放入图片请你看图分析，也可能直接文字提问。没有图片时正常进行文字对话，不要要求用户提供图片。回答保持简洁、准确。';
function systemPrompt() {
  const skills = enabledSkillsPrompt();
  const persona = (caps.persona || '').trim() || DEFAULT_PERSONA; // 私有人设优先，留空用默认
  return [
    persona,
    MODES[state.mode].prompt,
    skills
  ].filter(Boolean).join('\n\n');
}

function buildPayload(question, api) {
  const entry = state.image
    ? { role: 'user', ts: Date.now(), content: [
        { type: 'text', text: question },
        { type: 'image_url', image_url: { url: state.image.dataURL } }
      ] }
    : { role: 'user', ts: Date.now(), content: question };
  state.history.push(entry);
  trimHistory();
  const messages = [{ role: 'system', content: systemPrompt() }];
  if (state.summary) messages.push({ role: 'system', content: '较早对话压缩摘要（仅供保持连续性）：\n' + state.summary });
  messages.push(...state.history);
  return { model: api.model, messages };
}

/* 上下文工程：超长对话先摘要压缩，再兜底硬截断，内存与 token 双封顶 */
function trimHistory() {
  if (state.history.length > 80) state.history = state.history.slice(-60);
}

/* 内置本地工具：与 MCP 工具走同一条 function-calling 通道，名字前缀 local_ */
const LOCAL_TOOLS = [
  { name: 'local_list_dir', description: '列出用户电脑白名单目录内的文件与子目录', parameters: { type: 'object', properties: { path: { type: 'string', description: '目录绝对路径，需位于白名单内' } }, required: ['path'] } },
  { name: 'local_read_file', description: '读取白名单内文本文件内容（自动截断）', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径' }, maxBytes: { type: 'number', description: '最多返回字节数' } }, required: ['path'] } },
  { name: 'local_write_file', description: '在白名单内写入/创建文本文件（执行前会请求用户确认）', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径' }, content: { type: 'string', description: '完整文件内容' } }, required: ['path', 'content'] } },
  { name: 'local_run_command', description: '在用户电脑执行 PowerShell 命令（执行前会请求用户确认）', parameters: { type: 'object', properties: { command: { type: 'string', description: 'PowerShell 命令' }, cwd: { type: 'string', description: '工作目录，需位于白名单内' }, timeoutMs: { type: 'number', description: '超时毫秒，默认 30000，最大 120000' } }, required: ['command'] } }
];

function collectOpenAiTools() {
  const defs = [], map = {};
  caps.mcps.filter(s => s.enabled && s.status === 'connected' && Array.isArray(s.tools)).forEach(s => {
    s.tools.forEach(t => {
      const fname = `mcp_${s.id}_${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      defs.push({ type: 'function', function: { name: fname, description: t.description || '', parameters: t.inputSchema || { type: 'object' } } });
      map[fname] = { serverId: s.id, name: t.name };
    });
  });
  if (caps.localTools?.enabled) {
    LOCAL_TOOLS.forEach(t => {
      defs.push({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } });
      map[t.name] = { local: true, name: t.name };
    });
  }
  return { defs, map };
}

function toolResultText(result) {
  const parts = result?.content;
  if (Array.isArray(parts)) {
    const text = parts.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n');
    if (text) return text.slice(0, 8000);
  }
  return JSON.stringify(result || {}).slice(0, 8000);
}

/* 本地工具执行：写/命令必确认，读操作按 autoRead 配置；结果包装成 MCP 同款 content 结构 */
async function callLocalTool(name, args) {
  const needConfirm = name === 'local_write_file' || name === 'local_run_command' || !caps.localTools?.autoRead;
  if (needConfirm) {
    const ok = await confirmLocalAction(name, args);
    if (!ok) return { content: [{ type: 'text', text: '用户拒绝了本次本地操作' }] };
  }
  try {
    const r = await frogAPI.localCall({ name, args });
    return { content: [{ type: 'text', text: JSON.stringify(r, null, 1).slice(0, 8000) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: '本地工具执行失败：' + err.message }] };
  }
}

function confirmLocalAction(name, args) {
  return new Promise(resolve => {
    const desc = name === 'local_run_command'
      ? `执行命令：${args.command || ''}${args.cwd ? `\n工作目录：${args.cwd}` : ''}`
      : name === 'local_write_file'
        ? `写入文件：${args.path || ''}\n内容长度：${String(args.content ?? '').length} 字`
        : `${name}\n路径：${args.path || ''}`;
    const div = document.createElement('div');
    div.className = 'msg ai';
    div.innerHTML = `<div class="bubble local-confirm">
      <div class="lc-title">奶蛙请求本地操作权限</div>
      <div class="lc-desc">${escapeHtml(desc)}</div>
      <div class="lc-btns"><button class="act ok">允许</button><button class="act">拒绝</button></div>
    </div>`;
    chatScroll.appendChild(div);
    scrollChat();
    const [btnOk, btnNo] = div.querySelectorAll('.lc-btns .act');
    const finish = v => {
      div.querySelector('.lc-btns').innerHTML = `<span class="lc-done">${v ? '已允许' : '已拒绝'}</span>`;
      resolve(v);
    };
    btnOk.onclick = () => finish(true);
    btnNo.onclick = () => finish(false);
  });
}

const MAX_TOOL_ROUNDS = 4;
async function callChatWithTools(question, api, tools, onRound) {
  const payload = buildPayload(question, api);
  payload.tools = tools.defs;
  payload.tool_choice = 'auto';
  for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
    onRound?.(round);
    const data = await frogAPI.chat({ baseUrl: api.baseUrl, apiKey: api.apiKey, payload });
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('模型返回了空内容');
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      payload.messages.push(msg);
      for (const call of msg.tool_calls) {
        const hit = tools.map[call.function?.name];
        let result;
        if (!hit) {
          result = { content: [{ type: 'text', text: '未知工具：' + (call.function?.name || '') }] };
        } else {
          let args = {};
          try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
          try {
            result = hit.local
              ? await callLocalTool(hit.name, args)
              : await frogAPI.mcpCall({ serverId: hit.serverId, name: hit.name, args });
          } catch (err) {
            // 工具失败不再中断整轮对话：把错误作为工具结果回给模型，由模型决定重试或换路径
            result = { content: [{ type: 'text', text: '工具调用失败：' + (err?.message || String(err)) }] };
          }
        }
        payload.messages.push({ role: 'tool', tool_call_id: call.id, content: toolResultText(result) });
      }
      continue;
    }
    const content = msg.content;
    if (!content) throw new Error('模型返回了空内容');
    return typeof content === 'string' ? content : JSON.stringify(content);
  }
  throw new Error(`工具调用轮次过多，已停止（上限 ${MAX_TOOL_ROUNDS} 轮）`);
}

async function callChatStream(question, api, onDelta) {
  const payload = buildPayload(question, api);
  const id = uid('stream_');
  state.streamId = id;
  let acc = '';
  const done = new Promise((resolve, reject) => {
    streamHandlers.set(id, ({ delta, done, error, aborted }) => {
      if (delta) { acc += delta; onDelta(acc); }
      if (error) {
        if (aborted) resolve(acc || '（已停止生成）');
        else reject(new Error(error));
        return;
      }
      if (done) resolve(acc);
    });
  });
  await frogAPI.chatStream({ id, baseUrl: api.baseUrl, apiKey: api.apiKey, payload });
  const answer = await done;
  if (!answer) throw new Error('模型返回了空内容');
  return answer;
}

async function buildSuggestions(api, question, answer) {
  try {
    const data = await frogAPI.chat({
      baseUrl: api.baseUrl,
      apiKey: api.apiKey,
      payload: {
        model: api.model,
        messages: [
          { role: 'system', content: '根据用户问题和助手回答，生成 3 条简短追问建议。只输出 JSON 数组，每条不超过 24 字，不要解释。' },
          { role: 'user', content: `问题：${question}\n回答：${String(answer).slice(0, 1200)}` }
        ]
      }
    });
    const text = data.choices?.[0]?.message?.content || '';
    const match = text.match(/\[[\s\S]*\]/);
    const arr = match ? JSON.parse(match[0]) : [];
    return arr.filter(x => typeof x === 'string' && x.trim()).slice(0, 3);
  } catch { return []; }
}

function renderSuggestions(list) {
  const row = $('suggestRow');
  row.innerHTML = '';
  list.forEach(text => {
    const b = document.createElement('button');
    b.className = 'quick-chip';
    b.textContent = text;
    b.addEventListener('click', () => {
      questionInput.value = text;
      submitQuestion();
    });
    row.appendChild(b);
  });
}

function attachMsgActions(div, question, answer) {
  const bar = document.createElement('div');
  bar.className = 'msg-actions';
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.className = 'act';
    b.textContent = label;
    b.addEventListener('click', fn);
    bar.appendChild(b);
  };
  mk('复制', async () => {
    try { await navigator.clipboard.writeText(answer); showToast('已复制'); }
    catch { showToast('复制失败'); }
  });
  mk('重试', () => {
    questionInput.value = question;
    submitQuestion();
  });
  mk('引用重问', () => {
    questionInput.value = `引用：${String(answer).slice(0, 180)}\n追问：`;
    autosizeInput();
    questionInput.focus();
  });
  div.appendChild(bar);
}

/* ===================== 消息渲染 ===================== */
const chatScroll = $('chatScroll');

function addMessage(role, text, imgURL) {
  const div = document.createElement('div');
  div.className = 'msg ' + (role === 'user' ? 'user' : 'ai');
  div.innerHTML = role === 'user'
    ? `<div class="bubble">${imgURL ? `<img class="q-img" src="${imgURL}" alt="">` : ''}<p>${escapeHtml(text)}</p></div>`
    : `<div class="bubble">${renderRich(text)}</div>`;
  chatScroll.appendChild(div);
  scrollChat();
  // 长会话 DOM 封顶：气泡超过 140 条时移除最早的（history 数组仍是完整数据源）
  const msgs = chatScroll.querySelectorAll('.msg');
  if (msgs.length > 140) Array.from(msgs).slice(0, msgs.length - 120).forEach(el => el.remove());
  return div;
}

function addThinking(text = '奶蛙思考中…') {
  const div = document.createElement('div');
  div.className = 'msg ai';
  div.innerHTML = `<div class="bubble"><span class="thinking"><span class="dots"><i></i><i></i><i></i></span>${escapeHtml(text)}</span></div>`;
  chatScroll.appendChild(div);
  scrollChat();
  return div;
}

function scrollChat() { chatScroll.scrollTop = chatScroll.scrollHeight; }

function renderRich(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

/* ===================== 设置弹层：API / MCP / Skill ===================== */
const modalMask = $('modalMask');
$('btnSettings').addEventListener('click', openSettings);
$('btnCancel').addEventListener('click', () => modalMask.classList.remove('open'));
$('cfgProvider').addEventListener('change', () => {
  const p = PROVIDERS[$('cfgProvider').value] || PROVIDERS.custom;
  $('cfgBaseUrl').value = p.baseUrl;
  $('cfgModel').value = p.model;
});
$('cfgApiList').addEventListener('change', () => {
  const api = caps.apis.find(a => a.id === $('cfgApiList').value);
  if (api) fillApiForm(api);
  else {
    const p = PROVIDERS[$('cfgProvider').value] || PROVIDERS.custom;
    $('cfgBaseUrl').value = p.baseUrl;
    $('cfgModel').value = p.model;
    $('cfgKey').value = '';
  }
});
$('cfgAutoTools').addEventListener('change', () => {
  state.autoTools = $('cfgAutoTools').checked;
  localStorage.setItem('naiwa.autotools.v1', state.autoTools ? 'on' : 'off');
  showToast(state.autoTools ? '已启用 MCP 自动工具' : '已关闭 MCP 自动工具');
});

/* 本地工具配置：改动即保存，不依赖 API 表单；根目录留空时由主进程归一化为用户目录 */
async function saveLocalTools() {
  const roots = $('cfgLocalRoots').value.split(/[;；\n]/).map(s => s.trim()).filter(Boolean);
  caps.localTools = {
    enabled: $('cfgLocalEnable').checked,
    autoRead: $('cfgLocalAutoRead').checked,
    roots
  };
  await saveCaps();
  showToast(caps.localTools.enabled ? '本地工具已启用，呱！' : '本地工具已关闭');
}
['cfgLocalEnable', 'cfgLocalAutoRead', 'cfgLocalRoots'].forEach(id =>
  $(id).addEventListener('change', saveLocalTools)
);
function fillLocalToolsForm() {
  const lt = caps.localTools || {};
  $('cfgLocalEnable').checked = !!lt.enabled;
  $('cfgLocalAutoRead').checked = lt.autoRead !== false;
  $('cfgLocalRoots').value = (lt.roots || []).join(';');
}

function fillApiForm(api) {
  $('cfgApiList').value = api.id === 'legacy' ? '' : api.id;
  $('cfgProvider').value = api.provider || 'custom';
  $('cfgBaseUrl').value = api.baseUrl || '';
  $('cfgModel').value = api.model || '';
  $('cfgKey').value = api.apiKey || '';
}

/* 模型路由 + 私有人设：随保存的 API 列表刷新下拉项 */
function fillPersonaRoute() {
  $('cfgPersona').value = caps.persona || '';
  const opts = '<option value="">跟随当前 API</option>' + caps.apis.map(a =>
    `<option value="${a.id}">${escapeHtml(a.name || a.model || a.baseUrl)}</option>`).join('');
  ['Chat', 'Code', 'Vision'].forEach(m => {
    const sel = $('cfgRoute' + m);
    sel.innerHTML = opts;
    sel.value = (caps.route && caps.route[m.toLowerCase()]) || '';
  });
}
async function savePersonaRoute() {
  caps.persona = $('cfgPersona').value;
  caps.route = {
    chat: $('cfgRouteChat').value,
    code: $('cfgRouteCode').value,
    vision: $('cfgRouteVision').value
  };
  await saveCaps();
  showToast('模型路由与人设已保存，呱！');
}
['cfgPersona', 'cfgRouteChat', 'cfgRouteCode', 'cfgRouteVision'].forEach(id =>
  $(id).addEventListener('change', savePersonaRoute)
);

function openSettings() {
  renderCapLists();
  fillLocalToolsForm();
  fillPersonaRoute();
  const api = activeApi();
  if (api) fillApiForm(api);
  else {
    $('cfgApiList').value = '';
    $('cfgProvider').value = 'custom';
    $('cfgBaseUrl').value = '';
    $('cfgModel').value = '';
    $('cfgKey').value = '';
  }
  modalMask.classList.add('open');
}

$('btnSave').addEventListener('click', async () => {
  const provider = $('cfgProvider').value;
  const baseUrl = $('cfgBaseUrl').value.trim();
  const model = $('cfgModel').value.trim();
  const apiKey = $('cfgKey').value.trim();
  if (!baseUrl) return showToast('接口地址不能为空');
  if (!model) return showToast('模型名不能为空');
  if (!apiKey) return showToast('API Key 不能为空');

  const selectedId = $('cfgApiList').value;
  const old = caps.apis.find(a => a.id === selectedId);
  const api = {
    id: old ? old.id : uid('api_'),
    name: old?.name || `${provider} / ${model}`,
    provider, baseUrl, model, apiKey,
    supportsStream: true,
    supportsTools: true,
    createdAt: old?.createdAt || Date.now()
  };
  if (old) Object.assign(old, api);
  else caps.apis.push(api);
  caps.activeApiId = api.id;
  await saveCaps();
  modalMask.classList.remove('open');
  showToast('API 已保存并设为当前，呱！');
});

$('btnApiDelete').addEventListener('click', async () => {
  const selectedId = $('cfgApiList').value;
  if (!selectedId) return showToast('先在“已保存 API”里选择要删除的项');
  caps.apis = caps.apis.filter(a => a.id !== selectedId);
  if (caps.activeApiId === selectedId) caps.activeApiId = caps.apis[0]?.id || null;
  await saveCaps();
  openSettings();
  showToast('API 已删除');
});

function parseArgs(raw) {
  const out = [], re = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let m;
  while ((m = re.exec(raw || ''))) out.push(m[1] ?? m[2] ?? m[3]);
  return out.filter(Boolean);
}

function renderCapLists() {
  const sel = $('cfgApiList');
  const cur = sel.value || caps.activeApiId || '';
  sel.innerHTML = '<option value="">新建 API…</option>' + caps.apis.map(a =>
    `<option value="${a.id}">${escapeHtml(a.name || a.model)}${a.id === caps.activeApiId ? '（当前）' : ''}</option>`
  ).join('');
  sel.value = caps.apis.some(a => a.id === cur) ? cur : (caps.activeApiId || '');
  fillPersonaRoute(); // API 列表变化时同步路由下拉项

  const mcpList = $('mcpList');
  mcpList.innerHTML = caps.mcps.map(s => `
    <div class="cap-row" data-id="${s.id}">
      <span class="grow"><b>${escapeHtml(s.name)}</b> · ${escapeHtml(s.command)} ${escapeHtml((s.args || []).join(' '))}<br>${s.status === 'connected' ? `已连接 · ${(s.tools || []).length} 个工具` : (s.lastError ? '未连接 · ' + escapeHtml(s.lastError) : '未连接')}</span>
      <button class="cap-mini" data-act="refresh">${s.status === 'connected' ? '刷新' : '连接'}</button>
      <button class="cap-mini" data-act="toggle">${s.enabled ? '停用' : '启用'}</button>
      <button class="cap-mini danger" data-act="del">删除</button>
    </div>`).join('');
  mcpList.querySelectorAll('.cap-row').forEach(row => {
    const id = row.dataset.id;
    row.querySelector('[data-act="refresh"]').addEventListener('click', async () => {
      try {
        await frogAPI.mcpRefresh(id);
        caps = await frogAPI.capsLoad();
        showToast('MCP 已连接');
      } catch (err) {
        caps = await frogAPI.capsLoad();
        showToast('MCP 连接失败：' + err.message);
      }
      renderCapLists();
    });
    row.querySelector('[data-act="toggle"]').addEventListener('click', async () => {
      const s = caps.mcps.find(x => x.id === id);
      if (!s) return;
      s.enabled = !s.enabled;
      if (!s.enabled) await frogAPI.mcpStop(id);
      await saveCaps();
    });
    row.querySelector('[data-act="del"]').addEventListener('click', async () => {
      await frogAPI.mcpStop(id);
      caps.mcps = caps.mcps.filter(x => x.id !== id);
      await saveCaps();
      showToast('MCP 已删除');
    });
  });

  const skillList = $('skillList');
  skillList.innerHTML = caps.skills.map(s => `
    <div class="cap-row" data-id="${s.id}">
      <span class="grow"><b>${escapeHtml(s.name)}</b><br>${escapeHtml(String(s.instructions || '').slice(0, 90))}</span>
      <button class="cap-mini" data-act="toggle">${s.enabled ? '停用' : '启用'}</button>
      <button class="cap-mini danger" data-act="del">删除</button>
    </div>`).join('');
  skillList.querySelectorAll('.cap-row').forEach(row => {
    const id = row.dataset.id;
    row.querySelector('[data-act="toggle"]').addEventListener('click', async () => {
      const s = caps.skills.find(x => x.id === id);
      if (!s) return;
      s.enabled = !s.enabled;
      await saveCaps();
    });
    row.querySelector('[data-act="del"]').addEventListener('click', async () => {
      caps.skills = caps.skills.filter(x => x.id !== id);
      await saveCaps();
      showToast('Skill 已删除');
    });
  });
}

$('btnMcpAdd').addEventListener('click', async () => {
  const name = $('mcpName').value.trim();
  const command = $('mcpCommand').value.trim();
  const args = parseArgs($('mcpArgs').value);
  if (!name) return showToast('MCP 名称不能为空');
  if (!command) return showToast('MCP 命令不能为空');
  caps.mcps.push({ id: uid('mcp_'), name, command, args, enabled: true, status: 'idle', tools: [], lastError: null, createdAt: Date.now() });
  $('mcpName').value = $('mcpCommand').value = $('mcpArgs').value = '';
  await saveCaps();
  showToast('MCP 已添加，点“连接”读取工具');
});

$('btnSkillAdd').addEventListener('click', async () => {
  const name = $('skillName').value.trim();
  const instructions = $('skillInstructions').value.trim();
  if (!name) return showToast('Skill 名称不能为空');
  if (!instructions) return showToast('Skill 指令不能为空');
  caps.skills.push({ id: uid('skill_'), name, instructions, enabled: true, createdAt: Date.now() });
  $('skillName').value = $('skillInstructions').value = '';
  await saveCaps();
  showToast('Skill 已添加并启用');
});

/* ===================== Toast ===================== */
let toastTimer = null;
function showToast(msg) {
  const toast = $('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

/* ===================== 新对话 ===================== */
async function newChat() {
  if (state.busy) {
    if (state.streamId) await frogAPI.abortStream(state.streamId);
    return showToast('奶蛙正在思考，已发送停止指令');
  }
  state.history = [];
  state.summary = null;
  state.sessionId = 's' + Date.now();
  state.createdAt = Date.now();
  $('suggestRow').innerHTML = '';
  chatScroll.querySelectorAll('.msg').forEach(el => el.remove());
  const empty = $('chatEmpty');
  if (empty) empty.style.display = '';
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  await frogAPI.historyClear();
  showToast('新对话已开启，上下文已清空');
}
$('btnNewChat').addEventListener('click', newChat);

/* ===================== 输入框自适应高度 ===================== */
function autosizeInput() {
  questionInput.style.height = 'auto';
  questionInput.style.height = Math.min(questionInput.scrollHeight, 110) + 'px';
}
questionInput.addEventListener('input', autosizeInput);

/* ===================== 语音输入（Web Speech API） ===================== */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null, listening = false, recogBase = '';
const MIC_PLACEHOLDER = questionInput.placeholder;
const btnMic = $('btnMic');

if (SR) {
  recog = new SR();
  recog.lang = 'zh-CN';
  recog.interimResults = true;
  recog.continuous = false;
  recog.onresult = e => {
    let final = '', interim = '';
    for (const r of e.results) {
      if (r.isFinal) final += r[0].transcript;
      else interim += r[0].transcript;
    }
    questionInput.value = recogBase + final + interim;
    autosizeInput();
  };
  recog.onend = () => stopListening();
  recog.onerror = e => {
    stopListening();
    const map = {
      'no-speech': '没有听到声音，靠近麦克风再试',
      'not-allowed': '麦克风权限被拒绝',
      'audio-capture': '没有检测到麦克风设备'
    };
    showToast(map[e.error] || '语音识别出错（' + e.error + '）');
  };
}
function startListening() {
  recogBase = questionInput.value;
  listening = true;
  btnMic.classList.add('rec');
  questionInput.placeholder = '正在聆听…（说完自动停止）';
  try { recog.start(); } catch {}
}
function stopListening() {
  if (!listening) return;
  listening = false;
  btnMic.classList.remove('rec');
  questionInput.placeholder = MIC_PLACEHOLDER;
  questionInput.focus();
}
btnMic.addEventListener('click', () => {
  if (!SR) return showToast('当前环境不支持语音识别');
  listening ? recog.stop() : startListening();
});

/* ===================== 朗读回答 ===================== */
let autoSpeak = localStorage.getItem(VOICE_KEY) === 'on';
let zhVoice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices();
  zhVoice = vs.find(v => /^zh([-_]CN)?$/i.test(v.lang)) || vs.find(v => v.lang.toLowerCase().startsWith('zh')) || null;
}
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}
function updateVoiceBtn() {
  const btnVoice = $('btnVoice');
  btnVoice.classList.toggle('on', autoSpeak);
  btnVoice.title = autoSpeak ? '自动朗读：开' : '自动朗读：关';
}
$('btnVoice').addEventListener('click', () => {
  autoSpeak = !autoSpeak;
  localStorage.setItem(VOICE_KEY, autoSpeak ? 'on' : 'off');
  if (!autoSpeak && 'speechSynthesis' in window) speechSynthesis.cancel();
  updateVoiceBtn();
  showToast(autoSpeak ? '已开启自动朗读' : '已关闭自动朗读');
});
updateVoiceBtn();

function speakText(raw) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const text = raw.replace(/\*\*/g, '').replace(/`/g, '').replace(/⚠/g, '').trim();
  if (!text) return;
  const u = new SpeechSynthesisUtterance(text);
  if (zhVoice) u.voice = zhVoice;
  u.lang = zhVoice ? zhVoice.lang : 'zh-CN';
  u.onstart = () => $('btnVoice').classList.add('speaking');
  u.onend = u.onerror = () => $('btnVoice').classList.remove('speaking');
  speechSynthesis.speak(u);
}

/* ===================== 启动 ===================== */
(async () => {
  loadConfig(); // 读旧版 localStorage 配置仅用于一次性迁移到能力存储
  await loadCaps();
  if (!frogAPI.shotMode) await loadHistory(); // 自检截图保持空态，避免历史气泡干扰
})();
