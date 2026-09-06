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
