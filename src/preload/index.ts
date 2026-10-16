import { contextBridge, ipcRenderer } from 'electron';

const ALLOWED_EVENTS = new Set(['nav:go', 'capture:focus', 'notice:due']);

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
  }
};

contextBridge.exposeInMainWorld('api', api);
