import { BrowserWindow, Menu, Notification, Tray, app, dialog, globalShortcut, nativeImage, net, protocol, screen, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { attachmentRelFromUrl } from '../shared/html';
import {
  closeDatabase,
  dbPaths,
  dueTasksForNotice,
  getSetting,
  integrityCheck,
  openDatabase,
  setSetting,
  sqliteVersion
} from './db';
import { ensureDirs, resolveDataRoot, todayLocal, writeLocator, type DataPaths } from './paths';
import { maybeDailyBackup } from './backup';
import { registerIpc } from './ipc';

let mainWindow: BrowserWindow | null = null;
let captureWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let dataPaths: DataPaths;
let quitting = false;

const notified = new Set<string>();
let noticeTimer: NodeJS.Timeout | null = null;

/**
 * 笔记正文里的图片用 jw-att:// 指向数据目录里的附件：
 * 存进库里的是相对路径，渲染进程不用知道 D 盘真实位置，也不用放开 file:// 权限。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'jw-att',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
]);

/** 把 jw-att://attachments/2026-10/a.png 映射到数据目录里的真实文件。 */
function registerAttachmentProtocol(): void {
  protocol.handle('jw-att', (request) => {
    const rel = attachmentRelFromUrl(request.url);
    if (!rel) return new Response('附件地址不对', { status: 400 });
    const root = path.resolve(dbPaths().root);
    const abs = path.resolve(root, rel);
    // 只允许数据目录里的文件，防止 URL 里写 ../ 爬出去
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      return new Response('越界了', { status: 403 });
    }
    if (!fs.existsSync(abs)) return new Response('附件不在了', { status: 404 });
    return net.fetch(pathToFileURL(abs).toString());
  });
}

function resourcePath(name: string): string {
  const candidates = [
    path.join(app.getAppPath(), 'resources', name),
    path.join(__dirname, '../../resources', name),
    path.join(process.resourcesPath ?? '', name)
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return candidates[0] as string;
}

function iconFor(size: 'app' | 'tray'): Electron.NativeImage {
  const img = nativeImage.createFromPath(resourcePath(size === 'app' ? 'icon.png' : 'tray.png'));
  return size === 'tray' ? img.resize({ width: 16, height: 16 }) : img;
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

function savedBounds(): Electron.Rectangle | null {
  try {
    const raw = getSetting('winBounds');
    if (!raw) return null;
    const b = JSON.parse(raw) as Electron.Rectangle;
    if (typeof b.x === 'number' && typeof b.width === 'number' && b.width > 400) {
      // 换过显示器、或者外接屏拔掉以后，上次的位置可能已经在屏幕外了。
      // 这时不要硬套旧坐标，交回默认居中，否则窗口会「打开但看不见」。
      const visible = screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return (
          b.x < a.x + a.width - 80 &&
          b.x + b.width > a.x + 80 &&
          b.y < a.y + a.height - 80 &&
          b.y + (b.height ?? 0) > a.y + 40
        );
      });
      if (!visible) return null;
      return b;
    }
  } catch {
    // 损坏的窗口位置直接忽略
  }
  return null;
}

function createMainWindow(): BrowserWindow {
  const bounds = savedBounds();
  const win = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 820,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: 'Jw 知识库',
    icon: iconFor('app'),
    backgroundColor: '#f5f6fa',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.once('ready-to-show', () => win.show());

  win.on('close', (event) => {
    if (!quitting && getSetting('closeToTray') !== '0') {
      event.preventDefault();
      win.hide();
      return;
    }
    const b = win.getBounds();
    setSetting('winBounds', JSON.stringify(b));
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
  return win;
}

function createCaptureWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 560,
    height: 148,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: '快速记录',
    icon: iconFor('app'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(`${devUrl}#/quick`);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: '/quick' });
  }
  win.on('blur', () => win.hide());
  return win;
}

function showMain(route?: string): void {
  if (!mainWindow) mainWindow = createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (route) mainWindow.webContents.send('nav:go', route);
}

