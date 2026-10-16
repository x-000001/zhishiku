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

export default function App(): ReactNode {
  const [route, navigate] = useHashRoute();
  const [collapsed, setCollapsed] = useState(false);
  const [inboxCount, setInboxCount] = useState(0);
  const [openNoteId, setOpenNoteId] = useState<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
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
  }, [theme]);

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
    <div className="app">
      <aside className={collapsed ? 'sidebar collapsed' : 'sidebar'}>
        <div className="brand">
          {/* 第五版（方案B）：窗口是无边框的，这三个点就是系统标题栏 */}
          <div className="win-lights">
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
          <span className="brand-mark">Jw</span>
          <span className="brand-text">知识库</span>
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <button
              key={item.route}
              type="button"
              className={route === item.route ? 'nav-item active' : 'nav-item'}
              title={item.label}
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

      <main className="main">
        <header className="topbar">
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
          {route === '/settings' && <Settings theme={theme} onTheme={setTheme} />}
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
