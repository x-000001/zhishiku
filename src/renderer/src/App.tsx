import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { TIMING } from './timing';
import { api, onEvent } from './api';
import { Modal, ToastHost, toast } from './ui';
import { ContextMenuHost } from './menu';
import Dashboard from './pages/Dashboard';
import Inbox from './pages/Inbox';
import Knowledge from './pages/Knowledge';
import Tasks from './pages/Tasks';
import Settings from './pages/Settings';
import Goals from './pages/Goals';
import NextGoals from './pages/NextGoals';
import Plans from './pages/Plans';
import Review from './pages/Review';
import QuickCapture from './pages/QuickCapture';
import FocusDock from './focus';
import CommandPalette from './CommandPalette';
import { shouldIgnoreShortcut, type PaletteCommand } from './palette';
import { parseSearchQuery, SEARCH_FLAG_LABELS, type ParsedSearchQuery } from '../../shared/search-query';
import type { SearchAdvancedResult } from '../../shared/types';
import type { SearchHit } from '../../shared/types';import { toastError } from './errors';

export interface RouteProps {
  openNote: (id: number) => void;
  navigate: (route: string) => void;
}

const NAV = [
  { route: '/', icon: '🏠', label: '首页' },
  { route: '/inbox', icon: '📥', label: '收集箱', countKey: 'inbox' },
  { route: '/knowledge', icon: '📚', label: '知识库' },
  { route: '/tasks', icon: '✅', label: '任务待办' },
  { route: '/plans', icon: '📅', label: '学习计划' },
  { route: '/goals', icon: '🎯', label: '当前目标' },
  { route: '/next', icon: '🚀', label: '下一阶段目标' },
  { route: '/review', icon: '🔁', label: '复习与复盘' },
  { route: '/settings', icon: '⚙️', label: '设置' }
];

/** 侧栏收起/展开那一下的收尾时长（毫秒）：样式里过渡 0.38s，这里多留一点尾巴再摘 class。 */
const SIDEBAR_ANIMATE_MS = 440;

