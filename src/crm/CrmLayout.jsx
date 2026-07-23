import { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import Palette from './neva/Palette.jsx'

const NAV = [
  { to: '/crm', label: 'Дашборд', icon: 'M3 13h8V3H3v10zm10 8h8V11h-8v10zM3 21h8v-6H3v6zm10-18v6h8V3h-8z', end: true },
  { to: '/crm/deals', label: 'Сделки', icon: 'M4 4h4v16H4zM10 8h4v12h-4zM16 5h4v15h-4z' },
  { to: '/crm/contacts', label: 'Контакты', icon: 'M12 12a4 4 0 100-8 4 4 0 000 8zm0 2c-4 0-7 2-7 5v1h14v-1c0-3-3-5-7-5z' },
  { to: '/crm/tasks', label: 'Задачи', icon: 'M9 11l3 3 8-8M4 6h4M4 12h4M4 18h10' },
  { to: '/crm/settings', label: 'Настройки', icon: 'M12 15a3 3 0 100-6 3 3 0 000 6zm8-3l2 1-2 3-2-1a7 7 0 01-2 1l-.5 2.5h-3L12 16a7 7 0 01-2-1l-2 1-2-3 2-1a7 7 0 010-2L6 9l2-3 2 1a7 7 0 012-1l.5-2.5h3L16 6a7 7 0 012 1l2-1 2 3-2 1a7 7 0 010 2z' },
]

export default function CrmLayout({ user, onLogout }) {
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => {
    // e.code — работает и на русской раскладке (e.key там «л»)
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="crm">
      <aside className="crm-rail">
        <div className="crm-logo">
          NEVARIUM<b>/</b>CRM
        </div>
        <nav aria-label="Разделы CRM">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `crm-nav${isActive ? ' on' : ''}`}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d={item.icon} /></svg>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <button className="crm-neva-hint" onClick={() => setPaletteOpen(true)}>
          <span>
            Спросите <b>Неву</b>
          </span>
          <kbd>Ctrl K</kbd>
        </button>
        <div className="crm-user">
          <span className="crm-avatar" aria-hidden="true">{(user.name || '?')[0]}</span>
          <span className="crm-user-name">{user.name}</span>
          <button className="crm-logout" onClick={onLogout} title="Выйти">⎋</button>
        </div>
      </aside>
      <main className="crm-main">
        <Outlet context={{ user }} />
      </main>
      <button className="crm-fab" onClick={() => setPaletteOpen(true)} aria-label="Открыть Неву">N</button>
      {paletteOpen && <Palette onClose={() => setPaletteOpen(false)} />}
    </div>
  )
}
