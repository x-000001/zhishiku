import fs from 'node:fs';
import { BrowserWindow, dialog, shell } from 'electron';
import * as db from '../db';
import { exportNotesToMarkdown } from '../export';
import type { Handle } from './common';
/**
 * 第八版任务四：导出全库为 Markdown。
 * 选文件夹、写盘都在主进程；进度用 'export:progress' 事件推给渲染层（和软件更新一个套路）。
 */

export interface ExportRunResult {
  canceled: boolean;
  dir: string;
  folders: number;
  notes: number;
  attachments: number;
  missing: string[];
}

function broadcastProgress(progress: { done: number; total: number; title: string }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('export:progress', progress);
  }
}

export function registerExport(handle: Handle): void {
  handle('export:markdown', async (): Promise<ExportRunResult> => {
    // e2e 不可能点系统对话框，所以给它一个环境变量直接指定目录（生产环境不会设这个变量）
    const override = (process.env.JWKB_EXPORT_DIR ?? '').trim();
    let dir = override;

    if (!dir) {
      const options: Electron.OpenDialogOptions = {
        title: '选择导出位置（会在这个文件夹里按分类建目录）',
        properties: ['openDirectory', 'createDirectory']
      };
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (picked.canceled || picked.filePaths.length === 0) {
        return { canceled: true, dir: '', folders: 0, notes: 0, attachments: 0, missing: [] };
      }
      dir = picked.filePaths[0];
    }

    const result = exportNotesToMarkdown(dir, {
      listNotes: () => db.listNotes().map((note) => ({ id: note.id, title: note.title, categoryId: note.category_id })),
      getNote: (id) => db.getNote(id),
      categories: () => db.categoryTree(),
      attachmentAbsPath: (relPath) => db.attachmentAbsPath(relPath),
      onProgress: (done, total, title) => broadcastProgress({ done, total, title })
    });

    return { canceled: false, ...result };
  });

  // 导出完成后「打开文件夹」：只认真实存在的目录，避免渲染层传任意路径过来
  handle('export:reveal', async (payload: { dir?: string }) => {
    const dir = String(payload?.dir ?? '').trim();
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error('这个文件夹已经不在原来的位置了');
    }
    const message = await shell.openPath(dir);
    if (message) throw new Error(`打不开这个文件夹：${message}`);
    return true;
  });
}
