/**
 * Device Flow 的纯逻辑小工具（0.11.0 重构抽出）。
 *
 * 这里刻意不 import electron / fetch / db：只做「算时间、打码、翻译错误」，
 * 因此可以直接被 Vitest 覆盖；真正的网络与 IPC 编排在 `src/main/ipc/github.ts`。
 */
import { GITHUB_AUTH_ERRORS, type GithubAuthEvent } from '../shared/github';
import { GithubError, describeGithubError } from './github';

/**
 * 设备码的绝对截止时间。
 *
 * 坑：`expires_in` 是从**收到响应**那一刻开始算的，不是从发起请求时算。
 * 如果按「发起时间 + 900 秒」推，网络慢的时候截止时间会被提前，用户明明还有效却被判过期。
 */
export function deviceCodeDeadline(receivedAt: number, expiresInSeconds: number): number {
  const seconds =
    Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? Math.floor(expiresInSeconds) : 900;
  return receivedAt + seconds * 1000;
}

/** 日志里只允许出现打码后的 Token（`gho_…abcd` 这种），全文绝不出现在终端。 */
export function maskSecret(token: string): string | null {
  if (!token) return null;
  if (token.length <= 8) return '…';
  return `${token.slice(0, 3)}…${token.slice(-4)}`;
}

/**
 * 把轮询阶段的异常翻译成推给渲染层的事件。
 *
 * - 设备码过期 / 轮询超时 → `expired`（UI 复位成「获取新验证码」）
 * - 用户在网页上拒绝 → `denied`
 * - 用户主动取消 / 登出（canceled）→ `null`：我们自己取消的，不该再弹错误
 * - 其它（网络、Client ID、限流）→ `error`
 */
export function authFailureEvent(err: unknown): GithubAuthEvent | null {
  if (err instanceof GithubError) {
    if (err.kind === 'timeout') {
      return { type: 'expired', message: GITHUB_AUTH_ERRORS.expired };
    }
    if (err.kind === 'canceled') {
      if (err.message === GITHUB_AUTH_ERRORS.expired) {
        return { type: 'expired', message: GITHUB_AUTH_ERRORS.expired };
      }
      if (err.message === GITHUB_AUTH_ERRORS.denied) {
        return { type: 'denied', message: GITHUB_AUTH_ERRORS.denied };
      }
      // 主动取消：静默收摊，不再打扰用户。
      return null;
    }
    return { type: 'error', message: describeGithubError(err) };
  }
  return { type: 'error', message: describeGithubError(err) };
}
