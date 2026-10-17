import { BrowserWindow, Notification } from 'electron';
import { createFocus } from '../focus';
import * as db from '../db';
import type { FocusState, Id } from '../../shared/types';
import type { Handle } from './common';

/**
 * 任务栏进度条、闪任务栏这类效果都是「系统支持就用，不支持就算了」的锦上添花。
 * 便携版 / macOS / 某些 Linux 桌面可能不认，所以每个窗口都单独 try-catch，绝不连累计时。
 */
function withWindows(fn: (win: BrowserWindow) => void): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      fn(win);
    } catch {
      /* 平台不支持就静默降级 */
    }
  }
}

/**
 * 把计时引擎接到 Electron 上：通知、窗口广播、meta 表持久化都只在这一层做，
 * 引擎本身（src/main/focus.ts）不 import electron，所以能单测。
 */
const runtime = createFocus({
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  notify: (title, body) => {
    // 用户可以在设置里关掉通知；关了就连专注结束的系统通知也不弹（面板里照样有提示）
    if (db.getSetting('notifyEnabled') === '0') return;
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body, silent: false });
    notification.on('click', () => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
      }
    });
    notification.show();
  },
  emit: (state: FocusState) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('focus:state', state);
    }
  },
  persist: (state) => {
    if (state === null) db.clearFocusState();
    else db.saveFocusState(JSON.stringify(state));
  },
  progress: (ratio) => {
    // Windows 任务栏图标上的绿色进度条；-1 是隐藏（暂停/放弃/进休息/回到空闲）
    withWindows((win) => win.setProgressBar(ratio === null ? -1 : ratio));
  },
  flash: () => {
    // 到点时闪任务栏（Windows 上任务栏图标闪成橙色），用户点回窗口就停；
    // 窗口本来就在前台时没必要闪。
    withWindows((win) => {
      if (win.isFocused()) return;
      win.flashFrame(true);
      win.once('focus', () => win.flashFrame(false));
    });
  }
});

export function registerFocus(handle: Handle): void {
  // 启动时把上次没走完的会话接上（也会顺手清理悬空记录）
  runtime.restore();

  handle('focus:state', () => runtime.state());
  handle('focus:start', (payload: { plannedSeconds?: number; taskId?: Id | null; taskTitle?: string | null }) =>
    runtime.start(payload ?? {})
  );
  handle('focus:pause', () => runtime.pause());
  handle('focus:resume', () => runtime.resume());
  handle('focus:abandon', () => runtime.abandon());
  handle('focus:skip-break', () => runtime.skipBreak());
  handle('focus:summary', () => runtime.summary());
}
