import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { BillsBadgeProvider } from './context/BillsBadgeContext';
import { MetaProvider } from './context/MetaContext';
import { SelectionProvider } from './context/SelectionContext';
import { ThemeProvider } from './context/ThemeContext';
import { ToastProvider } from './context/ToastContext';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <MetaProvider>
          <SelectionProvider>
            <BillsBadgeProvider>
              <BrowserRouter>
                <App />
              </BrowserRouter>
            </BillsBadgeProvider>
          </SelectionProvider>
        </MetaProvider>
      </ToastProvider>
    </ThemeProvider>
  </StrictMode>,
);
