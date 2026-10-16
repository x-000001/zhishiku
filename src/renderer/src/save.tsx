import { useRef, useState, type ReactNode } from 'react';
import { toast } from './ui';

/**
 * 优化项 8：手动保存。
 * 一条路统一「点一下立刻写盘 → 成功报时间 / 失败说人话」，四个页面共用，
 * 免得每个页面各写一套提示、文案还不一致。
 */

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 「已保存 14:03:22」里的那段时间。 */
export function saveStamp(d: Date = new Date()): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 把「写不进去」翻译成人话。
 * 分诊顺序有讲究：先看是不是被别的程序占着（用户最容易撞上的那种），
 * 再看权限，再看空间，最后才原样抛出，绝不吞掉。
 */
export function describeSaveError(err: unknown): string {
  const message = String((err as Error)?.message ?? err ?? '');
  const code = String((err as { code?: string | number })?.code ?? '');
  const all = `${message} ${code}`.toUpperCase();
  if (/SQLITE_BUSY|SQLITE_LOCKED|DATABASE IS LOCKED|EBUSY|EAGAIN|被占用|LOCKED/.test(all)) {
    return '数据文件被其他软件占用，请关闭记事本/编辑器后再试';
  }
  if (/EACCES|EPERM|SQLITE_READONLY|SQLITE_CANTOPEN|SQLITE_PERM|UNABLE TO OPEN|PERMISSION|权限/.test(all)) {
    return '无法写入 D 盘，请检查文件夹权限';
  }
  if (/ENOSPC|DISK FULL|NO SPACE|SQLITE_FULL|磁盘|空间不够/.test(all)) {
    return 'D 盘空间不够了，腾出空间再保存';
  }
  if (/SQLITE_CORRUPT|SQLITE_NOTADB|MALFORMED/.test(all)) {
    return '数据文件读不出来了，去设置页跑一次数据库自检';
  }
  return '保存失败：' + (message || '原因不明');
}

export interface ManualSave {
  saving: boolean;
  /** 跑一次写盘：成功报「已保存 HH:MM:SS」，失败按上面分诊报错；返回是否成功。 */
  run: (job: () => Promise<unknown>) => Promise<boolean>;
}

export function useManualSave(): ManualSave {
  const [saving, setSaving] = useState(false);
  // 用 ref 挡住连点：state 更新是异步的，连点两下会两次都读到 false
  const busy = useRef(false);

  const run = async (job: () => Promise<unknown>): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    setSaving(true);
    try {
      await job();
      toast('已保存 ' + saveStamp());
      return true;
    } catch (err) {
      toast(describeSaveError(err), { ttl: 7000 });
      return false;
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  return { saving, run };
}

export function SaveButton(props: {
  saving: boolean;
  onClick: () => void;
  primary?: boolean;
  label?: string;
  title?: string;
}): ReactNode {
  return (
    <button
      type="button"
      className={props.primary ? 'btn primary sm' : 'btn sm'}
      disabled={props.saving}
      onClick={props.onClick}
      title={props.title ?? '立刻写进数据文件（Ctrl+S）'}
    >
      {props.saving ? '保存中…' : (props.label ?? '保存')}
    </button>
  );
}
