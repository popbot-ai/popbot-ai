import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { I18nProvider } from './lib/i18n';
import './styles/tailwind.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root not found in index.html');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);
