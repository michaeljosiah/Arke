import './styles/tokens.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './root';

const container = document.getElementById('app');
if (!container) throw new Error('No #app element found');

createRoot(container).render(React.createElement(Root));
