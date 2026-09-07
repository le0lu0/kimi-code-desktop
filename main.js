const { app, BrowserWindow, Menu, Tray, nativeImage, shell } = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE_PORT = parseInt(process.env.KIMI_WEB_PORT || '58627', 10);
const PORT_SCAN_COUNT = 10;
const SERVER_START_TIMEOUT_MS = 20000;
const PROBE_TIMEOUT_MS = 800;
const TRAY_REFRESH_MS = 10000;
const SESSION_TITLE_MAX = 46;
const IS_MAC = process.platform === 'darwin';
const TRAFFIC_LIGHT = { x: 14, y: 17 };

let win = null;
let tray = null;
let trayTimer = null;
let serverChild = null;
let serverPort = null;
let serverToken = null;
let quitting = false;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

function readToken() {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.kimi-code', 'server.token'), 'utf8').trim();
  } catch {
    return null;
  }
}

async function probePort(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const headers = serverToken ? { Authorization: `Bearer ${serverToken}` } : {};
    const res = await fetch(`http://127.0.0.1:${port}/openapi.json`, { headers, signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function findReadyServer() {
  for (let i = 0; i < PORT_SCAN_COUNT; i++) {
    const port = BASE_PORT + i;
    if (await probePort(port)) return port;
  }
  return null;
}

function resolveKimiBin() {
  if (process.env.KIMI_BIN) return process.env.KIMI_BIN;
  const home = os.homedir();
  const win = process.platform === 'win32';
  const candidates = win
    ? ['kimi.cmd', 'kimi.exe', path.join(home, 'AppData', 'Roaming', 'npm', 'kimi.cmd')]
    : [
        'kimi',
        path.join(home, '.local', 'bin', 'kimi'),
        path.join(home, '.local', 'share', 'mise', 'shims', 'kimi'),
      ];
  for (const bin of candidates) {
    const r = spawnSync(bin, ['--version'], { timeout: 5000, shell: win });
    if (!r.error && r.status === 0) return bin;
  }
  return null;
}

async function ensureServer() {
  const existing = await findReadyServer();
  if (existing) return existing;

  const bin = resolveKimiBin();
  if (!bin) throw new Error('找不到 kimi 命令，请确认 kimi CLI 已安装（或通过 KIMI_BIN 环境变量指定）');

  serverChild = spawn(bin, ['web', '--no-open'], { stdio: 'ignore', shell: process.platform === 'win32' });
  serverChild.on('error', (err) => console.error('kimi web 启动失败:', err));

  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const port = await findReadyServer();
    if (port) return port;
  }
  throw new Error('kimi web 在超时时间内未能就绪');
}

async function fetchSessions() {
  if (!serverPort) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const headers = serverToken ? { Authorization: `Bearer ${serverToken}` } : {};
    const res = await fetch(`http://127.0.0.1:${serverPort}/api/v1/sessions`, { headers, signal: controller.signal });
    if (!res.ok) return null;
    const body = await res.json();
    const items = body && body.data && Array.isArray(body.data.items) ? body.data.items : [];
    return items
      .filter((s) => !s.archived)
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function truncate(text, max) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

async function refreshTray() {
  if (!tray) return;
  const sessions = await fetchSessions();
  const running = sessions ? sessions.filter((s) => s.busy) : null;

  const items = [];
  if (!running) {
    items.push({ label: 'kimi web 未连接', enabled: false });
  } else if (running.length === 0) {
    items.push({ label: '没有正在运行的会话', enabled: false });
  } else {
    items.push({ label: `运行中 ${running.length} 个会话`, enabled: false });
    for (const s of running.slice(0, 8)) {
      items.push({
        label: `●  ${truncate(s.title, SESSION_TITLE_MAX)}`,
        type: 'normal',
        click: () => showWindow(),
      });
    }
  }

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Kimi Code', enabled: false },
    { type: 'separator' },
    ...items,
    { type: 'separator' },
    { label: '显示主窗口', click: () => showWindow() },
    { label: '退出 Kimi Code', click: () => app.quit() },
  ]));
  tray.setToolTip(running && running.length
    ? `Kimi Code — ${running.length} 个会话运行中`
    : 'Kimi Code');
}

function setupTray() {
  let icon;
  if (IS_MAC) {
    icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
    icon.setTemplateImage(true);
  } else {
    icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-color.png'));
  }
  tray = new Tray(icon);
  refreshTray();
  trayTimer = setInterval(refreshTray, TRAY_REFRESH_MS);
}

function showWindow() {
  if (!win) return;
  win.show();
  win.focus();
}

function buildAppMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// 注入到 kimi web 页面：在会话头部三个点右侧加「VS Code / 终端」按钮，
// 调用服务端 /sessions/{id}/fs:open-in 在会话工作目录打开对应应用。
// 注意：本函数整体序列化后在页面里执行，不能引用模块作用域的变量。
function injectDesktopButtons(token) {
  if (window.__kimiDesktopInjected) return;
  window.__kimiDesktopInjected = true;

  const VS_CODE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .325 8.74L3.899 12 .325 15.26a1 1 0 0 0 .002 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z"/></svg>';
  const TERMINAL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="18" rx="3"/><path d="m6.5 8.5 4 3.5-4 3.5"/><path d="M12.5 16H17.5"/></svg>';

  const API_BASE = '/api/v1';
  let lastSessionId = null;

  // 页面对活跃会话的轮询都走 /sessions/{id}/...，借机记录当前会话 id
  const origFetch = window.fetch;
  window.fetch = function (input) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const m = /\/api\/v1\/sessions\/(session_[A-Za-z0-9_-]+)/.exec(url);
      if (m) lastSessionId = m[1];
    } catch {}
    return origFetch.apply(this, arguments);
  };

  const style = document.createElement('style');
  style.textContent = `
    .kd-ext-btn { display:inline-flex; align-items:center; justify-content:center; flex:none;
      width:24px; height:24px; padding:0; border:.5px solid transparent;
      border-radius:var(--radius-sm, 6px); background:transparent;
      color:var(--color-text-muted, #888); cursor:pointer; -webkit-app-region:no-drag;
      transition:background .15s ease, color .15s ease; }
    .kd-ext-btn:hover { background:var(--color-hover, rgba(128,128,128,.15)); color:var(--color-text, #333); }
    .kd-ext-btn svg { width:14px; height:14px; display:block; }
    .kd-toast { position:fixed; left:50%; bottom:72px; transform:translateX(-50%);
      background:var(--color-well, #333); color:var(--color-text, #fff);
      font-family:var(--font-ui, sans-serif); font-size:12px; padding:8px 14px;
      border-radius:8px; z-index:2147483647; box-shadow:0 4px 16px rgba(0,0,0,.25);
      opacity:0; transition:opacity .2s ease; pointer-events:none; }
    .kd-toast.show { opacity:1; }
  `;
  document.head.appendChild(style);

  let toastEl = null;
  let toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'kd-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    requestAnimationFrame(() => toastEl.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
  }

  function authHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    return h;
  }

  async function listSessions() {
    const res = await origFetch(API_BASE + '/sessions', { headers: authHeaders() });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const items = body && body.data && Array.isArray(body.data.items) ? body.data.items : null;
    if (!items) return null;
    return items
      .filter((s) => !s.archived)
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  }

  async function resolveSession() {
    const items = await listSessions();
    if (!items || !items.length) return null;
    if (lastSessionId) {
      const hit = items.find((s) => s.id === lastSessionId);
      if (hit) return hit;
    }
    const el = document.querySelector('header.chat-header .ch-ses');
    const title = el ? el.textContent.trim() : '';
    if (title) {
      const hit = items.find((s) => (s.title || '').trim() === title);
      if (hit) return hit;
    }
    return items[0];
  }

  async function openIn(appId) {
    const session = await resolveSession();
    if (!session) {
      toast('未找到当前会话');
      return;
    }
    if (appId === 'vscode') {
      const cwd = session.metadata && session.metadata.cwd;
      if (!cwd) {
        toast('未找到会话工作目录');
        return;
      }
      // vscode:// 由主进程 shell.openExternal 接管；VS Code 对同一文件夹只保留一个窗口，
      // 已打开时会聚焦现有窗口，未打开时新开窗口
      window.open('vscode://file' + encodeURI(cwd));
      toast('已在 VS Code 打开工作目录');
      return;
    }
    if (appId === 'terminal') {
      const cwd = session.metadata && session.metadata.cwd;
      if (!cwd) {
        toast('未找到会话工作目录');
        return;
      }
      // 自定义 scheme 由主进程分平台处理（服务端的 fs:open-in 在 win/linux 会退化成文件管理器）
      window.open('kimi-desktop://open-terminal?path=' + encodeURIComponent(cwd));
      toast('已在终端打开工作目录');
      return;
    }
    toast('打开失败');
  }

  function makeButton(label, icon, appId) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'kd-ext-btn';
    b.dataset.kimiDesktop = '1';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = icon;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      openIn(appId);
    });
    return b;
  }

  function ensureButtons() {
    const kebab = document.querySelector('header.chat-header .ch-act-more');
    if (!kebab) return;
    let next = kebab.nextElementSibling;
    if (next && next.dataset && next.dataset.kimiDesktop) return;
    const vscodeBtn = makeButton('在 VS Code 中打开工作目录', VS_CODE_ICON, 'vscode');
    const termBtn = makeButton('在终端中打开工作目录', TERMINAL_ICON, 'terminal');
    kebab.after(termBtn, vscodeBtn);
  }

  const mo = new MutationObserver(() => ensureButtons());
  mo.observe(document.body, { childList: true, subtree: true });
  ensureButtons();
}

