import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { repo } from '../api.js'
import { EntityModal } from '../forms.jsx'
import { apiErrorToast, onRefresh } from '../ui.jsx'

const SOURCE_LABEL = { 'site-form': 'сайт', 'site-chat': 'чат Невы', manual: 'вручную', import: 'импорт' }

export default function Contacts() {
  const [data, setData] = useState(null)
  const [q, setQ] = useState('')
  const [modal, setModal] = useState(false)

  const load = useCallback((query = '') => {
    repo.list('contacts', query).then(setData).catch(apiErrorToast)
  }, [])

  useEffect(() => {
    const t = setTimeout(() => load(q), q ? 250 : 0)
    return () => clearTimeout(t)
  }, [q, load])
  useEffect(() => onRefresh(() => load(q)), [q, load])

  return (
    <>
      <div className="crm-head">
        <div>
          <h1 className="crm-h1">Контакты</h1>
          <div className="crm-sub">{data ? `${data.total} всего` : ' '}</div>
        </div>
        <button className="btn primary" onClick={() => setModal(true)}>+ Контакт</button>
      </div>
      <input
        className="crm-search"
        placeholder="Поиск: имя, компания, телефон, email…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Поиск контактов"
      />
      <div className="tile" style={{ marginTop: 16 }}>
        {!data && <><div className="skeleton" /><div className="skeleton" /><div className="skeleton" style={{ width: '70%' }} /></>}
        {data && data.items.length === 0 && (
          <div className="empty">{q ? 'Ничего не найдено — уточните запрос.' : 'Контактов пока нет.'}<br />
            {!q && <button className="btn" onClick={() => setModal(true)}>Создать первый контакт</button>}
          </div>
        )}
        {data?.items.map((c) => (
          <div className="row-line" key={c.id}>
            <div>
              <div className="row-name"><Link to={`/crm/contacts/${c.id}`}>{c.name}</Link>{c.company ? <span className="row-meta"> · {c.company}</span> : null}</div>
              <div className="row-meta">{[c.phone, c.email, c.messenger].filter(Boolean).join(' · ') || 'без контактов'}</div>
            </div>
            <span style={{ display: 'flex', gap: 6 }}>
              {c.suspicious ? <span className="badge warn">подозрительный</span> : null}
              {c.archived ? <span className="badge gray">архив</span> : <span className="badge gray">{SOURCE_LABEL[c.source] || c.source}</span>}
            </span>
          </div>
        ))}
        {data && data.total > data.items.length && (
          <div className="crm-cap">Показаны первые {data.items.length} из {data.total} — уточните поиск.</div>
        )}
      </div>
      {modal && <EntityModal entity="contacts" onSaved={() => load(q)} onClose={() => setModal(false)} />}
    </>
  )
}
