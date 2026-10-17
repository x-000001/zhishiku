import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, onEvent } from './api';
import { Modal, ToastHost, toast } from './ui';
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
import type { SearchHit } from '../../shared/types';

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
      timer = window.setTimeout(() => root.classList.remove('is-resizing'), 150);
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const layout = useLayout();
  const openNote = useCallback(
    (id: number) => {
      setOpenNoteId(id);
      navigate('/knowledge');
    },
    [navigate]
  );

  const refreshCount = useCallback(() => {
    void api.listInbox('open').then((list) => setInboxCount(list.length));
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
      window.setTimeout(() => root.classList.remove('theme-transitioning'), 340);
    }
    setTheme(next);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'k') {
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
  }, [navigate, openNote]);

  const title = useMemo(() => NAV.find((n) => n.route === route)?.label ?? 'Jw 知识库', [route]);

  if (route === '/quick') {
    return <QuickCapture onSaved={() => navigate('/inbox')} />;
  }

  return (
    <div className={'app' + (drawerOpen ? ' drawer-open' : '')}>
      <aside
        className={'sidebar' + (collapsed ? ' collapsed' : '') + (drawerOpen ? ' drawer-open' : '')}
      >
        <div className="brand">
          {/* 第五版（方案B）：窗口是无边框的，这三个点就是系统标题栏 */}
          <WinLights />
          <span className="brand-mark">Jw</span>
          <span className="brand-text">知识库</span>
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <button
              key={item.route}
              type="button"
              className={route === item.route ? 'nav-item active' : 'nav-item'}
              data-tip={item.label}
              onClick={() => {
                navigate(item.route);
                refreshCount();
              }}
            >
              <span className="ico">{item.icon}</span>
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
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? '»' : '«'}
          </button>
          <span className="foot-text">本地运行 · D 盘数据</span>
        </div>
      </aside>

      {/* 第五版（阶段9）：抽屉档的蒙层，点它就把侧栏收回去 */}
      {drawerOpen ? <div className="sidebar-veil" onClick={() => setDrawerOpen(false)} /> : null}

      <main className="main">
        <header className="topbar">
          {/* 窄窗口（抽屉/单栏档）才出现，宽屏时 display:none */}
          <WinLights className="topbar-lights" />
          <button
            type="button"
            className="icon-btn topbar-burger"
            aria-label={drawerOpen ? '收起侧栏' : '展开侧栏'}
            title={drawerOpen ? '收起侧栏' : '展开侧栏'}
            onClick={() => setDrawerOpen((v) => !v)}
          >
            ☰
          </button>
          <h1>{title}</h1>
          <div className="spacer" />
          <div className="searchbox" onClick={() => setSearchOpen(true)}>
            <span>🔍</span>
            <input placeholder="搜索笔记（Ctrl+K）" readOnly onFocus={() => setSearchOpen(true)} />
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
          {route === '/knowledge' && <Knowledge openNoteId={openNoteId} clearOpenNote={() => setOpenNoteId(null)} refreshCount={refreshCount} />}
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
      <ToastHost />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 全局搜索                                                            */
/* ------------------------------------------------------------------ */

function SearchModal({ onClose, openNote }: { onClose: () => void; openNote: (id: number) => void }): ReactNode {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const text = q.trim();
    if (!text) {
      setHits([]);
      return;
    }
    setBusy(true);
    const timer = window.setTimeout(() => {
      api
        .search(text, 40)
        .then(setHits)
        .catch((err: Error) => toast('搜索失败：' + err.message))
        .finally(() => setBusy(false));
    }, 160);
    return () => window.clearTimeout(timer);
  }, [q]);

  return (
    <Modal title="全局搜索" variant="search-modal" onClose={onClose} width={640}>
      <div className="row" style={{ marginBottom: 12 }}>
        <input
          ref={inputRef}
          type="text"
          style={{ flex: 1 }}
          placeholder="输入关键词，中文两个字也能搜到"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {busy ? <span className="spin" /> : null}
      </div>
      <div className="list">
        {hits.map((hit) => (
          <div
            key={hit.note_id}
            className="list-row"
            onClick={() => {
              openNote(hit.note_id);
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
        {q.trim() && !busy && hits.length === 0 ? <div className="empty">没有找到相关笔记</div> : null}
        {!q.trim() ? <div className="empty">输入关键词开始搜索</div> : null}
      </div>
    </Modal>
  );
}
