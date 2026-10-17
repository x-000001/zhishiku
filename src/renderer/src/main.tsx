import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// ============================================================
// 第五版（阶段8）：主题在首帧之前就定下来
// 主进程把库里存的主题挂在 URL 上（?theme=dark），这里在 React 挂载之前
// 就写到 <html data-theme>，于是「上次选深色」的窗口不会先亮一下再变暗。
// localStorage 只作兜底（比如 dev server 直连时没有主进程拼 URL）。
// data-theme-boot 留个记号，自检脚本用它确认首帧用的就是存下来的主题。
// ============================================================
const bootTheme = (() => {
  const fromUrl = new URLSearchParams(window.location.search).get('theme');
  if (fromUrl === 'dark' || fromUrl === 'light') return fromUrl;
  try {
    return window.localStorage.getItem('jw-theme') === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
})();
document.documentElement.setAttribute('data-theme', bootTheme);
document.documentElement.dataset.themeBoot = bootTheme;

const container = document.getElementById('root');
if (!container) throw new Error('找不到挂载节点 #root');

// 不用 StrictMode：避免开发环境下 effect 双跑导致重复写库
createRoot(container).render(<App />);
