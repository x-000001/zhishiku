import { toast } from './ui';

/**
 * 把 catch 到的未知异常压成一句人话。
 *
 * 主进程那边所有 IPC 错误都会被包成 Error 再抛过来，所以九成情况下就是 err.message；
 * 剩下的一成（throw 了个字符串、null、undefined）也不能让界面冒出「undefined」。
 */
export function errText(err: unknown, fallback = '未知错误'): string {
  if (err instanceof Error) return err.message || fallback;
  if (typeof err === 'string' && err) return err;
  return fallback;
}

/**
 * 「XX失败：<原因>」的统一写法，省得每个 catch 都拼一遍字符串。
 * 前缀里带不带冒号都行，保持调用处原来的文案不改。
 */
export function toastError(prefix: string, err: unknown): void {
  toast(prefix + errText(err));
}
