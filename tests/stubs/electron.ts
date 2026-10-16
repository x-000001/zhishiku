import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `electron` 替身。单元测试只覆盖纯逻辑与数据层，不启动真实 Electron，
// 因此这里只需要让模块能正常导入、并给 app.getPath 一个可写的临时目录。
const fakeAppData = path.join(os.tmpdir(), 'jwkb-electron-stub');
fs.mkdirSync(fakeAppData, { recursive: true });

export const app = {
  getPath(name: string): string {
    if (name === 'appData') return fakeAppData;
    if (name === 'userData') return path.join(fakeAppData, 'userData');
    if (name === 'home') return os.homedir();
    if (name === 'temp') return os.tmpdir();
    return fakeAppData;
  },
  getAppPath(): string {
    return process.cwd();
  },
  isPackaged: false,
  setLoginItemSettings(): void {},
  requestSingleInstanceLock(): boolean {
    return true;
  },
  on(): void {},
  quit(): void {},
  whenReady(): Promise<void> {
    return Promise.resolve();
  }
};

export const ipcMain = {
  handle(): void {},
  removeHandler(): void {}
};

export const BrowserWindow = class {
  static getAllWindows(): unknown[] {
    return [];
  }
};

export const dialog = {
  showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({
    canceled: true,
    filePaths: []
  }),
  showMessageBox: async (): Promise<{ response: number }> => ({ response: 0 })
};

export const shell = {
  openPath: async (): Promise<string> => '',
  showItemInFolder(): void {}
};

export const Notification = class {
  static isSupported(): boolean {
    return false;
  }
  show(): void {}
};

export const Tray = class {
  setToolTip(): void {}
  setContextMenu(): void {}
  on(): void {}
};

export const Menu = {
  setApplicationMenu(): void {},
  buildFromTemplate(): unknown {
    return {};
  }
};

export const nativeImage = {
  createFromPath(): { resize: () => unknown } {
    return { resize: () => ({}) };
  }
};

export const globalShortcut = {
  register(): boolean {
    return true;
  },
  unregisterAll(): void {}
};

export const screen = {
  getCursorScreenPoint: (): { x: number; y: number } => ({ x: 0, y: 0 }),
  getDisplayNearestPoint: (): { workArea: { x: number; y: number; width: number; height: number } } => ({
    workArea: { x: 0, y: 0, width: 1280, height: 800 }
  })
};
