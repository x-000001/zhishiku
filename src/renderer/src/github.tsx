/**
 * 设置页的「GitHub」卡片：只负责授权（Device Flow）与 Client ID。
 *
 * 项目搜集的入口在「收集箱」页顶部（见 pages/Inbox.tsx），这样设置页保持轻量，
 * 授权状态与导入动作各归其位。
 *
 * 安全约定（DEVELOPER_GUIDE.md ADR-3 / ADR-4）：
 * - 这里永远拿不到完整 Token，只显示「是否已连接 + @login + 打码尾巴」；
 * - 所有 GitHub 网络请求都在主进程，本组件只调 api.githubXxx（IPC）。
 *
 * 0.11.0 重构（修「浏览器已授权但软件没反应」）：
 * - 轮询改由**主进程**在后台做，渲染层不再开定时器反复调 IPC；
 * - 结果通过 `github:auth` 事件推过来（验证码 / 已连接 / 过期 / 拒绝）；
 * - 弹窗按 `expiresAt` 自己算「剩余有效期 X 分 Y 秒」，过期后按钮复位成「获取新验证码」；
 * - 所有异步回调 setState 前都检查 isMounted，卸载时摘监听并取消授权。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, onGithubAuth } from './api';
import { errText, toastError } from './errors';
import { Modal, toast } from './ui';
import type { GithubAuthCode, GithubStatus } from '../../shared/github';

export function GithubCard(): ReactNode {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [clientId, setClientId] = useState('');
  const [busy, setBusy] = useState<'' | 'save' | 'connect' | 'logout'>('');
  const [error, setError] = useState('');
  const [code, setCode] = useState<GithubAuthCode | null>(null);
  const [polling, setPolling] = useState(false);
  /** 验证码剩余秒数，每秒本地重算（主进程只给 expiresAt 绝对时间戳）。 */
  const [remaining, setRemaining] = useState(0);
  /** 组件是否还挂着：卸载后任何回调都不许 setState。 */
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .githubStatus()
      .then((next) => {
        if (!mountedRef.current) return;
        setStatus(next);
        setClientId(next.clientId ?? '');
      })
      .catch((err: Error) => {
        if (mountedRef.current) setError(errText(err));
      });

    const off = onGithubAuth((event) => {
      if (!mountedRef.current) return;
      if (event.type === 'code') {
        setCode(event.code);
        setPolling(true);
        setError('');
        return;
      }
      if (event.type === 'authorized') {
        setStatus(event.status);
        setCode(null);
        setPolling(false);
        setError('');
        toast(`已连接：@${event.status.login ?? 'GitHub 用户'}`);
        return;
      }
      // expired / denied / error：都收掉弹窗，把原因留给卡片里的红字。
      setCode(null);
      setPolling(false);
      setError(event.message);
    });

    return () => {
      // 卸载：摘监听 + 取消还在等待的授权（主进程会 abort 网络与定时器）。
      mountedRef.current = false;
      off();
      void api.githubCancelAuth().catch(() => undefined);
    };
  }, []);

  // 倒计时：每秒刷新一次；到期后显示 0，等主进程推 expired 再复位按钮。
  useEffect(() => {
    if (!code) {
      setRemaining(0);
      return;
    }
    const tick = (): void => {
      setRemaining(Math.max(0, Math.ceil((code.expiresAt - Date.now()) / 1000)));
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [code]);

  async function saveClientId(): Promise<void> {
    setBusy('save');
    setError('');
    try {
      const next = await api.githubSetConfig({ clientId: clientId.trim() });
      if (!mountedRef.current) return;
      setStatus(next);
      toast('已保存 Client ID');
    } catch (err) {
      if (!mountedRef.current) return;
      setError(errText(err));
      toastError('保存 Client ID 失败：', err);
    } finally {
      if (mountedRef.current) setBusy('');
    }
  }

  async function startConnect(): Promise<void> {
    setBusy('connect');
    setError('');
    try {
      const next = await api.githubRequestCode();
      if (!mountedRef.current) return;
      // 事件也会推一份；直接用返回值是为了点完立刻出弹窗，不等下一跳。
      setCode(next);
      setPolling(true);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(errText(err));
      toastError('发起 GitHub 授权失败：', err);
    } finally {
      if (mountedRef.current) setBusy('');
    }
  }

  async function cancelConnect(): Promise<void> {
    setCode(null);
    setPolling(false);
    try {
      await api.githubCancelAuth();
    } catch {
      /* 取消失败不影响本地状态 */
    }
  }

  async function logout(): Promise<void> {
    setBusy('logout');
    setError('');
    try {
      const next = await api.githubLogout();
      if (!mountedRef.current) return;
      setStatus(next);
      toast('已断开 GitHub 连接（收集箱里已导入的条目还在）');
    } catch (err) {
      if (!mountedRef.current) return;
      setError(errText(err));
      toastError('断开连接失败：', err);
    } finally {
      if (mountedRef.current) setBusy('');
    }
  }

  const connected = Boolean(status?.connected);
  /** 过期后按钮文案要变成「获取新验证码」，让用户知道下一步做什么。 */
  const expiredHint = !connected && !code && /过期/.test(error);

  return (
    <div className="card github-card">
      <div className="card-head">
        <h2>GitHub 项目搜集</h2>
        <span className="spacer" />
        <span className={connected ? 'badge badge-ok' : 'badge'}>
          {connected ? `已连接 @${status?.login ?? '…'}` : '未连接'}
        </span>
      </div>

      <div className="set-row">
        <div className="txt">
          <b>授权状态</b>
          <p>
            用 GitHub 官方 Device Flow 授权，Token 只存在本机（加密后进 meta 表），渲染层看不到原文。
          </p>
          <p className="muted">
            {connected
              ? `Token ${status?.tokenHint ?? ''} · ${status?.encrypted ? '已用系统加密存储（DPAPI）' : '未加密（系统加密不可用）'}`
              : '还没连接。连接后可以导入私有仓库；不连接也能导入公开仓库。'}
          </p>
        </div>
        {connected ? (
          <button className="btn sm" disabled={busy === 'logout'} onClick={() => void logout()}>
            {busy === 'logout' ? '断开中…' : '断开连接'}
          </button>
        ) : (
          <button
            className="btn sm primary"
            disabled={busy === 'connect' || polling}
            onClick={() => void startConnect()}
          >
            {polling ? '等待授权…' : expiredHint ? '获取新验证码' : '连接 GitHub'}
          </button>
        )}
      </div>

      <div className="set-row">
        <div className="txt">
          <b>OAuth App Client ID</b>
          <p>公开值（不是 secret）。发起 Device Flow 必须有一个启用了 Device Flow 的 OAuth App。</p>
          <p className="muted">
            {status?.clientIdSource === 'env'
              ? '当前来自启动环境变量 JWKB_GITHUB_CLIENT_ID。'
              : status?.clientIdSource === 'setting'
                ? '当前来自本机设置。'
                : '还没配置：填一个 Client ID，或用 JWKB_GITHUB_CLIENT_ID 启动。'}
          </p>
        </div>
        <div className="row-tight">
          <input
            className="input github-client-id"
            style={{ width: 260 }}
            value={clientId}
            placeholder="比如 lv1.0123456789abcdef"
            onChange={(e) => setClientId(e.target.value)}
          />
          <button className="btn sm" disabled={busy === 'save'} onClick={() => void saveClientId()}>
            {busy === 'save' ? '保存中…' : '保存 Client ID'}
          </button>
        </div>
      </div>

      {error ? <p className="github-error">{error}</p> : null}
      <p className="muted github-hint">
        导入入口在「收集箱」页顶部：粘一个 GitHub 链接，选「仅保存链接」或「保存并 AI 提炼」。
        AI 提炼会把 README 发给设置里的模型服务（只发这一步，本地功能不受影响）。
      </p>

      {code ? (
        <Modal
          variant="github-device"
          title="在 GitHub 上授权"
          width={520}
          onClose={() => void cancelConnect()}
          footer={
            <>
              <button className="btn" onClick={() => void cancelConnect()}>
                取消授权
              </button>
              <button
                className="btn"
                onClick={() => {
                  void navigator.clipboard.writeText(code.userCode);
                  toast('验证码已复制');
                }}
              >
                复制验证码
              </button>
              <button
                className="btn primary"
                onClick={() => void api.githubOpenUrl(code.verificationUri)}
              >
                打开 GitHub 授权页
              </button>
            </>
          }
        >
          <div className="github-device-body">
            <p>在 GitHub 页面里输入这个验证码：</p>
            <div className="github-user-code">{code.userCode}</div>
            <p className="muted">
              地址：{code.verificationUri} · 剩余有效期 {Math.floor(remaining / 60)} 分{' '}
              {remaining % 60} 秒
            </p>
            <p className="muted">
              {polling
                ? '正在等待你在浏览器里确认…（授权完成后会自动连上，不用点别的）'
                : '授权完成后窗口会自动关闭。'}
            </p>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
