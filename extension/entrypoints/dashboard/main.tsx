import '../../lib/crypto-polyfill';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { DashboardApp } from './app';
import { track } from '../../lib/analytics';
track({ name: 'open', platform: 'extension', feature: 'dashboard' });
createRoot(document.getElementById('root')!).render(<React.StrictMode><DashboardApp /></React.StrictMode>);
