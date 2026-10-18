/**
 * 奶蛙 · 预加载桥：渲染进程与主进程之间的唯一安全通道
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('frogAPI', {
  /** 大模型对话：主进程代理转发（无 CORS），429 已在主进程自动重试 */
  chat: (args) => ipcRenderer.invoke('frog:chat', args),
  /** SSE 流式对话：id 由渲染层生成，chunk 通过 onStreamChunk 回推 */
  chatStream: (args) => ipcRenderer.invoke('frog:chat-stream', args),
  abortStream: (id) => ipcRenderer.invoke('frog:stream-abort', id),
  onStreamChunk: (cb) => ipcRenderer.on('frog:stream-chunk', (e, d) => cb(d)),
  /** 读取 assets 目录图片，返回 base64（供 canvas 抠图，规避 file:// 画布污染） */
  readAsset: (name) => ipcRenderer.invoke('frog:read-asset', name),
  /** 能力底座：API / MCP / Skill 存储与 MCP 工具调用 */
  capsLoad: () => ipcRenderer.invoke('frog:caps-load'),
  capsSave: (caps) => ipcRenderer.invoke('frog:caps-save', caps),
  mcpRefresh: (id) => ipcRenderer.invoke('frog:mcp-refresh', id),
  mcpCall: (args) => ipcRenderer.invoke('frog:mcp-call', args),
  mcpStop: (id) => ipcRenderer.invoke('frog:mcp-stop', id),
  /** 本地工具：白名单内的文件/命令操作（渲染层先弹用户确认再调用） */
  localCall: (args) => ipcRenderer.invoke('frog:local-call', args),
  /** 本地历史：只存文字与摘要，图片不落地 */
  historyLoad: () => ipcRenderer.invoke('frog:history-load'),
  historySave: (session) => ipcRenderer.invoke('frog:history-save', session),
  historyClear: () => ipcRenderer.invoke('frog:history-clear'),
  /** 切换悬浮形态：'ball' 悬浮球态 / 'panel' 对话面板态 */
  setMode: (mode) => ipcRenderer.invoke('frog:mode', mode),
  /** 窗口置顶开关 */
  setPin: (on) => ipcRenderer.invoke('frog:pin', on),
  /** 拖拽：按下/松开（主进程轮询光标移动窗口） */
  dragStart: () => ipcRenderer.send('frog:drag-start'),
  dragEnd: () => ipcRenderer.send('frog:drag-end'),
  /** 右键菜单 */
  openMenu: () => ipcRenderer.send('frog:menu'),
  /** 全局光标位置推送（眼睛跟随的数据源） */
  onCursor: (cb) => ipcRenderer.on('frog:cursor', (e, d) => cb(d)),
  /** 右键菜单动作回调 */
  onMenuAction: (cb) => ipcRenderer.on('frog:menu-action', (e, a, b) => cb(a, b)),
  /** 是否为自检截图模式（启动参数 --shot） */
  shotMode: process.argv.includes('--shot')
});
