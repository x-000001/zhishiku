import { app } from 'electron';
import os from 'node:os';
import * as db from '../db';
import { backgroundMaterialName } from '../material';
import type { AppSettings } from '../../shared/types';
import type { Handle, IpcDeps } from './common';

/** 应用信息与设置：版本、数据目录、主题、版本保留数、托盘行为。 */
export function registerCore(handle: Handle, deps: IpcDeps): void {
  handle('app:info', () => {
    const p = deps.getPaths();
    return {
      dataRoot: p.root,
      dbPath: p.db,
      attachmentsDir: p.attachments,
      backupsDir: p.backups,
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      node: process.versions.node ?? '',
      sqlite: deps.sqliteVersion,
      material: backgroundMaterialName(),
      windowsBuild: Number(os.release().split('.')[2] ?? '0')
    };
  });

  handle('settings:get', (): AppSettings => {
    const s = db.allSettings();
    return {
      dataRoot: deps.getPaths().root,
      versionKeep: Number(s.versionKeep ?? '20'),
      theme: (s.theme as 'light' | 'dark') ?? 'light',
      notifyEnabled: s.notifyEnabled === '1',
      closeToTray: s.closeToTray === '1'
    };
  });

  handle('settings:set', (payload: { key: string; value: string | number | boolean }) => {
    db.setSetting(payload.key, typeof payload.value === 'boolean' ? (payload.value ? '1' : '0') : String(payload.value));
    return db.allSettings();
  });
}
