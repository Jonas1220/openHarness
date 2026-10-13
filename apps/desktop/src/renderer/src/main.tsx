import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Outside Electron (plain `vite` in a browser) there is no preload API: use the mock.
if (!window.oh) await import('./mock');

createRoot(document.getElementById('root')!).render(<App />);
