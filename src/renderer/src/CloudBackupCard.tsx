import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import { Modal, toast } from './ui';
import { errText, toastError } from './errors';
import { fmtDateTime } from './format';
import {
  RESTORE_CONFIRM_WORD,
  canConfirmRestore,
  type CloudBackupInfo,
  type CloudConfigPublic,
  type CloudProvider
} from '../../shared/cloud';

function bytesText(n: number): string {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/**
 * 云端灾备卡片（0.12.0 阶段5）：WebDAV / GitHub 单向备份。
 * 恢复是最高危操作：红色确认框 + 必须输入 CONFIRM 或勾选「我已了解数据将被覆盖」，
 * 两个条件不满足时确认按钮一直禁用；主进程还会再校验一次。
 */
export default function CloudBackupCard(): ReactNode {
  const [config, setConfig] = useState<CloudConfigPublic | null>(null);
  const [info, setInfo] = useState<CloudBackupInfo | null>(null);
  const [infoError, setInfoError] = useState('');
  const [provider, setProvider] = useState<CloudProvider>('webdav');
  const [webdavUrl, setWebdavUrl] = useState('');
  const [webdavUser, setWebdavUser] = useState('');
  const [webdavPassword, setWebdavPassword] = useState('');
  const [githubRepo, setGithubRepo] = useState('');
  const [busy, setBusy] = useState('');
  const [testText, setTestText] = useState('');
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [confirmTyped, setConfirmTyped] = useState('');
  const [confirmChecked, setConfirmChecked] = useState(false);

  const applyConfig = useCallback((cfg: CloudConfigPublic) => {
    setConfig(cfg);
    setProvider(cfg.provider);
    setWebdavUrl(cfg.webdavUrl);
    setWebdavUser(cfg.webdavUser);
    setGithubRepo(cfg.githubRepo);
  }, []);

  const loadInfo = useCallback(async () => {
    try {
      setInfo(await api.cloudInfo());
      setInfoError('');
    } catch (err) {
      setInfo(null);
      setInfoError(errText(err));
    }
  }, []);

  useEffect(() => {
    void api
      .cloudConfigGet()
      .then(applyConfig)
      .catch((err) => toastError('读取云端灾备设置失败：', err));
    void loadInfo();
  }, [applyConfig, loadInfo]);

  const save = async (): Promise<void> => {
    setBusy('save');
    try {
      const cfg = await api.cloudConfigSet({
        provider,
        webdavUrl,
        webdavUser,
        webdavPassword,
        githubRepo
      });
      applyConfig(cfg);
      setWebdavPassword('');
      toast('云端灾备设置已保存');
    } catch (err) {
      toastError('保存云端灾备设置失败：', err);
    } finally {
      setBusy('');
    }
  };

  const test = async (): Promise<void> => {
    setBusy('test');
    setTestText('');
    try {
      const res = await api.cloudTest();
      setTestText('✓ ' + res.detail);
    } catch (err) {
      setTestText('✗ ' + errText(err));
    } finally {
      setBusy('');
    }
  };

  const backupNow = async (): Promise<void> => {
    setBusy('backup');
    try {
      const res = await api.cloudBackup();
      setInfo(res);
      setInfoError('');
      toast('已备份到云端：数据库 ' + bytesText(res.dbBytes) + '，附件 ' + res.attachmentCount + ' 个', { ttl: 8000 });
    } catch (err) {
      toastError('云端备份失败：', err);
    } finally {
      setBusy('');
    }
  };

  const doRestore = async (): Promise<void> => {
    if (!canConfirmRestore({ typed: confirmTyped, checked: confirmChecked })) return;
    setBusy('restore');
    try {
      const res = await api.cloudRestore(confirmTyped, confirmChecked);
      setRestoreOpen(false);
      setConfirmTyped('');
      setConfirmChecked(false);
      toast('已从云端恢复。恢复前的数据另存为「' + res.preRestore + '」', { ttl: 9000 });
      await loadInfo();
    } catch (err) {
      toastError('从云端恢复失败：', err);
    } finally {
      setBusy('');
    }
  };

  const restoreReady = canConfirmRestore({ typed: confirmTyped, checked: confirmChecked });

  return (
    <div className="card cloud-card">
      <div className="card-head">
        <h2>云端灾备</h2>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>
          单向备份 · 只保留云端最近一份
        </span>
      </div>
      <p className="muted">
        把数据库快照（VACUUM INTO）和附件单向备份到 WebDAV，或者把数据库快照作为 Release 附件备份到 GitHub。
        WebDAV 密码用系统加密（DPAPI）保存，界面和渲染层永远拿不到明文。
      </p>

      <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="field" style={{ minWidth: 140 }}>
          备份目标
          <select
            className="cloud-provider-select"
            value={provider}
            onChange={(e) => setProvider(e.target.value === 'github' ? 'github' : 'webdav')}
          >
            <option value="webdav">WebDAV</option>
            <option value="github">GitHub（只备份数据库快照）</option>
          </select>
        </label>
        {provider === 'webdav' ? (
          <>
            <label className="field" style={{ flex: 1, minWidth: 220 }}>
              WebDAV 地址
              <input
                className="cloud-webdav-url"
                placeholder="https://dav.example.com/remote.php/dav/files/用户名/"
                value={webdavUrl}
                onChange={(e) => setWebdavUrl(e.target.value)}
              />
            </label>
            <label className="field" style={{ minWidth: 130 }}>
              用户名
              <input className="cloud-webdav-user" value={webdavUser} onChange={(e) => setWebdavUser(e.target.value)} />
            </label>
            <label className="field" style={{ minWidth: 130 }}>
              密码
              <input
                className="cloud-webdav-pass"
                type="password"
                placeholder={config?.hasPassword ? '已保存（留空=不修改）' : '未设置'}
                value={webdavPassword}
                onChange={(e) => setWebdavPassword(e.target.value)}
              />
            </label>
          </>
        ) : (
          <label className="field" style={{ flex: 1, minWidth: 220 }}>
            备份仓库（owner/repo）
            <input
              className="cloud-github-repo"
              placeholder="x-000001/zhishiku-backup"
              value={githubRepo}
              onChange={(e) => setGithubRepo(e.target.value)}
            />
          </label>
        )}
      </div>

      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button type="button" className="btn sm" disabled={busy === 'save'} onClick={() => void save()}>
          {busy === 'save' ? '保存中…' : '保存云端设置'}
        </button>
        <button type="button" className="btn sm" disabled={busy === 'test'} onClick={() => void test()}>
          {busy === 'test' ? '测试中…' : '测试连接'}
        </button>
        <button
          type="button"
          className="btn sm primary cloud-backup-btn"
          disabled={busy === 'backup' || !config?.configured}
          title={config?.configured ? '' : '先把上面的地址/仓库保存好'}
          onClick={() => void backupNow()}
        >
          {busy === 'backup' ? '备份中…' : '立即备份到云端'}
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="btn sm danger cloud-restore-btn"
          disabled={!info || busy === 'restore'}
          onClick={() => {
            setConfirmTyped('');
            setConfirmChecked(false);
            setRestoreOpen(true);
          }}
        >
          从云端恢复
        </button>
      </div>

      {testText ? <p className="muted cloud-test-text">{testText}</p> : null}
      {info ? (
        <p className="muted cloud-backup-status">
          最近云端备份：{fmtDateTime(info.createdAt)} · 数据库 {bytesText(info.dbBytes)}
          {info.provider === 'webdav'
            ? ' · 附件 ' + info.attachmentCount + ' 个（' + bytesText(info.attachmentBytes) + '）'
            : ' · GitHub 方案不包含附件'}
        </p>
      ) : infoError ? (
        <p className="muted cloud-backup-status">还没有读到云端备份：{infoError}</p>
      ) : null}
      {config ? (
        <p className="muted" style={{ fontSize: 12 }}>
          密码存储：{config.hasPassword ? (config.passwordEncrypted ? '已加密（DPAPI）' : '未加密（系统不支持）') : '未设置'}
        </p>
      ) : null}

      {restoreOpen ? (
        <Modal
          variant="cloud-restore-modal"
          title="⚠️ 从云端恢复（高危）"
          width={480}
          onClose={() => setRestoreOpen(false)}
          footer={
            <>
              <button type="button" className="btn ghost" onClick={() => setRestoreOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn danger cloud-confirm-go"
                disabled={!restoreReady || busy === 'restore'}
                onClick={() => void doRestore()}
              >
                {busy === 'restore' ? '恢复中…' : '确认覆盖并恢复'}
              </button>
            </>
          }
        >
          <p className="cloud-danger-text">
            这会用云端的备份覆盖当前数据库{info?.provider === 'webdav' ? '和附件' : ''}，当前数据无法撤销。
            恢复前系统会自动把当前数据另存一份「恢复前_」快照，但请确认你现在真的要回滚。
          </p>
          <label className="field">
            输入 <b>{RESTORE_CONFIRM_WORD}</b> 继续（区分大小写）
            <input
              className="cloud-confirm-input"
              value={confirmTyped}
              placeholder={RESTORE_CONFIRM_WORD}
              onChange={(e) => setConfirmTyped(e.target.value)}
            />
          </label>
          <label className="row" style={{ gap: 8, marginTop: 10, alignItems: 'center' }}>
            <input
              type="checkbox"
              className="cloud-confirm-check"
              checked={confirmChecked}
              onChange={(e) => setConfirmChecked(e.target.checked)}
            />
            <span>我已了解数据将被覆盖，并愿意承担回滚风险</span>
          </label>
        </Modal>
      ) : null}
    </div>
  );
}
