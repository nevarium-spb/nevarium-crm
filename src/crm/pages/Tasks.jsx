import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { repo } from '../api.js'
import { EntityModal } from '../forms.jsx'
import { apiErrorToast, fmtDate, mskTodayStr, onRefresh, toast } from '../ui.jsx'

export default function Tasks() {
  const [data, setData] = useState(null)
  const [contacts, setContacts] = useState([])
  const [modal, setModal] = useState(null)
  const [showDone, setShowDone] = useState(false)
  const today = mskTodayStr()

  const load = useCallback(() => {
    Promise.all([repo.list('tasks'), repo.list('contacts')])
      .then(([t, c]) => {
        setData(t.items)
        setContacts(c.items)
      })
      .catch(apiErrorToast)
  }, [])
  useEffect(load, [load])
  useEffect(() => onRefresh(load), [load])

  const contactById = useMemo(() => new Map(contacts.map((c) => [c.id, c.name])), [contacts])
  const contactName = (id) => contactById.get(id)

  const toggle = async (t) => {
    try {
      await repo.update('tasks', t.id, { done: t.done ? 0 : 1 })
      load()
    } catch (err) { apiErrorToast(err) }
  }

  const remove = async (t) => {
    if (!window.confirm(`Удалить задачу «${t.title}»?`)) return
    try {
      await repo.remove('tasks', t.id)
      toast('Задача удалена')
      load()
    } catch (err) { apiErrorToast(err) }
  }

  const open = useMemo(
    () => (data ?? []).filter((t) => !t.done).sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999')),
    [data]
  )
  const done = useMemo(() => (data ?? []).filter((t) => t.done), [data])

  return (
    <>
      <div className="crm-head">
        <div>
          <h1 className="crm-h1">Задачи</h1>
          <div className="crm-sub">{data ? `${open.length} открыто · ${open.filter((t) => t.due_date && t.due_date < today).length} просрочено` : ' '}</div>
        </div>
        <button className="btn primary" onClick={() => setModal({})}>+ Задача</button>
      </div>
      <div className="tile">
        {!data && <><div className="skeleton" /><div className="skeleton" style={{ width: '65%' }} /></>}
        {data && open.length === 0 && <div className="empty">Все задачи закрыты.<br /><button className="btn" onClick={() => setModal({})}>Новая задача</button></div>}
        {open.map((t) => (
          <div className="task-line" key={t.id}>
            <button className="task-check" onClick={() => toggle(t)} aria-label="Выполнено" />
            <span className="task-title" onDoubleClick={() => setModal(t)}>
              {t.title}
              {t.contact_id && contactName(t.contact_id) ? <span className="row-meta"> — <Link to={`/crm/contacts/${t.contact_id}`}>{contactName(t.contact_id)}</Link></span> : null}
            </span>
            <span className={`task-due${t.due_date && t.due_date < today ? ' over' : ''}`}>
              {t.due_date ? (t.due_date < today ? `просрочено · ${fmtDate(t.due_date)}` : t.due_date === today ? 'сегодня' : fmtDate(t.due_date)) : 'без срока'}
            </span>
            <button className="deal-move" style={{ position: 'static' }} onClick={() => remove(t)} aria-label="Удалить">✕</button>
          </div>
        ))}
      </div>
      {done.length > 0 && (
        <div className="tile" style={{ marginTop: 14 }}>
          <button className="btn" style={{ minHeight: 32, fontSize: 12.5 }} onClick={() => setShowDone((v) => !v)}>
            {showDone ? 'Скрыть выполненные' : `Выполненные (${done.length})`}
          </button>
          {showDone && done.map((t) => (
            <div className="task-line done" key={t.id}>
              <button className="task-check done" onClick={() => toggle(t)} aria-label="Вернуть" />
              <span className="task-title">{t.title}</span>
              <span className="task-due">{fmtDate(t.done_at)}</span>
            </div>
          ))}
        </div>
      )}
      {modal && <EntityModal entity="tasks" initial={modal} onSaved={load} onClose={() => setModal(null)} />}
    </>
  )
}
