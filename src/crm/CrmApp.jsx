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
import Settings from './pages/Settings.jsx'
import { Toasts } from './ui.jsx'
import './crm.css'

export default function CrmApp() {
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
        <Route path="contacts/:id" element={<ContactCard />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="settings" element={<Settings user={me} />} />
        <Route path="*" element={<Dashboard />} />
      </Route>
    </Routes>
    </>
  )
}
