import type { BrowserWindow } from 'electron';
import type { DataPaths } from '../paths';

/** 所有 IPC 的统一回包形状：渲染层只看 ok / data / error，不抛异常。 */
export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** 注册一个普通通道：payload 从渲染层来，返回值/异常由 wrap 兜成 Result。 */
export type Handle = <T>(channel: string, fn: (payload: never) => T | Promise<T>) => void;

/** 注册一个需要「发消息的那个窗口」的通道（最小化/最大化/关闭）。 */
export type HandleWindow = (channel: string, fn: (win: BrowserWindow) => unknown) => void;

export interface IpcDeps {
  getPaths: () => DataPaths;
  sqliteVersion: string;
}

/** 统一的异常兜底：主进程这边出错只记日志 + 回一个 ok:false，不让渲染层收到裸异常。 */
export function wrap<T>(fn: (payload: never) => T | Promise<T>) {
  return async (_event: unknown, payload: unknown): Promise<Result<T>> => {
    try {
      return { ok: true, data: await fn(payload as never) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[IPC] 处理失败：', message);
      return { ok: false, error: message };
    }
  };
}
