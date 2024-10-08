import React from 'react';
import ReactDOM from 'react-dom';
import './styles/main.css';
import App from './App';
import reportWebVitals from './reportWebVitals';
import { initWeb3 } from './services/web3';

// Initialize Web3
initWeb3().catch(console.error);

ReactDOM.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
  document.getElementById('root')
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
