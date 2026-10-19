/**
 * 设置页的「GitHub 同步」卡片（第九版）。
 *
 * 安全约定（DEVELOPER_GUIDE.md ADR-3 / ADR-4）：
 * - 这里永远拿不到完整 Token，只显示「是否已连接 + @login + 打码尾巴」；
 * - 所有 GitHub 网络请求都在主进程，本组件只调 api.githubXxx（IPC）。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, onGithubProgress } from './api';
import { Modal, toast } from './ui';
import { toastError } from './errors';
import {
  formatSyncProgress,
  isValidRepoName,
  normalizeRepoName,
  parseRepoList,
  type GithubDeviceCode,
  type GithubStatus,
  type GithubSyncProgress
} from '../../shared/github';

export function GithubCard(): ReactNode {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [reposText, setReposText] = useState('');
  const [clientIdText, setClientIdText] = useState('');
  const [busy, setBusy] = useState<'repos' | 'clientId' | 'connect' | 'logout' | ''>('');
  const [device, setDevice] = useState<GithubDeviceCode | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [progress, setProgress] = useState<GithubSyncProgress | null>(null);
  const [lastError, setLastError] = useState('');

  const applyStatus = useCallback((next: GithubStatus) => {
    setStatus(next);
    setReposText(next.repos.join('\n'));
    setClientIdText(next.clientId ?? '');
  }, []);

  useEffect(() => {
    void api
      .githubStatus()
      .then(applyStatus)
      .catch((err) => toastError('读不到 GitHub 设置：', err));
  }, [applyStatus]);

  // 同步进度（这个卡片不发起同步，但同步进行中切到设置页能看见进度）
  useEffect(() => {
    return onGithubProgress((p) => setProgress(p.repoTotal ? p : null));
  }, []);

  const connect = async (): Promise<void> => {
    setBusy('connect');
    setLastError('');
    try {
      const code = await api.githubRequestCode();
      setDevice(code);
      setWaiting(true);
      // 主进程负责轮询；这里只等结果
      const next = await api.githubPollToken();
      setDevice(null);
      setWaiting(false);
      applyStatus(next);
      toast(`GitHub 已连接：@${next.login ?? '已授权'}`);
    } catch (err) {
      setDevice(null);
      setWaiting(false);
      setLastError((err as Error).message || '授权失败');
      toastError('GitHub 授权失败：', err);
    } finally {
      setBusy('');
    }
  };

  const cancelAuth = (): void => {
    void api.githubCancelAuth().catch(() => undefined);
    setDevice(null);
    setWaiting(false);
    setBusy('');
    toast('已取消这次授权');
  };

  const saveRepos = async (): Promise<void> => {
    const list = parseRepoList(reposText);
    const rawParts = reposText
      .split(/[\s,，;；]+/)
      .map((part) => part.trim())
      .filter(Boolean);
    const invalid = rawParts.filter((part) => !isValidRepoName(normalizeRepoName(part)));
    if (invalid.length) {
      toast(`这些仓库名不对（要 owner/repo，不能有空格）：${invalid.slice(0, 3).join('、')}`, { ttl: 7000 });
      return;
    }
    setBusy('repos');
    try {
      const next = await api.githubSetConfig({ repos: list });
      applyStatus(next);
      toast(list.length ? `已保存 ${list.length} 个仓库` : '已清空仓库列表');
    } catch (err) {
      toastError('保存仓库失败：', err);
    } finally {
      setBusy('');
    }
  };

  const saveClientId = async (): Promise<void> => {
    setBusy('clientId');
    try {
      const next = await api.githubSetConfig({ clientId: clientIdText.trim() });
      applyStatus(next);
      toast('已保存 Client ID');
    } catch (err) {
      toastError('保存 Client ID 失败：', err);
    } finally {
      setBusy('');
    }
  };

  const logout = async (): Promise<void> => {
    setBusy('logout');
    try {
      const next = await api.githubLogout();
      applyStatus(next);
      toast('已断开 GitHub 授权（本地任务保留）');
    } catch (err) {
      toastError('断开失败：', err);
    } finally {
      setBusy('');
    }
  };

  const showDevice = device !== null;

  return (
    <div className="card github-card">
      <div className="card-head">
        <h2>GitHub 同步（Issues → 待办）</h2>
        <span className="spacer" style={{ flex: 1 }} />
        {status?.connected ? (
          <span className="badge ok">已连接 @{status.login ?? 'GitHub'}</span>
        ) : (
          <span className="badge">未连接</span>
        )}
      </div>

      <div className="set-row">
        <div className="txt">
          <b>授权状态</b>
          <p>
            {status?.connected
              ? `Token ${status.tokenHint ?? ''} · ${status.encrypted ? '已用系统加密存储（DPAPI）' : '未加密（系统不支持加密）'} · 上次同步 ${
                  status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : '还没同步过'
                }`
              : '用 GitHub 官方 Device Flow 授权，Token 只存本机（加密后进 meta 表），渲染层看不到原文。'}
          </p>
          <p className="muted">
            想接的仓库写在这里，一行一个 <code>owner/repo</code>。同步是单向的：GitHub → 本地待办，本地改动不会回写。
          </p>
        </div>
        {status?.connected ? (
          <button
            type="button"
            className={busy === 'logout' ? 'btn loading github-logout-btn' : 'btn github-logout-btn'}
            disabled={busy === 'logout'}
            onClick={() => void logout()}
          >
            {busy === 'logout' ? '断开中…' : '断开连接'}
          </button>
        ) : (
          <button
            type="button"
            className={busy === 'connect' ? 'btn primary loading github-connect-btn' : 'btn primary github-connect-btn'}
            disabled={busy === 'connect' || !status || status.clientIdSource === 'none'}
            title={
              status && status.clientIdSource === 'none'
                ? '还没有 GitHub OAuth App 的 Client ID：让开发者用 JWKB_GITHUB_CLIENT_ID 启动，或在下面填'
                : '用 GitHub 官方 Device Flow 授权'
            }
            onClick={() => void connect()}
          >
            {busy === 'connect' ? '等待授权…' : '连接 GitHub'}
          </button>
        )}
      </div>

      <div className="set-row">
        <div className="txt">
          <b>要同步的仓库</b>
          <p>一行一个，格式 owner/repo（GitHub 网页地址也可以，会自动去掉 https://github.com/ 和 .git）。</p>
        </div>
        <textarea
          className="input github-repos"
          rows={3}
          spellCheck={false}
          placeholder={'x-000001/zhishiku\n另一个用户/另一个仓库'}
          value={reposText}
          onChange={(e) => setReposText(e.target.value)}
        />
      </div>
      <div className="set-row">
        <div className="txt">
          <b>仓库列表</b>
          <p className="muted">
            {parseRepoList(reposText).length
              ? `将同步 ${parseRepoList(reposText).length} 个仓库：${parseRepoList(reposText).join('、')}`
              : '还没有配置仓库。'}
          </p>
        </div>
        <button
          type="button"
          className={busy === 'repos' ? 'btn primary loading' : 'btn primary'}
          disabled={busy === 'repos'}
          onClick={() => void saveRepos()}
        >
          {busy === 'repos' ? '保存中…' : '保存仓库列表'}
        </button>
      </div>

      <div className="set-row">
        <div className="txt">
          <b>OAuth App Client ID</b>
          <p>
            公开值（不是 secret）。{status?.clientIdSource === 'env' ? '当前来自启动环境变量 JWKB_GITHUB_CLIENT_ID。' : ''}
            {status?.clientIdSource === 'setting' ? '当前来自这里保存的值。' : ''}
            {status?.clientIdSource === 'none' ? '还没配置，没它不能发起 Device Flow。' : ''}
          </p>
        </div>
        <input
          className="input github-client-id"
          style={{ width: 260 }}
          spellCheck={false}
          placeholder="Iv1.0123456789abcdef"
          value={clientIdText}
          onChange={(e) => setClientIdText(e.target.value)}
        />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button
          type="button"
          className={busy === 'clientId' ? 'btn loading' : 'btn'}
          disabled={busy === 'clientId'}
          onClick={() => void saveClientId()}
        >
          {busy === 'clientId' ? '保存中…' : '保存 Client ID'}
        </button>
      </div>

      {progress ? (
        <p className="muted github-progress">{formatSyncProgress(progress)}</p>
      ) : lastError ? (
        <p className="muted github-error">上次同步失败：{lastError}</p>
      ) : null}

      {showDevice ? (
        <Modal
          title="在 GitHub 上授权"
          width={480}
          onClose={() => (waiting ? cancelAuth() : setDevice(null))}
          footer={
            <button type="button" className="btn" onClick={cancelAuth}>
              取消授权
            </button>
          }
        >
          <div className="github-device">
            <p>复制下面的验证码，点按钮打开 GitHub 粘贴并授权。这里会自动等结果（最多 15 分钟）。</p>
            <div className="github-user-code">{device?.userCode}</div>
            <div className="row" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn sm"
                onClick={() => void api.copyText(device?.userCode ?? '').then(() => toast('验证码已复制'))}
              >
                复制验证码
              </button>
              <button
                type="button"
                className="btn sm primary"
                onClick={() => {
                  if (!device) return;
                  void api.githubOpenUrl(device.verificationUri || 'https://github.com/login/device').catch((err: Error) =>
                    toastError('打不开浏览器：', err)
                  );
                }}
              >
                打开 GitHub 授权页
              </button>
            </div>
            <p className="muted">
              {waiting ? '正在等待你完成授权…完成后这个窗口会自动关掉。' : '这次授权已经结束，可以重试。'}
            </p>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