function toggleCapture(): void {
  if (!captureWindow) captureWindow = createCaptureWindow();
  if (captureWindow.isVisible()) {
    captureWindow.hide();
    return;
  }
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x, y, width } = display.workArea;
  captureWindow.setPosition(Math.round(x + (width - 560) / 2), Math.round(y + display.workArea.height * 0.22));
  captureWindow.show();
  captureWindow.focus();
  captureWindow.webContents.send('capture:focus');
}

/* ------------------------------------------------------------------ */
/* 托盘                                                                */
/* ------------------------------------------------------------------ */

function createTray(): void {
  try {
    tray = new Tray(iconFor('tray'));
  } catch (err) {
    console.error('[托盘] 创建失败：', err);
    return;
  }
  const menu = Menu.buildFromTemplate([
    { label: '打开主窗口', click: () => showMain() },
    { label: '快速记录', accelerator: 'Ctrl+Alt+Space', click: () => toggleCapture() },
    { label: '今日待办', click: () => showMain('/tasks') },
    { type: 'separator' },
    { label: '打开数据文件夹', click: () => void shell.openPath(dataPaths.root) },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true;
        app.quit();
      }
    }
  ]);
  tray.setToolTip('Jw 知识库');
  tray.setContextMenu(menu);
  tray.on('double-click', () => showMain());
}

/* ------------------------------------------------------------------ */
/* 到期提醒                                                            */
/* ------------------------------------------------------------------ */

function checkDue(): void {
  if (getSetting('notifyEnabled') === '0') return;
  if (!Notification.isSupported()) return;
  const today = todayLocal();
  const tasks = dueTasksForNotice();
  for (const task of tasks) {
    const key = `${task.id}:${today}`;
    if (notified.has(key)) continue;
    notified.add(key);
    const overdue = task.due_at ? task.due_at.slice(0, 10) < today : false;
    const notification = new Notification({
      title: overdue ? '有任务已经逾期' : '今天的任务到点了',
      body: task.title,
      silent: false
    });
    notification.on('click', () => showMain('/tasks'));
    notification.show();
  }
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());

  function startup(): void {
    // 明确不要开机自启（与需求一致）
    app.setLoginItemSettings({ openAtLogin: false });

    const resolved = resolveDataRoot();
    // 只有正常启动才把数据目录记进定位文件；用环境变量临时指到别处（开发/自检）时不要污染它
    if (!process.env.JWKB_DATA_DIR?.trim()) writeLocator(resolved.root);
    dataPaths = ensureDirs(resolved.root, resolved.fallback);
    openDatabase(dataPaths);
    if (resolved.fallback) {
      console.warn('[数据] D 盘不可用，已退到：', dataPaths.root);
    }

    // 启动自检：数据库完整性
    const integrity = integrityCheck();
    if (integrity !== 'ok') console.error('[数据] 完整性检查未通过：', integrity);

    registerIpc(() => dataPaths, sqliteVersion());
    registerAttachmentProtocol();
    Menu.setApplicationMenu(null);

    mainWindow = createMainWindow();
    createTray();

    globalShortcut.register('Control+Alt+Space', () => toggleCapture());

    const created = maybeDailyBackup(dataPaths);
    if (created) console.log('[备份] 今日自动备份：', created.name);

    checkDue();
    // 一分钟看一眼有没有到点的任务。内存里用 Set 去重，同一条当天只提醒一次，
    // 所以即使频繁轮询也不会反复弹窗。
    noticeTimer = setInterval(checkDue, 60 * 1000);

    app.on('activate', () => showMain());
  }

  app.whenReady()
    .then(startup)
    .catch((err: unknown) => {
      const message = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
      console.error('[启动] 失败：', message);
      try {
        dialog.showErrorBox('Jw 知识库没能启动', `数据目录：${dataPaths?.root ?? '未确定'}\n\n${message}`);
      } catch {
        // 连弹窗都起不来就只剩日志了
      }
      app.exit(1);
    });

  app.on('window-all-closed', () => {
    // 关闭窗口只是缩托盘，真正退出走托盘菜单或 Cmd/Ctrl+Q
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  app.on('will-quit', () => {
    if (noticeTimer) clearInterval(noticeTimer);
    globalShortcut.unregisterAll();
    closeDatabase();
    try {
      void dbPaths();
    } catch {
      // 数据库没打开过就无所谓
    }
  });
}
