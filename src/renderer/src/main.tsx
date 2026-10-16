import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('找不到挂载节点 #root');

// 不用 StrictMode：避免开发环境下 effect 双跑导致重复写库
createRoot(container).render(<App />);
