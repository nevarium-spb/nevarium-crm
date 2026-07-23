import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './styles/base.css'
import CrmApp from './crm/CrmApp.jsx'

// Standalone-CRM: приложение целиком живёт на роутах /crm/*.
// Корень перенаправляем на /crm до первого рендера (без изменения CrmApp).
if (window.location.pathname === '/') {
  window.history.replaceState(null, '', '/crm')
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <CrmApp />
    </BrowserRouter>
  </React.StrictMode>,
)
