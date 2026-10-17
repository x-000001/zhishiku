import { BrowserWindow, dialog, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import * as db from '../db';
import * as backup from '../backup';
import type { Id } from '../../shared/types';
import type { Handle, HandleWindow, IpcDeps } from './common';

/** 附件、备份恢复、数据自检、在文件管理器里定位。 */
export function registerSystem(handle: Handle, deps: IpcDeps): void {
  handle('attach:add', async (p: { noteId: Id | null }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const picked = win
      ? await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], title: '添加附件' })
      : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], title: '添加附件' });
    if (picked.canceled) return [];
    return picked.filePaths.map((file) => db.addAttachment(p.noteId, file, path.basename(file)));
  });
  handle('attach:open', (p: { id: Id; relPath: string }) => {
    const abs = db.attachmentAbsPath(p.relPath);
    if (!fs.existsSync(abs)) throw new Error('文件已不在原位：' + p.relPath);
    return shell.openPath(abs);
  });
  handle('attach:delete', (p: { id: Id }) => {
    db.deleteAttachment(p.id);
    return true;
  });
  /** 拖拽进来的文件：渲染层拿得到绝对路径，直接复制进附件目录。 */
  handle('attach:add-path', (p: { noteId: Id | null; srcPath: string }) => {
    if (!p?.srcPath) throw new Error('没有取到文件路径');
    if (!fs.existsSync(p.srcPath)) throw new Error('找不到这个文件：' + p.srcPath);
    return db.addAttachment(p.noteId, p.srcPath, path.basename(p.srcPath));
  });

  /* ---------------- 备份与恢复 ---------------- */

  handle('backup:list', () => backup.listBackups(deps.getPaths()));
  handle('backup:run', () => backup.runBackup(deps.getPaths(), true));
  handle('backup:restore', (p: { name: string }) => {
    const r = backup.restoreBackup(deps.getPaths(), p.name);
    db.rebuildSearchIndex();
    return r;
  });
  handle('backup:delete', (p: { name: string }) => {
    backup.deleteBackup(deps.getPaths(), p.name);
    return true;
  });
  handle('backup:reveal', () => shell.openPath(deps.getPaths().backups));
  handle('data:reveal', () => shell.openPath(deps.getPaths().root));
  handle('data:integrity', () => db.integrityCheck());
}

/** 自绘标题栏的三个点：要拿到「发消息的那个窗口」，所以单走一条注册路径。 */
export function registerWindow(handleWindow: HandleWindow): void {
  handleWindow('win:minimize', (win) => {
    win.minimize();
    return true;
  });
  handleWindow('win:toggle-max', (win) => {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  handleWindow('win:close', (win) => {
    win.close();
    return true;
  });
}