function useHashRoute(): [string, (route: string) => void] {
  const [route, setRoute] = useState(() => window.location.hash.replace(/^#/, '') || '/');
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash.replace(/^#/, '') || '/');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const navigate = useCallback((next: string) => {
    if (window.location.hash.replace(/^#/, '') === next) setRoute(next);
    else window.location.hash = next;
  }, []);
  return [route, navigate];
}

/**
 * 第五版（阶段9）：窗口宽度分四档 —— 只影响外观（侧栏形态、知识库几栏），不动任何功能。
 * ≥1200 完整；1024–1199 侧栏收成图标条；768–1023 侧栏变抽屉；<768 单栏。
 */
export type Layout = 'wide' | 'rail' | 'drawer' | 'single';

export function readLayout(): Layout {
  const w = window.innerWidth || document.documentElement.clientWidth || 0;
  if (w < 768) return 'single';
  if (w < 1024) return 'drawer';
  if (w < 1200) return 'rail';
  return 'wide';
}

function useLayout(): Layout {
  const [layout, setLayout] = useState<Layout>(readLayout);
  useEffect(() => {
    const root = document.documentElement;
    let timer = 0;
    const onResize = () => {
      setLayout(readLayout());
      // 第五版（阶段9 修正）：拖窗口期间给 <html> 挂 .is-resizing，
      // CSS 会在这段时间里关掉所有插值/动画 —— 窗口每帧都在改尺寸，
      // 再叠一层 180ms 的宽度插值等于每帧多一次重排，肉眼就是掉帧。
      // 停手 150ms 后自动摘掉，点按钮折叠、抽屉滑出这些非拖动动画不受影响。
      root.classList.add('is-resizing');
      window.clearTimeout(timer);
      timer = window.setTimeout(() => root.classList.remove('is-resizing'), TIMING.resizeSettle);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.clearTimeout(timer);
      root.classList.remove('is-resizing');
    };
  }, []);
  return layout;
}

/* 第五版（阶段9）：三个窗口按钮只有一套逻辑，但得渲染两份 ——
   宽屏挂在侧栏品牌行；窗口收窄到抽屉/单栏档时侧栏整体离场，
   顶栏这一份才顶上来（CSS 按 html[data-layout] / 媒体查询切换显示），
   否则窄窗口下就没有关闭、最小化、最大化的入口了。 */
function WinLights({ className }: { className?: string }): ReactNode {
  return (
    <div className={'win-lights' + (className ? ' ' + className : '')}>
      <button
        type="button"
        className="win-light win-close"
        aria-label="关闭窗口"
        title="关闭"
        onClick={() => void api.winClose()}
      />
      <button
        type="button"
        className="win-light win-min"
        aria-label="最小化窗口"
        title="最小化"
        onClick={() => void api.winMinimize()}
      />
      <button
        type="button"
        className="win-light win-max"
        aria-label="最大化或还原窗口"
        title="最大化 / 还原"
        onClick={() => void api.winToggleMax()}
      />
    </div>
  );
}

export default function App(): ReactNode {
  const [route, navigate] = useHashRoute();
  const [collapsed, setCollapsed] = useState(false);
  const [inboxCount, setInboxCount] = useState(0);
  const [openNoteId, setOpenNoteId] = useState<number | null>(null);
  /** 0.12.3 搜索直达：从搜索弹窗点进笔记时，把原始 Query 一起带过去（只对这次打开有效）。 */
  const [locate, setLocate] = useState<{ id: number; query: string } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [drawerOpen, setDrawerOpen] = useState(false);
  /* 0.12.0 阶段1：全局命令面板（Ctrl+Shift+P） */
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteNotes, setPaletteNotes] = useState<Array<{ id: number; title: string }>>([]);
  const [paletteNotesLoading, setPaletteNotesLoading] = useState(false);
  /** 每次打开/关闭自增：异步回调回来时序号不一致就丢弃（防串台） */
  const paletteSeq = useRef(0);
  const layout = useLayout();
  const openNote = useCallback(
    (id: number, query?: string) => {
      const target = query?.trim() ?? '';
      setLocate(target ? { id, query: target } : null);
      setOpenNoteId(id);
      navigate('/knowledge');
    },
    [navigate]
  );
  /** 直达用完就清掉，避免同一条 Query 在后续重渲染里反复触发高亮。 */
  const consumeLocate = useCallback(() => setLocate(null), []);

  const refreshCount = useCallback(() => {
    void api.listInbox('open').then((list) => setInboxCount(list.length));
  }, []);

  /**
   * 打开命令面板：顺便异步拉一次笔记列表当「打开笔记」命令。
   * 用自增序号做闭包防串台——面板关掉又重开时，上一次的 Promise 回来直接丢弃。
   */
  const openPalette = useCallback(() => {
    const seq = paletteSeq.current + 1;
    paletteSeq.current = seq;
    setPaletteNotes([]);
    setPaletteNotesLoading(true);
    setPaletteOpen(true);
    void api
      .listNotes({})
      .then((list) => {
        if (paletteSeq.current !== seq) return;
        setPaletteNotes(list.map((note) => ({ id: note.id, title: note.title || '无标题笔记' })));
      })
      .catch(() => {
        if (paletteSeq.current !== seq) return;
        setPaletteNotes([]);
      })
      .finally(() => {
        if (paletteSeq.current === seq) setPaletteNotesLoading(false);
      });
  }, []);

  /** 关闭命令面板：序号再 +1，作废所有在途回调。 */
  const closePalette = useCallback(() => {
    paletteSeq.current += 1;
    setPaletteOpen(false);
    setPaletteNotesLoading(false);
  }, []);

  useEffect(() => {
    refreshCount();
    void api.getSettings().then((s) => setTheme(s.theme));
    const timer = window.setInterval(refreshCount, 20000);
    const offNav = onEvent('nav:go', (payload) => navigate(String(payload)));
    return () => {
      window.clearInterval(timer);
      offNav();
    };
  }, [navigate, refreshCount]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      window.localStorage.setItem('jw-theme', theme);
    } catch {
      /* 忽略：主进程拼的 ?theme= 才是主路径，localStorage 只是兜底 */
    }
  }, [theme]);

  // 第五版（阶段9）：窗口一跨档，就让侧栏跟着换形态 ——
  // 图标条档自动收起（复用折叠态那套样式与气泡），抽屉/单栏档展开成完整抽屉，
  // 宽屏恢复完整侧栏。这些只动外观，不改任何功能。
  useEffect(() => {
    document.documentElement.dataset.layout = layout;
    if (layout === 'rail') setCollapsed(true);
    else setCollapsed(false);
    if (layout === 'drawer' || layout === 'single') setDrawerOpen(false);
  }, [layout]);

  // 换页就把抽屉收起来（不然点完导航它还挡着正文）
  useEffect(() => {
    setDrawerOpen(false);
  }, [route]);

  // 第五版（阶段8）：用户手动切主题时，给 <html> 挂一下 .theme-transitioning，
  // 让全局走 0.3s 的颜色过渡，之后摘掉——平时不拖慢任何交互。
  const changeTheme = useCallback((next: 'light' | 'dark') => {
    const root = document.documentElement;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (!reduce) {
      root.classList.add('theme-transitioning');
      window.setTimeout(() => root.classList.remove('theme-transitioning'), TIMING.themeFade);
    }
    setTheme(next);
  }, []);

  // 第五版（动画专项）：收起/展开那 0.38s 里给 <html> 挂 .sidebar-animating，
  // 让侧栏暂时用实色代替毛玻璃（每帧重算 backdrop 是最贵的一步），动画结束再摘掉。
  const sidebarTimer = useRef(0);
  const toggleSidebar = useCallback(() => {
    const root = document.documentElement;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (!reduce) {
      root.classList.add('sidebar-animating');
      window.clearTimeout(sidebarTimer.current);
      sidebarTimer.current = window.setTimeout(() => {
        root.classList.remove('sidebar-animating');
      }, SIDEBAR_ANIMATE_MS);
    }
    setCollapsed((c) => !c);
  }, []);

  /**
   * 命令面板的命令清单：页面跳转 + 全局动作 + 笔记（异步补进来）。
   * 所有 run 都是 void | Promise<void>；耗时动作（备份/导出）由面板负责 Loading。
   */
  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const pages: PaletteCommand[] = NAV.map((item) => ({
      key: 'nav:' + item.route,
      title: item.label,
      group: '前往',
      icon: item.icon,
      run: () => navigate(item.route)
    }));
    const actions: PaletteCommand[] = [
      {
        key: 'action:theme',
        title: theme === 'dark' ? '切换到浅色主题' : '切换到深色主题',
        group: '外观',
        icon: '🌗',
        keywords: 'theme dark light 主题 深色 浅色',
        run: () => changeTheme(theme === 'dark' ? 'light' : 'dark')
      },
      {
        key: 'action:sidebar',
        title: collapsed ? '展开侧栏' : '收起侧栏',
        group: '外观',
        icon: '🧭',
        run: toggleSidebar
      },
      {
        key: 'action:search',
        title: '全局搜索笔记',
        group: '工具',
        icon: '🔍',
        hint: 'Ctrl K',
        run: () => setSearchOpen(true)
      },
      {
        key: 'action:backup',
        title: '立即备份数据库',
        group: '工具',
        icon: '💾',
        keywords: 'backup 备份',
        run: async () => {
          const entry = await api.runBackup();
          toast('备份完成：' + entry.name);
        }
      },
      {
        key: 'action:reveal',
        title: '打开数据文件夹',
        group: '工具',
        icon: '📂',
        run: () => api.revealData()
      },
      {
        key: 'action:export',
        title: '导出全部笔记为 Markdown',
        group: '工具',
        icon: '📤',
        keywords: 'export markdown 导出',
        run: async () => {
          const result = await api.exportMarkdown();
          toast('导出完成：' + result.notes + ' 篇笔记');
        }
      }
    ];
    const notes: PaletteCommand[] = paletteNotes.map((note) => ({
      key: 'note:' + note.id,
      title: '打开笔记：' + note.title,
      group: '笔记',
      icon: '📄',
      keywords: 'note 笔记 ' + note.title,
      run: () => openNote(note.id)
    }));
    return [...pages, ...actions, ...notes];
  }, [navigate, theme, changeTheme, collapsed, toggleSidebar, openNote, paletteNotes]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 红线：焦点在 input / contenteditable 里时，裸键（无 Ctrl/Alt/Meta）不抢；
      // 应用级组合键（Ctrl+K / Ctrl+S …）照常可用。
      if (shouldIgnoreShortcut({ target: e.target instanceof HTMLElement ? e.target : null, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey })) return;
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        if (paletteOpen) closePalette();
        else openPalette();
      } else if (e.ctrlKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.ctrlKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        void api.createNote({}).then((note) => {
          if (note) openNote(note.id);
          toast('已新建笔记');
        });
      } else if (e.ctrlKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const item = NAV[Number(e.key) - 1];
        if (item) navigate(item.route);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, openNote, paletteOpen, openPalette, closePalette]);

  const title = useMemo(() => NAV.find((n) => n.route === route)?.label ?? 'Jw 知识库', [route]);

  if (route === '/quick') {
    return <QuickCapture onSaved={() => navigate('/inbox')} />;
  }

  return (
    <div className={'app' + (drawerOpen ? ' drawer-open' : '')}>
      {/* 第五版（阶段11）：键盘用户第一下 Tab 就能跳过侧栏，直接把焦点送到正文 */}
      <button type="button" className="skip-link" onClick={() => document.getElementById('main')?.focus()}>
        跳到主内容
      </button>
      <aside
        id="sidebar"
        aria-label="侧栏"
        className={'sidebar' + (collapsed ? ' collapsed' : '') + (drawerOpen ? ' drawer-open' : '')}
      >
        <div className="brand">
          {/* 第五版（方案B）：窗口是无边框的，这三个点就是系统标题栏 */}
          <WinLights />
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <circle cx="7.1" cy="12" r="5.28" fill="none" stroke="#ffffff" strokeWidth="2.4" />
              <circle cx="16.9" cy="12" r="5.28" fill="none" stroke="#ffffff" strokeWidth="2.4" />
              <circle cx="12" cy="12" r="0.95" fill="#5ee7e6" />
            </svg>
          </span>
          <span className="brand-text">Jw 知识库</span>
        </div>
        <nav className="nav" aria-label="主导航">
          {NAV.map((item) => (
            <button
              key={item.route}
              type="button"
              className={route === item.route ? 'nav-item active' : 'nav-item'}
              data-tip={item.label}
              aria-current={route === item.route ? 'page' : undefined}
              onClick={() => {
                navigate(item.route);
                refreshCount();
              }}
            >
              <span className="ico" aria-hidden="true">
                {item.icon}
              </span>
              <span className="nav-label">{item.label}</span>
              {item.countKey === 'inbox' && inboxCount > 0 ? <span className="count">{inboxCount}</span> : null}
            </button>
          ))}
        </nav>
        <div className="nav-sep" />
        <div className="nav-foot">
          <button
            type="button"
            className="icon-btn"
            title={collapsed ? '展开侧栏' : '收起侧栏'}
            aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
            aria-expanded={!collapsed}
            onClick={toggleSidebar}
          >
            {collapsed ? '»' : '«'}
          </button>
          <span className="foot-text">本地运行 · D 盘数据</span>
        </div>
      </aside>

      {/* 第五版（阶段9）：抽屉档的蒙层，点它就把侧栏收回去 */}
      {drawerOpen ? <div className="sidebar-veil" onClick={() => setDrawerOpen(false)} /> : null}

      <main id="main" tabIndex={-1} aria-label="主内容" className="main">
        <header className="topbar">
          {/* 窄窗口（抽屉/单栏档）才出现，宽屏时 display:none */}
          <WinLights className="topbar-lights" />
          <button
            type="button"
            className="icon-btn topbar-burger"
            aria-label={drawerOpen ? '收起侧栏' : '展开侧栏'}
            aria-expanded={drawerOpen}
            aria-controls="sidebar"
            title={drawerOpen ? '收起侧栏' : '展开侧栏'}
            onClick={() => setDrawerOpen((v) => !v)}
          >
            ☰
          </button>
          <h1>{title}</h1>
          <div className="spacer" />
          <div className="searchbox" onClick={() => setSearchOpen(true)}>
            <span aria-hidden="true">🔍</span>
            <input
              aria-label="搜索笔记"
              placeholder="搜索笔记（Ctrl+K）"
              readOnly
              onFocus={() => setSearchOpen(true)}
            />
            <kbd>Ctrl K</kbd>
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => {
              navigate('/inbox');
              toast('在收集箱顶部输入框写下想法，回车即可存');
            }}
          >
            ＋ 快速记录
          </button>
        </header>

        <div className="content">
          {route === '/' && <Dashboard navigate={navigate} refreshCount={refreshCount} openNote={openNote} />}
          {route === '/inbox' && <Inbox navigate={navigate} refreshCount={refreshCount} openNote={openNote} />}
          {route === '/knowledge' && (
            <Knowledge
              openNoteId={openNoteId}
              clearOpenNote={() => setOpenNoteId(null)}
              refreshCount={refreshCount}
              locateQuery={locate && locate.id === openNoteId ? locate.query : null}
              onLocateConsumed={consumeLocate}
            />
          )}
          {route === '/tasks' && <Tasks refreshCount={refreshCount} />}
          {route === '/plans' && <Plans refreshCount={refreshCount} />}
          {route === '/goals' && <Goals refreshCount={refreshCount} />}
          {route === '/next' && <NextGoals refreshCount={refreshCount} navigate={navigate} />}
          {route === '/review' && <Review />}
          {route === '/settings' && <Settings theme={theme} onTheme={changeTheme} />}
          {route !== '/' &&
            route !== '/inbox' &&
            route !== '/knowledge' &&
            route !== '/tasks' &&
            route !== '/plans' &&
            route !== '/goals' &&
            route !== '/next' &&
            route !== '/review' &&
            route !== '/settings' && <div className="empty">这个页面不存在</div>}
        </div>
      </main>

      {searchOpen ? <SearchModal onClose={() => setSearchOpen(false)} openNote={openNote} /> : null}
      {paletteOpen ? (
        <CommandPalette commands={paletteCommands} loading={paletteNotesLoading} onClose={closePalette} />
      ) : null}
      <FocusDock />
      <ToastHost />
      <ContextMenuHost />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 全局搜索                                                            */