function findVsCodeBinary() {
  const candidates = [
    '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
    path.join(os.homedir(), 'Applications', 'Visual Studio Code.app', 'Contents', 'MacOS', 'Code'),
  ];
  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

function openTerminalFor(dir) {
  if (process.platform === 'darwin') {
    return spawn('open', ['-a', 'Terminal', dir], { stdio: 'ignore', detached: true }).unref();
  }
  if (process.platform === 'win32') {
    // Windows Terminal 优先，缺失时退回 cmd
    const wt = spawn('wt.exe', ['-d', dir], { stdio: 'ignore', detached: true });
    wt.on('error', () => {
      spawn(process.env.COMSPEC || 'cmd.exe', ['/c', 'start', '', 'cmd.exe', '/K', `cd /d "${dir}"`], { stdio: 'ignore', detached: true }).unref();
    });
    return wt.unref();
  }
  // Linux：按常见终端依次尝试，二进制缺失时 spawn 会触发 error 事件落到下一个
  const candidates = [
    ['gnome-terminal', ['--working-directory=' + dir]],
    ['konsole', ['--workdir', dir]],
    ['xfce4-terminal', ['--working-directory=' + dir]],
    ['x-terminal-emulator', ['--working-directory=' + dir]],
  ];
  const tryNext = (i) => {
    if (i >= candidates.length) return;
    const [cmd, args] = candidates[i];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => tryNext(i + 1));
    child.unref();
  };
  tryNext(0);
}

async function createWindow() {
  // macOS：hidden 隐藏标题栏保留红绿灯；已知问题——macOS 26 上失焦时红绿灯显示为白色而非灰色（Electron 渲染缺陷，暂接受）
  const w = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Kimi Code',
    ...(IS_MAC ? { titleBarStyle: 'hidden', trafficLightPosition: TRAFFIC_LIGHT } : {}),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  w.on('page-title-updated', (e) => e.preventDefault());
  w.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      w.hide();
    }
  });

  w.webContents.setWindowOpenHandler(({ url: target }) => {
    // 页面注入按钮：终端按平台选择本机终端模拟器
    if (target.startsWith('kimi-desktop://open-terminal?')) {
      const m = /[?&]path=([^&]+)/.exec(target);
      const dir = m ? decodeURIComponent(m[1]) : '';
      if (dir && fs.existsSync(dir)) openTerminalFor(dir);
      return { action: 'deny' };
    }
    // 页面注入按钮：用 -n 强制 VS Code 新窗口（vscode:// scheme 会复用最后活动的窗口）
    if (target.startsWith('vscode://file/')) {
      const dir = decodeURI(target.slice('vscode://file'.length));
      const bin = findVsCodeBinary();
      if (bin) {
        const child = spawn(bin, ['-n', dir], { stdio: 'ignore', detached: true });
        child.on('error', () => shell.openExternal(target));
        child.unref();
      } else {
        shell.openExternal(target);
      }
      return { action: 'deny' };
    }
    if (/^https?:\/\/(127\.0\.0\.1|localhost):/.test(target)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 1100, height: 760 } };
    }
    shell.openExternal(target);
    return { action: 'deny' };
  });

  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<body style="font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;color:#666">正在启动 Kimi Code…</body>'
  )).catch(() => {});

  w.webContents.on('did-finish-load', () => {
    if (/^https?:\/\/(127\.0\.0\.1|localhost):/.test(w.webContents.getURL())) {
      w.webContents
        .executeJavaScript(`(${injectDesktopButtons.toString()})(${JSON.stringify(serverToken)})`)
        .catch(() => {});
    }
    if (!IS_MAC) return; // 红绿灯让位样式仅 macOS 需要；其他平台使用原生标题栏
    w.webContents.insertCSS(`
      .side .ch, header.chat-header { -webkit-app-region: drag; }
      .side .ch { padding-left: 96px !important; }
      .app.sidebar-collapsed .new-chat-btn { left: 96px !important; }
      .app.sidebar-collapsed .sidebar-toggle-btn { left: 128px !important; }
      .app.sidebar-collapsed header.chat-header { padding-left: 168px !important; }
      .side .ch button, .side .ch .ui-icon-button,
      header.chat-header button, header.chat-header .ui-icon-button,
      header.chat-header input { -webkit-app-region: no-drag; }
    `).catch(() => {});
  });

  return w;
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  buildAppMenu();
  if (IS_MAC && app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon-1024.png')));
  }
  setupTray();

  serverToken = readToken();
  if (!serverToken) {
    console.warn('警告：未找到 ~/.kimi-code/server.token，web UI 可能无法自动登录。先在任意 kimi 会话中执行 /web 生成 token。');
  }

  win = await createWindow();
  try {
    serverPort = await ensureServer();
    const hash = serverToken ? `#token=${encodeURIComponent(serverToken)}` : '';
    await win.loadURL(`http://127.0.0.1:${serverPort}/${hash}`).catch(() => {});
  } catch (err) {
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      `<body style="font-family:-apple-system,sans-serif;color:#b00;padding:2em">${err.message}</body>`
    )).catch(() => {});
  }
  refreshTray();
});

app.on('activate', () => showWindow());

app.on('before-quit', () => {
  quitting = true;
  if (trayTimer) clearInterval(trayTimer);
  if (serverChild && serverChild.exitCode === null) {
    serverChild.kill('SIGTERM');
    serverChild = null;
  }
});
