// Self-hosted Geist (SPEC-022): bundle the exact weights the UI uses instead of a remote Google Fonts
// <link>, so a strict Electron CSP (no remote content) holds and the app works offline. This serves the
// browser build too (offline, no third-party font request).
import '@fontsource/geist-sans/400.css';
import '@fontsource/geist-sans/500.css';
import '@fontsource/geist-sans/600.css';
import '@fontsource/geist-sans/700.css';
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import '@fontsource/geist-mono/600.css';
import './styles/tokens.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './root';

const container = document.getElementById('app');
if (!container) throw new Error('No #app element found');

createRoot(container).render(React.createElement(Root));
