import React from 'react';
import { createRoot } from 'react-dom/client';
// Cascade layers: reset, astryx-base (component styles), astryx-theme (the
// Boxops tokens, injected by <Theme>). Everything in styles.css is unlayered
// and so wins over all three.
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import './theme/boxops.css';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
