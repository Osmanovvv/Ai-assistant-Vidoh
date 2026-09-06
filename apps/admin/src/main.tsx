import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import './theme.css';

const root = document.getElementById('root');

// Без корня показывать нечего, и молчать об этом нельзя: пустая белая
// страница — худший способ сообщить о поломке сборки.
if (root === null) throw new Error('В странице нет узла #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
