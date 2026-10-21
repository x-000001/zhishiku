import { contextBridge, ipcRenderer, webUtils } from 'electron';

const ALLOWED_EVENTS = new Set([
  'nav:go',
  'capture:focus',
  'notice:due',
  'update:progress',
  'focus:state',
  'github:progress',
  'github:auth',
  'ai:stream',
  'export:progress'
]);

const api = {
  async invoke<T = unknown>(channel: string, payload?: unknown): Promise<T> {
    const res = (await ipcRenderer.invoke(channel, payload)) as
      | { ok: true; data: T }
      | { ok: false; error: string };
    if (res && typeof res === 'object' && 'ok' in res) {
      if (res.ok) return res.data;
      throw new Error(res.error);
    }
    return res as T;
  },
  on(channel: string, listener: (payload: unknown) => void): () => void {
    if (!ALLOWED_EVENTS.has(channel)) {
      throw new Error('未开放的事件通道：' + channel);
    }
    const wrapped = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
  /**
   * 拖进来的文件在渲染层只能拿到 File 对象，Electron 32 之后不再有 file.path，
   * 必须用 webUtils.getPathForFile 换成真实绝对路径，主进程才能复制它。
   */
  pathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  }
};

contextBridge.exposeInMainWorld('api', api);
