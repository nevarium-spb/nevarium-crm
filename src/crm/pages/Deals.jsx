import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { repo } from '../api.js'
import { EntityModal } from '../forms.jsx'
import { STAGES, TERMINAL_STAGES as TERMINAL } from '../../shared/stages.js'
import { ProjectBadge, ProjectFilter, useProjectFilter } from '../projects.jsx'
import { apiErrorToast, fmtMoney, onRefresh, toast } from '../ui.jsx'

export default function Deals() {
  const [deals, setDeals] = useState(null)
  const [contacts, setContacts] = useState([])
  const [modal, setModal] = useState(null) // {initial}
  const [menuFor, setMenuFor] = useState(null)
  const dragId = useRef(null)
  const [project, setProject] = useProjectFilter()

  // Считаем запросы: при быстром переключении проекта ответы могут прийти не по
  // порядку, и медленный старый затёр бы свежий — на доске оказался бы чужой проект.
  const reqId = useRef(0)
  const load = useCallback(() => {
    const id = ++reqId.current
    // контакты — для подписи «чей это лид», их берём по тому же фильтру
    Promise.all([repo.list('deals', { project }), repo.list('contacts', { project })])
      .then(([d, c]) => {
        if (id !== reqId.current) return
        setDeals(d.items)
        setContacts(c.items)
      })
      .catch((e) => id === reqId.current && apiErrorToast(e))
  }, [project])
  useEffect(load, [load])
  useEffect(() => onRefresh(load), [load])

  useEffect(() => {
    const close = () => setMenuFor(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  const contactById = useMemo(() => new Map(contacts.map((c) => [c.id, c.name])), [contacts])
  const contactName = (id) => contactById.get(id) || '—'

  const move = async (deal, stage) => {
    setMenuFor(null)
    if (deal.stage === stage) return
    const prev = deals
    setDeals((ds) => ds.map((d) => (d.id === deal.id ? { ...d, stage } : d)))
    try {
      await repo.update('deals', deal.id, { stage, expectedUpdatedAt: deal.updated_at })
      load()
    } catch (err) {
      setDeals(prev)
      if (err.kind === 'conflict') {
        toast('Сделка изменена в другом окне — обновляю', 'error')
        load()
      } else apiErrorToast(err)
    }
  }

  const remove = async (deal) => {
    setMenuFor(null)
    if (!window.confirm(`Удалить сделку «${deal.title}»? Действия по контакту сохранятся.`)) return
    try {
      await repo.remove('deals', deal.id)
      toast('Сделка удалена')
      load()
    } catch (err) {
      apiErrorToast(err)
    }
  }

  if (!deals)
    return (
      <>
        <h1 className="crm-h1">Сделки</h1>
        <div className="kanban">{STAGES.slice(0, 4).map((s) => <div className="kanban-col" key={s}><div className="skeleton" /><div className="skeleton" style={{ height: 60 }} /></div>)}</div>
      </>
    )

  return (
    <>
      <div className="crm-head">
        <div>
          <h1 className="crm-h1">Сделки</h1>
          <div className="crm-sub">{deals.filter((d) => !TERMINAL.includes(d.stage)).length} в работе · {fmtMoney(deals.filter((d) => !TERMINAL.includes(d.stage)).reduce((s, d) => s + (d.amount || 0), 0))}</div>
        </div>
        <div className="crm-head-actions">
          <ProjectFilter value={project} onChange={setProject} />
          <button className="btn primary" onClick={() => setModal({ initial: {} })}>+ Сделка</button>
        </div>
      </div>
      <div className="kanban">
        {STAGES.map((stage) => {
          const col = deals.filter((d) => d.stage === stage)
          const sum = col.reduce((s, d) => s + (d.amount || 0), 0)
          return (
            <div
              className={`kanban-col${TERMINAL.includes(stage) ? ' terminal' : ''}`}
              key={stage}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                const deal = deals.find((d) => d.id === dragId.current)
                if (deal) move(deal, stage)
              }}
            >
              <h3>{stage}<span>{sum > 0 ? fmtMoney(sum) : col.length || ''}</span></h3>
              {col.length === 0 && <div className="kanban-empty">Перетащите сделку сюда или создайте новую</div>}
              {col.map((deal) => (
                <div
                  className="deal-card"
                  key={deal.id}
                  draggable
                  onDragStart={() => (dragId.current = deal.id)}
                  onDoubleClick={() => setModal({ initial: deal })}
                >
                  <div className="deal-title">{deal.title}</div>
                  <div className="deal-meta">
                    <Link to={`/crm/contacts/${deal.contact_id}`}>{contactName(deal.contact_id)}</Link>
                    <span className="deal-amount">{fmtMoney(deal.amount)}</span>
                  </div>
                  <ProjectBadge id={deal.project_id} when={project === 'all'} />
                  <button
                    className="deal-move"
                    aria-label="Переместить или изменить"
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenuFor(menuFor === deal.id ? null : deal.id)
                    }}
                  >⋯</button>
                  {menuFor === deal.id && (
                    <div className="menu" onClick={(e) => e.stopPropagation()}>
                      {STAGES.filter((s) => s !== deal.stage).map((s) => (
                        <button key={s} onClick={() => move(deal, s)}>→ {s}</button>
                      ))}
                      <button onClick={() => { setMenuFor(null); setModal({ initial: deal }) }}>Изменить</button>
                      <button className="danger" onClick={() => remove(deal)}>Удалить</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )
        })}
      </div>
      {modal && <EntityModal entity="deals" initial={modal.initial} onSaved={load} onClose={() => setModal(null)} />}
    </>
  )
}