/* ------------------------------------------------------------------ */

function SearchModal({ onClose, openNote }: { onClose: () => void; openNote: (id: number, query?: string) => void }): ReactNode {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [meta, setMeta] = useState<SearchAdvancedResult | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);

  /** 渲染层即时解析：只用于 chip 与防呆提示；真正检索由主进程按 raw 再解析一遍。 */
  const parsed = useMemo(() => parseSearchQuery(q), [q]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const parsedNow = parseSearchQuery(q);
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    if (parsedNow.empty) {
      setHits([]);
      setMeta(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    const timer = window.setTimeout(() => {
      api
        .searchAdvanced({ raw: q, limit: 40, text: parsedNow.text, tags: parsedNow.tags, flags: parsedNow.flags })
        .then((result) => {
          if (seqRef.current !== seq) return; // 防串台：输入早变了，旧结果直接丢
          setHits(result.hits);
          setMeta(result);
        })
        .catch((err) => {
          if (seqRef.current !== seq) return;
          toastError('搜索失败：', err);
        })
        .finally(() => {
          if (seqRef.current === seq) setBusy(false);
        });
    }, 160);
    return () => window.clearTimeout(timer);
  }, [q]);

  const hints = searchHintLines(parsed, meta, busy);
  const hasFilter = parsed.tags.length > 0 || parsed.flags.length > 0;

  return (
    <Modal title="全局搜索" variant="search-modal" onClose={onClose} width={640}>
      <div className="row" style={{ marginBottom: 10 }}>
        <input
          ref={inputRef}
          type="text"
          style={{ flex: 1 }}
          placeholder="搜索笔记；支持 tag:标签、is:pinned、is:trash"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {busy ? <span className="spin" /> : null}
      </div>
      {hasFilter ? (
        <div className="search-filters" aria-label="检索过滤条件">
          {parsed.tags.map((tag) => (
            <span key={'tag:' + tag} className="search-filter-chip">
              tag:{tag}
            </span>
          ))}
          {parsed.flags.map((flag) => (
            <span key={'flag:' + flag} className="search-filter-chip">
              is:{SEARCH_FLAG_LABELS[flag]}
            </span>
          ))}
        </div>
      ) : null}
      {hints.length ? (
        <div className="search-hints">
          {hints.map((line) => (
            <p key={line} className="search-hint">
              {line}
            </p>
          ))}
        </div>
      ) : null}
      <div className="list">
        {hits.map((hit) => (
          <div
            key={hit.note_id}
            className="list-row"
            onClick={() => {
              openNote(hit.note_id, q);
              onClose();
            }}
          >
            <div className="grow">
              <div className="title">{hit.title || '无标题笔记'}</div>
              <div className="sub">
                {hit.category_name ? hit.category_name + ' · ' : ''}
                {hit.snippet.replace(/[\u0000-\u001f]/g, ' ')}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/**
 * 搜索防呆提示（0.12.0 阶段2）：标签不存在、状态不支持、0 结果都要给人话，
 * 不能只留一片空白。返回空数组表示没有额外提示（正常结果）。
 */
function searchHintLines(parsed: ParsedSearchQuery, meta: SearchAdvancedResult | null, busy: boolean): string[] {
  const lines: string[] = [];
  const unknownTags = meta ? meta.unknownTags : [];
  const unknownFlags = meta ? meta.unknownFlags : parsed.unknownFlags;
  if (unknownTags.length) lines.push('未找到标签：' + unknownTags.join('、') + '（去标签管理看看有没有重名/错字）');
  if (unknownFlags.length) lines.push('不支持的状态：' + unknownFlags.join('、') + '（可用：pinned、trash）');
  if (parsed.empty) {
    if (unknownFlags.length === 0) lines.push('输入关键词开始搜索，支持 tag:标签、is:pinned、is:trash');
    return lines;
  }
  if (busy || !meta) return lines;
  if (meta.hits.length > 0) return lines;
  if (unknownFlags.length > 0 || unknownTags.length > 0) return lines;
  if (meta.tags.length > 0 && !meta.text) {
    lines.push('「' + meta.tags.join('」「') + '」下没有找到笔记，试试更换关键词');
  } else {
    lines.push('没有找到匹配的笔记，试试更换关键词');
  }
  return lines;
}
