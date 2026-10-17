import { app, net } from 'electron';
import { checkUpdate, UPDATE_URL, type UpdateFetcher } from '../update';
import type { UpdateCheck } from '../../shared/types';
import type { Handle } from './common';

/**
 * 真实的网络请求：走主进程的 net.fetch，不把任何网络库交给渲染层。
 * 5 秒超时由 checkUpdate 传进来的 AbortSignal 控制。
 */
const netFetcher: UpdateFetcher = async (url, init) => {
  const res = await net.fetch(url, { signal: init.signal, headers: init.headers });
  return { status: res.status, json: () => res.json() as Promise<unknown> };
};

/** 「检查更新」只在设置页手动触发：一次一个请求，不轮询、不常驻、不碰数据库。 */
export function registerUpdate(handle: Handle): void {
  handle('update:check', async (): Promise<UpdateCheck> => {
    // 测试启动时会用 JWKB_UPDATE_URL 指向本地 stub 服务器；生产环境永远是 GitHub 官方接口。
    const url = process.env.JWKB_UPDATE_URL?.trim() || UPDATE_URL;
    return checkUpdate(app.getVersion(), { fetcher: netFetcher, url });
  });
}
