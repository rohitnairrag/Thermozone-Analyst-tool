import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ValidationPage from './components/ValidationPage';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const isValidate = window.location.pathname === '/validate';

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    {isValidate ? <ValidationPage /> : <App />}
  </React.StrictMode>
);