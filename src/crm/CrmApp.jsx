import { useCallback, useEffect, useState } from 'react'
import { Routes, Route } from 'react-router-dom'
import { api, setUnauthorizedHandler } from './api.js'
import CrmLayout from './CrmLayout.jsx'
import Login from './Login.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Deals from './pages/Deals.jsx'
import Contacts from './pages/Contacts.jsx'
import ContactCard from './pages/ContactCard.jsx'
import Tasks from './pages/Tasks.jsx'
import Privacy from './pages/Privacy.jsx'
import NvizorFree from './pages/NvizorFree.jsx'
import Analytics from './pages/Analytics.jsx'
import Settings from './pages/Settings.jsx'
import { Toasts } from './ui.jsx'
import { ConfirmEmailPage, ResetPasswordPage } from './AccountPages.jsx'
import './crm.css'

// Публичные страницы по ссылкам из писем (ADR-020) открываются БЕЗ входа — до проверки сессии.
export default function CrmApp() {
  const path = window.location.pathname.replace(/\/+$/, '')
  if (path === '/crm/reset') return <ResetPasswordPage />
  if (path === '/crm/confirm-email') return <ConfirmEmailPage />
  return <CrmMain />
}

function CrmMain() {
  const [me, setMe] = useState(undefined) // undefined = проверяем, null = не вошли

  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null))
    api('/auth/me').then(setMe).catch(() => setMe(null))
  }, [])

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' })
    } finally {
      setMe(null)
    }
  }, [])

  if (me === undefined) return <div className="crm-boot">Загрузка CRM…</div>
  if (me === null) return <Login onLogin={setMe} />

  return (
    <>
    <Toasts />
    <Routes>
      <Route path="/crm" element={<CrmLayout user={me} onLogout={logout} />}>
        <Route index element={<Dashboard />} />
        <Route path="deals" element={<Deals />} />
        <Route path="contacts" element={<Contacts />} />
        <Route path="contacts/:id" element={<ContactCard user={me} />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="privacy" element={<Privacy user={me} />} />
        <Route path="nvizor-free" element={<NvizorFree user={me} />} />
        <Route path="analytics" element={<Analytics user={me} />} />
        <Route path="settings" element={<Settings user={me} />} />
        <Route path="*" element={<Dashboard />} />
      </Route>
    </Routes>
    </>
  )
}
