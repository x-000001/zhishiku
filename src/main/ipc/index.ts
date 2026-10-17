import { BrowserWindow, ipcMain } from 'electron';
import type { DataPaths } from '../paths';
import { wrap, type Handle, type HandleWindow, type IpcDeps, type Result } from './common';
import { registerCore } from './core';
import { registerNotes } from './notes';
import { registerTasks } from './tasks';
import { registerGoals } from './goals';
import { registerPlans } from './plans';
import { registerReview } from './review';
import { registerSystem, registerWindow } from './system';
import { registerUpdate } from './update';
import { registerFocus } from './focus';

/**
 * 把全部 IPC 通道挂上。原来是 400 行一个函数，现在按域分开放：
 * 每块只认 handle() 这个注册器，错误兜底、去重注册都集中在 common.ts。
 */
export function registerIpc(getPaths: () => DataPaths, sqliteVersion: string): void {
  const has = (channel: string) => ipcMain.removeHandler(channel);
  const handle: Handle = (channel, fn) => {
    has(channel);
    ipcMain.handle(channel, wrap(fn));
  };
  const handleWindow: HandleWindow = (channel, fn) => {
    has(channel);
    ipcMain.handle(channel, (event): Result<unknown> => {
      try {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win) return { ok: false, error: '窗口不存在' };
        return { ok: true, data: fn(win) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[IPC] 窗口操作失败：', message);
        return { ok: false, error: message };
      }
    });
  };

  const deps: IpcDeps = { getPaths, sqliteVersion };
  registerCore(handle, deps);
  registerNotes(handle);
  registerTasks(handle);
  registerGoals(handle);
  registerPlans(handle);
  registerReview(handle);
  registerSystem(handle, deps);
  registerUpdate(handle);
  registerFocus(handle);
  registerWindow(handleWindow);
}
