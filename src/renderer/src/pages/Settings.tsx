import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, onExportProgress, onUpdateProgress } from '../api';
import { ConfirmDialog, Modal, toast } from '../ui';
import { fmtDateTime } from '../format';
import { describeSaveError, saveStamp } from '../save';
import type {
  AppInfo,
  AppSettings,
  BackupEntry,
  UpdateCheck,
  UpdateDownload,
  UpdateProgress
} from '../../../shared/types';
import type { AiConfigInput, AiConfigPublic } from '../../../shared/ai';
import { classifyAiConfigError } from '../../../shared/ai';
import { errText, toastError } from '../errors';
import { GithubCard } from '../github';
import CloudBackupCard from '../CloudBackupCard';

/** 把字节数说成人话：安装包几十 MB，进度里只显示 MB 就够了。 */
function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' 字节';
}

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
  /** 下载进度由主进程推过来；null 表示没在下载 */
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded] = useState<UpdateDownload | null>(null);
  const [installing, setInstalling] = useState(false);

  /* 第七版：AI 模型设置（Key 只在主进程里存，这里拿不到完整 Key） */
  const [ai, setAi] = useState<AiConfigPublic | null>(null);
  const [aiForm, setAiForm] = useState({ baseUrl: '', model: '', apiKey: '' });
  const [aiBusy, setAiBusy] = useState<'save' | 'test' | ''>('');
  const [aiTestText, setAiTestText] = useState('');
  /** 配置格式错误时高亮对应输入框：模型名 / 接口地址；'' = 没错 */
  const [aiBad, setAiBad] = useState<'model' | 'baseUrl' | ''>('');

  /* 第八版：导出全库为 Markdown */
  const [exporting, setExporting] = useState(false);
  const [exportText, setExportText] = useState('');

  // 卸载时自动退订，不留在渲染进程里
  useEffect(() => onUpdateProgress(setProgress), []);
  // 导出进度：主进程每写完一篇推一次
  useEffect(() => onExportProgress((p) => setExportText(`正在导出第 ${p.done}/${p.total} 篇：${p.title}`)), []);

  const load = useCallback(() => {
    void api.appInfo().then(setInfo).catch((e: Error) => toast('读不到数据目录信息：' + e.message));
    void api.getSettings().then((s) => {
      setSaved(s);
      setForm(s);
      props.onTheme(s.theme);
    });
    void api.listBackups().then(setBackups).catch(() => setBackups([]));
    void api
      .aiGetConfig()
      .then((cfg) => {
        setAi(cfg);
        setAiForm((prev) => ({ baseUrl: cfg.baseUrl, model: cfg.model, apiKey: prev.apiKey }));
      })
      .catch(() => undefined);
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
        // 换了版本就把上一次的下载结果清掉，免得上一个包被当成新版本的
        setDownloaded(null);
        setProgress(null);
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

  /** 「下载并安装」第一步：主进程流式下载安装包，进度走 update:progress 事件。 */
  const startDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    setProgress({ phase: 'downloading', received: 0, total: 0, percent: 0 });
    try {
      const res = await api.downloadUpdate();
      setDownloaded(res);
      toast('安装包下载好了（' + fmtSize(res.size) + '），点「立即安装」完成更新', { ttl: 7000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 用户自己点取消不算错误，别弹红字
      if (/取消|aborted|cancell?ed/i.test(message)) toast('已取消下载');
      else toastError('下载安装包失败：', err);
    } finally {
      setDownloading(false);
      setProgress(null);
    }
  };

  /** 取消下载：主进程会 abort 并把半成品删掉。 */
  const cancelDownload = () => {
    void api.cancelUpdate().catch(() => undefined);
  };

  /** 「下载并安装」第二步：拉起安装程序，然后把本应用关掉让 NSIS 覆盖文件。 */
  const installNow = async () => {
    if (!downloaded || installing) return;
    setInstalling(true);
    try {
      const res = await api.installUpdate(downloaded.path);
      if (res.dryRun) {
        toast('（测试模式）安装包已就绪，没有真的运行安装程序', { ttl: 7000 });
        setInstalling(false);
        return;
      }
      if (res.portable) {
        toast('便携版没法自己替换，已经打开文件夹，请手动替换成新版本', { ttl: 9000 });
        setInstalling(false);
        return;
      }
      toast('安装程序已启动，应用即将关闭，装完会自动打开新版本', { ttl: 9000 });
      await api.quitForUpdate();
    } catch (err) {
      setInstalling(false);
      toastError('启动安装程序失败：', err);
    }
  };

  /* ---------------- 第七版：AI 模型设置 ---------------- */

  /** 保存 AI 配置。Key 留空 = 不改；想删 Key 用旁边的「清除 Key」。 */
  const saveAi = async (): Promise<void> => {
    setAiBusy('save');
    try {
      const patch: AiConfigInput = {
        baseUrl: aiForm.baseUrl.trim(),
        model: aiForm.model.trim()
      };
      if (aiForm.apiKey.trim()) patch.apiKey = aiForm.apiKey.trim();
      const next = await api.aiSetConfig(patch);
      setAi(next);
      setAiForm((prev) => ({ ...prev, apiKey: '' }));
      setAiBad('');
      toast(next.hasKey ? '已保存 AI 设置，Key 只存在本机' : '已保存，但还没填 Key，AI 还不能用');
    } catch (err) {
      // 配置格式错（模型名/接口地址）不是「保存失败」，要说清是哪个字段要改
      const message = errText(err);
      const field = classifyAiConfigError(message);
      if (field && field !== 'config') setAiBad(field);
      toastError(field ? 'AI 设置有误：' : '保存 AI 设置失败：', err);
    } finally {
      setAiBusy('');
    }
  };

  /** 测试连接：让主进程发一次极短的请求，把中文错误原样显示在这里。 */
  const testAi = async (): Promise<void> => {
    setAiBusy('test');
    setAiTestText('');
    setAiBad('');
    try {
      const res = await api.aiTestConfig();
      setAiTestText(`连通了：${res.model} 回了「${res.reply}」`);
      toast('AI 连接正常');
    } catch (err) {
      const message = errText(err);
      const field = classifyAiConfigError(message);
      if (field) {
        // 配置类错误：提示「模型名格式错误 / 接口地址格式错误」，并高亮那一格，别误导成网络问题
        if (field !== 'config') setAiBad(field);
        setAiTestText('配置有误：' + message);
        toastError('配置有误：', err);
      } else {
        setAiTestText('连接失败：' + message);
        toastError('测试失败：', err);
      }
    } finally {
      setAiBusy('');
    }
  };

  const clearAiKey = async (): Promise<void> => {
    try {
      setAi(await api.aiSetConfig({ apiKey: '' }));
      toast('已清除 Key，AI 功能先停用');
    } catch (err) {
      toastError('清除 Key 失败：', err);
    }
  };

  const toggleAiPrivacy = async (): Promise<void> => {
    if (!ai) return;
    try {
      setAi(await api.aiSetConfig({ privacyAck: !ai.privacyAck }));
    } catch (err) {
      toastError('更新 AI 隐私设置失败：', err);
    }
  };

  /**
   * 导出全库为 Markdown：主进程弹「选择文件夹」，然后按分类树写 .md + attachments。
   * 进度由 onExportProgress 推过来；完成后给一个「打开文件夹」的近路。
   */
  const exportMarkdown = async (): Promise<void> => {
    setExporting(true);
    setExportText('正在准备导出…');
    try {
      const result = await api.exportMarkdown();
      if (result.canceled) {
        setExportText('');
        toast('已取消导出');
        return;
      }
      const missingText = result.missing.length > 0 ? `，有 ${result.missing.length} 张图片没找到` : '';
      setExportText(
        `导出完成：${result.notes} 篇笔记、${result.folders} 个分类目录、${result.attachments} 个附件${missingText}。目录：${result.dir}`
      );
      toast(`导出完成：${result.notes} 篇笔记${missingText}`, {
        actionLabel: '打开文件夹',
        onAction: () => {
          void api.exportReveal(result.dir).catch((err: Error) => toast('打不开这个文件夹：' + err.message));
        }
      });
    } catch (err) {
      setExportText('');
      toastError('导出失败：', err);
    } finally {
      setExporting(false);
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

      <CloudBackupCard />

      <div className="card export-card">
        <div className="card-head">
          <h2>导出数据</h2>
          <span className="spacer" />
          <button
            type="button"
            className={exporting ? 'btn sm loading export-md-btn' : 'btn sm export-md-btn'}
            disabled={exporting}
            onClick={() => void exportMarkdown()}
          >
            {exporting ? '导出中…' : '导出所有数据为 Markdown'}
          </button>
        </div>
        <p className="muted">
          选一个文件夹，会按知识库的分类建目录，每篇笔记导成一个 .md；图片复制到 attachments 里并改好相对路径，
          用 Obsidian、Typora 这类软件能直接打开。
        </p>
        {exportText ? <p className="muted export-progress">{exportText}</p> : null}
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
              发现有新版本可以直接点「下载并安装」，不用去网页手动下载；断网只多一条提示，本地读写完全不受影响。
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

      {/* 第七版：AI 模型设置。Key 存主进程，这里只显示「有没有配」和打码尾巴。 */}
      <div className="card ai-settings-card">
        <div className="card-head">
          <h2>AI 模型（OpenAI 兼容接口）</h2>
          <span className="spacer" />
          <span className="badge">{ai?.hasKey ? '已配好 Key' : '还没填 Key'}</span>
          <button
            type="button"
            className={aiBusy === 'test' ? 'btn sm loading ai-test-btn' : 'btn sm ai-test-btn'}
            disabled={aiBusy === 'test'}
            onClick={() => void testAi()}
            title="让主进程按上面的地址真发一次很短的中文请求"
          >
            {aiBusy === 'test' ? '测试中…' : '测试连接'}
          </button>
          <button
            type="button"
            className={aiBusy === 'save' ? 'btn sm primary loading ai-save-btn' : 'btn sm primary ai-save-btn'}
            disabled={aiBusy === 'save'}
            onClick={() => void saveAi()}
          >
            {aiBusy === 'save' ? '保存中…' : '保存 AI 设置'}
          </button>
        </div>
        <div className="set-row">
          <div className="txt">
            <b>Base URL</b>
            <p>OpenAI 兼容的接口地址，例如 https://api.deepseek.com/v1 或 https://api.openai.com/v1 。</p>
          </div>
          <input
            className={aiBad === 'baseUrl' ? 'input ai-base-url ai-input-bad' : 'input ai-base-url'}
            style={{ width: 300 }}
            placeholder="https://api.deepseek.com/v1"
            spellCheck={false}
            value={aiForm.baseUrl}
            onChange={(e) => {
              setAiBad('');
              setAiForm({ ...aiForm, baseUrl: e.target.value });
            }}
          />
        </div>
        <div className="set-row">
          <div className="txt">
            <b>模型名</b>
            <p>接口里要填的模型 id，例如 deepseek-chat、gpt-4o-mini。</p>
          </div>
          <input
            className={aiBad === 'model' ? 'input ai-model ai-input-bad' : 'input ai-model'}
            style={{ width: 200 }}
            placeholder="deepseek-chat"
            spellCheck={false}
            value={aiForm.model}
            onChange={(e) => {
              setAiBad('');
              setAiForm({ ...aiForm, model: e.target.value });
            }}
          />
        </div>
        <div className="set-row">
          <div className="txt">
            <b>API Key</b>
            <p>
              {ai?.hasKey
                ? `已经存了一个（${ai.keyHint}）${
                    ai.encrypted ? '，用系统加密存在本机设置里' : '，系统不支持加密，是明文存在本机设置里'
                  }。要换就填新的；留空 = 不改。`
                : '只存在本机设置里（系统支持时会加密），不会写进日志，也不会出现在渲染层。'}
            </p>
          </div>
          <input
            className="input ai-key"
            type="password"
            style={{ width: 240 }}
            placeholder={ai?.hasKey ? '留空 = 不修改' : 'sk-…'}
            autoComplete="off"
            spellCheck={false}
            value={aiForm.apiKey}
            onChange={(e) => setAiForm({ ...aiForm, apiKey: e.target.value })}
          />
          {ai?.hasKey ? (
            <button type="button" className="btn sm" onClick={() => void clearAiKey()}>
              清除 Key
            </button>
          ) : null}
        </div>
        <div className="set-row">
          <div className="txt">
            <b>隐私说明</b>
            <p>
              只有你点「润色 / 摘要 / 分类整理…」的时候才联网，把选中的文字或整篇正文发给你配置的模型服务；
              本地笔记、搜索、复习都不受影响，也不会被改动。
              {ai?.privacyAck ? '（已经确认过）' : '（第一次用 AI 时会再问你一次）'}
            </p>
          </div>
          <button
            type="button"
            className={ai?.privacyAck ? 'switch on' : 'switch'}
            aria-label="AI 隐私确认开关"
            onClick={() => void toggleAiPrivacy()}
          />
        </div>
        <p className="muted ai-test-result">
          {aiTestText || 'Key 只在本机主进程里使用；渲染层拿到的只有「有没有配」和打码后的尾巴。填好后点「测试连接」验证一下。'}
        </p>
      </div>

      <GithubCard />

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
          onClose={() => {
            // 下载中不关窗：关掉就看不到进度、也不知道装到哪了
            if (downloading) return;
            setUpdate(null);
          }}
          width={520}
          footer={
            downloading ? (
              <button type="button" className="btn" onClick={cancelDownload}>
                取消下载
              </button>
            ) : downloaded ? (
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void api.revealUpdate(downloaded.path).catch(() => undefined);
                  }}
                >
                  打开文件位置
                </button>
                <button type="button" className="btn primary" disabled={installing} onClick={() => void installNow()}>
                  {installing ? '正在启动…' : '立即安装'}
                </button>
              </>
            ) : (
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
                {update.latest.installer ? (
                  <button type="button" className="btn primary" onClick={() => void startDownload()}>
                    下载并安装
                  </button>
                ) : null}
                <button type="button" className="btn" onClick={() => setUpdate(null)}>
                  稍后
                </button>
              </>
            )
          }
        >
          <div style={{ lineHeight: 1.7, fontSize: 13.5 }}>
            <p>
              <b>新版本 {update.latest.version}</b>（当前 {update.current}）
              {update.latest.publishedAt ? ' · 发布于 ' + fmtDateTime(update.latest.publishedAt) : ''}
            </p>
            {update.latest.notes ? <p style={{ whiteSpace: 'pre-wrap' }}>{update.latest.notes}</p> : null}
            {downloading && progress ? (
              <div className="update-progress">
                <div className="progress">
                  <i style={{ width: (progress.phase === 'verifying' ? 100 : progress.percent) + '%' }} />
                </div>
                <div className="update-progress-meta">
                  <span>{progress.phase === 'verifying' ? '正在校验安装包…' : '正在下载 ' + progress.percent + '%'}</span>
                  <span>
                    {progress.total > 0
                      ? fmtSize(progress.received) + ' / ' + fmtSize(progress.total)
                      : fmtSize(progress.received)}
                  </span>
                </div>
              </div>
            ) : downloaded ? (
              <p className="muted">
                安装包已下载：{fmtSize(downloaded.size)}（版本 {downloaded.version}），放在系统临时目录，装完可以清掉。
              </p>
            ) : update.latest.installer ? (
              <p className="muted">
                点「下载并安装」会自动下载并调起安装程序，装完自动打开新版本；便携版会改成打开文件夹让你手动替换。
              </p>
            ) : (
              <p className="muted">这个版本没上传安装包，只能复制下载页链接去手动下载。</p>
            )}
            <p className="muted">下载页：{update.latest.url || '（这个版本没写链接）'}</p>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
