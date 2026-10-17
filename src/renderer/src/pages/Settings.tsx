import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { ConfirmDialog, Modal, toast } from '../ui';
import { fmtDateTime } from '../format';
import { describeSaveError, saveStamp } from '../save';
import type { AppInfo, AppSettings, BackupEntry, UpdateCheck } from '../../../shared/types';
import { toastError } from '../errors';

export default function Settings(props: {
  theme: 'light' | 'dark';
  onTheme: (theme: 'light' | 'dark') => void;
}): ReactNode {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [saved, setSaved] = useState<AppSettings | null>(null);
  const [form, setForm] = useState<AppSettings | null>(null);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [restoring, setRestoring] = useState<BackupEntry | null>(null);
  const [busy, setBusy] = useState('');
  const [integrity, setIntegrity] = useState('');
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [lastCheck, setLastCheck] = useState<{ at: string; text: string } | null>(null);

  const load = useCallback(() => {
    void api.appInfo().then(setInfo).catch((e: Error) => toast('读不到数据目录信息：' + e.message));
    void api.getSettings().then((s) => {
      setSaved(s);
      setForm(s);
      props.onTheme(s.theme);
    });
    void api.listBackups().then(setBackups).catch(() => setBackups([]));
  }, [props]);

  useEffect(() => {
    load();
    // 只在进入设置页时读一次
  }, []);

  // 「主题」是边选边预览的（真正落库要点保存），所以离开这一页时要把没保存的预览退回去，
  // 否则界面是预览色、库里还是旧主题，下次启动又变回去 —— 看起来就像「取消没生效」。
  const savedRef = useRef<AppSettings | null>(null);
  savedRef.current = saved;
  useEffect(() => {
    return () => {
      const last = savedRef.current;
      if (last) props.onTheme(last.theme);
    };
  }, []);

  if (!form || !saved) return <div className="empty">正在读取设置…</div>;

  const dirty =
    form.versionKeep !== saved.versionKeep ||
    form.theme !== saved.theme ||
    form.notifyEnabled !== saved.notifyEnabled ||
    form.closeToTray !== saved.closeToTray;

  const patch = (next: Partial<AppSettings>) => setForm({ ...form, ...next });

  const save = async () => {
    setBusy('save');
    try {
      await api.setSetting('versionKeep', form.versionKeep);
      await api.setSetting('theme', form.theme);
      await api.setSetting('notifyEnabled', form.notifyEnabled);
      await api.setSetting('closeToTray', form.closeToTray);
      setSaved(form);
      props.onTheme(form.theme);
      toast('已保存 ' + saveStamp());
    } catch (err) {
      toast(describeSaveError(err), { ttl: 7000 });
    } finally {
      setBusy('');
    }
  };

  const runBackup = async () => {
    setBusy('backup');
    try {
      await api.runBackup();
      toast('备份完成');
      setBackups(await api.listBackups());
    } catch (err) {
      toastError('备份失败：', err);
    } finally {
      setBusy('');
    }
  };

  const doRestore = async () => {
    if (!restoring) return;
    setBusy('restore');
    try {
      const res = await api.restoreBackup(restoring.name);
      toast('已恢复，恢复前的数据另存到「' + res.preRestore + '」', { ttl: 8000 });
      setRestoring(null);
      load();
    } catch (err) {
      toastError('恢复失败：', err);
    } finally {
      setBusy('');
    }
  };

  const checkIntegrity = async () => {
    setBusy('check');
    try {
      const result = await api.integrity();
      setIntegrity(result);
      toast(result === 'ok' ? '数据库自检通过' : '自检发现问题：' + result, { ttl: 6000 });
    } catch (err) {
      toastError('自检失败：', err);
    } finally {
      setBusy('');
    }
  };

  const runUpdateCheck = async () => {
    setChecking(true);
    try {
      const res = await api.checkUpdate();
      const at = fmtDateTime(new Date(res.checkedAt).toISOString());
      if (res.status === 'newer' && res.latest) {
        setLastCheck({ at, text: '发现新版本 ' + res.latest.version });
        setUpdate(res);
      } else if (res.status === 'no-release') {
        setLastCheck({ at, text: '还没有发布版本' });
        toast('GitHub 上还没有发布版本，当前 ' + res.current + ' 已是最新', { ttl: 6000 });
      } else {
        setLastCheck({ at, text: '已是最新' });
        toast('已是最新版本 ' + res.current);
      }
    } catch (err) {
      setLastCheck({ at: fmtDateTime(new Date().toISOString()), text: '检查失败' });
      toastError('检查更新失败：', err);
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>数据位置</h2>
          <span className="spacer" />
          <button type="button" className="btn sm" onClick={() => void api.revealData()}>
            打开数据文件夹
          </button>
        </div>
        <div className="set-row">
          <div className="txt">
            <b>数据目录</b>
            <p>{info?.dataRoot ?? '读取中…'}</p>
          </div>
        </div>
        <div className="set-row">
          <div className="txt">
            <b>数据库文件</b>
            <p>{info?.dbPath ?? ''}</p>
          </div>
          <span className="badge">SQLite {info?.sqlite ?? ''}</span>
        </div>
        <div className="set-row">
          <div className="txt">
            <b>附件目录</b>
            <p>{info?.attachmentsDir ?? ''}</p>
          </div>
        </div>
        <div className="set-row">
          <div className="txt">
            <b>备份目录</b>
            <p>{info?.backupsDir ?? ''}</p>
          </div>
          <button type="button" className="btn sm" onClick={() => void api.revealBackups()}>
            打开
          </button>
        </div>
        <p className="muted">
          想换盘就把 `%APPDATA%\Jw知识库\locator.json` 里的路径改掉，重启应用即可。版本 {info?.version} · Electron{' '}
          {info?.electron} · Node {info?.node}
        </p>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>备份与恢复</h2>
          <span className="spacer" />
          <button
            type="button"
            className={busy === 'backup' ? 'btn sm loading' : 'btn sm'}
            disabled={busy === 'backup'}
            onClick={() => void runBackup()}
          >
            {busy === 'backup' ? '备份中…' : '立即备份'}
          </button>
          <button
            type="button"
            className={busy === 'check' ? 'btn sm loading' : 'btn sm'}
            disabled={busy === 'check'}
            onClick={() => void checkIntegrity()}
          >
            {busy === 'check' ? '检查中…' : '数据库自检'}
          </button>
        </div>
        {integrity ? <p className="muted">最近一次自检：{integrity === 'ok' ? '通过' : integrity}</p> : null}
        {backups.length === 0 ? (
          <div className="empty">还没有备份。应用每天第一次启动会自动备份一次，保留最近 7 份。</div>
        ) : (
          backups.map((b) => (
            <div className="backup-row" key={b.name}>
              <span className="badge">{b.kind === 'manual' ? '手动' : b.kind === 'daily' ? '每日' : '恢复前'}</span>
              <span style={{ flex: 1 }}>{b.name}</span>
              <span className="muted">{Math.round(b.size / 1024)} KB</span>
              <button type="button" className="btn sm" onClick={() => setRestoring(b)}>
                恢复
              </button>
              <button
                type="button"
                className="btn danger sm"
                onClick={() => {
                  void api.deleteBackup(b.name).then(async () => {
                    toast('已删除该备份');
                    setBackups(await api.listBackups());
                  });
                }}
              >
                删除
              </button>
            </div>
          ))
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>软件更新</h2>
          <span className="spacer" />
          <button
            type="button"
            className={checking ? 'btn sm loading' : 'btn sm'}
            disabled={checking}
            onClick={() => void runUpdateCheck()}
            title="连一次网，看看 GitHub 上有没有新版本"
          >
            {checking ? '正在连接…' : '检查更新'}
          </button>
        </div>
        <div className="set-row">
          <div className="txt">
            <b>当前版本 {info?.version ?? '读取中…'}</b>
            <p>
              点「检查更新」连一次网，看看 GitHub 上有没有新版本。只有点的时候才联网，不轮询、不常驻；
              查不到或断网只多一条提示，本地读写完全不受影响。
            </p>
          </div>
        </div>
        <p className="muted">
          {lastCheck ? '最近一次检查：' + lastCheck.at + ' · ' + lastCheck.text : '还没有检查过。'}
        </p>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>偏好设置</h2>
        </div>
        <div className="set-row">
          <div className="txt">
            <b>版本点保留数量</b>
            <p>每次手动保存留一个版本点，每篇笔记最多保留这么多。填 0 就关掉版本历史。</p>
          </div>
          <input
            type="number"
            min={0}
            max={200}
            style={{ width: 90 }}
            value={form.versionKeep}
            onChange={(e) => patch({ versionKeep: Math.max(0, Math.min(200, Number(e.target.value) || 0)) })}
          />
        </div>
        <div className="set-row">
          <div className="txt">
            <b>主题</b>
            <p>深色适合晚上看。换了会立刻预览，点「保存设置」才记住，点「放弃改动」退回原来的。</p>
          </div>
          <select
            value={form.theme}
            onChange={(e) => {
              const theme = e.target.value as 'light' | 'dark';
              patch({ theme });
              props.onTheme(theme);
            }}
          >
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </div>
        <div className="set-row">
          <div className="txt">
            <b>到期通知</b>
            <p>任务到点时弹 Windows 系统通知。</p>
          </div>
          <button
            type="button"
            className={form.notifyEnabled ? 'switch on' : 'switch'}
            aria-label="到期通知开关"
            onClick={() => patch({ notifyEnabled: !form.notifyEnabled })}
          />
        </div>
        <div className="set-row">
          <div className="txt">
            <b>关闭窗口时缩到托盘</b>
            <p>关掉的话，点关闭就直接退出程序。</p>
          </div>
          <button
            type="button"
            className={form.closeToTray ? 'switch on' : 'switch'}
            aria-label="关闭窗口行为开关"
            onClick={() => patch({ closeToTray: !form.closeToTray })}
          />
        </div>
      </div>

      {dirty ? (
        <div className="save-bar">
          <span>有未保存的改动</span>
          <span className="spacer" style={{ flex: 1 }} />
          <button
            type="button"
            className="btn"
            onClick={() => {
              // 表单回到上次保存的值，同时把「边选边预览」的主题也退回去
              setForm(saved);
              props.onTheme(saved.theme);
            }}
            disabled={busy === 'save'}
          >
            放弃改动
          </button>
          <button
            type="button"
            className={busy === 'save' ? 'btn primary loading' : 'btn primary'}
            onClick={() => void save()}
            disabled={busy === 'save'}
          >
            {busy === 'save' ? '保存中…' : '保存设置'}
          </button>
        </div>
      ) : null}

      {restoring ? (
        <ConfirmDialog
          title="从备份恢复"
          danger
          confirmLabel="恢复并覆盖当前数据"
          message={
            <>
              将用备份 <b>{restoring.name}</b>（{fmtDateTime(restoring.created_at)}）覆盖当前数据。
              <br />
              恢复前，当前数据会先另存一份，不会丢。
            </>
          }
          onCancel={() => setRestoring(null)}
          onConfirm={doRestore}
        />
      ) : null}
      {update && update.latest ? (
        <Modal
          title="发现新版本"
          onClose={() => setUpdate(null)}
          width={520}
          footer={
            <>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void api
                    .copyText(update.latest?.url ?? '')
                    .then(() => toast('下载链接已复制'))
                    .catch((err) => toastError('复制失败：', err));
                }}
              >
                复制下载链接
              </button>
              <button type="button" className="btn primary" onClick={() => setUpdate(null)}>
                知道了
              </button>
            </>
          }
        >
          <div style={{ lineHeight: 1.7, fontSize: 13.5 }}>
            <p>
              <b>新版本 {update.latest.version}</b>（当前 {update.current}）
              {update.latest.publishedAt ? ' · 发布于 ' + fmtDateTime(update.latest.publishedAt) : ''}
            </p>
            {update.latest.notes ? <p style={{ whiteSpace: 'pre-wrap' }}>{update.latest.notes}</p> : null}
            <p className="muted">下载页：{update.latest.url || '（这个版本没写链接）'}</p>
            <p className="muted">这里只做提醒和给链接，不会自动下载或安装。</p>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
