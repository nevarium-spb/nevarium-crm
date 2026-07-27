import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { repo } from '../api.js'
import { EntityModal } from '../forms.jsx'
import { ProjectBadge, ProjectFilter, useProjectFilter } from '../projects.jsx'
import { apiErrorToast, onRefresh } from '../ui.jsx'

const SOURCE_LABEL = { 'site-form': 'сайт', 'site-chat': 'чат Невы', manual: 'вручную', import: 'импорт' }

export default function Contacts() {
  const [data, setData] = useState(null)
  const [q, setQ] = useState('')
  const [modal, setModal] = useState(false)
  const [project, setProject] = useProjectFilter()

  // Считаем запросы: при быстром переключении проекта ответы могут прийти не по
  // порядку, и медленный старый затёр бы свежий — на экране оказался бы чужой проект.
  const reqId = useRef(0)
  const load = useCallback(
    (query = '') => {
      const id = ++reqId.current
      repo
        .list('contacts', { q: query, project })
        .then((d) => id === reqId.current && setData(d))
        .catch((e) => id === reqId.current && apiErrorToast(e))
    },
    [project]
  )

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
      <div className="crm-filters">
        <input
          className="crm-search"
          placeholder="Поиск: имя, компания, телефон, email…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Поиск контактов"
        />
        <ProjectFilter value={project} onChange={setProject} />
      </div>
      <div className="tile" style={{ marginTop: 16 }}>
        {!data && <><div className="skeleton" /><div className="skeleton" /><div className="skeleton" style={{ width: '70%' }} /></>}
        {data && data.items.length === 0 && (
          <div className="empty">
            {q ? 'Ничего не найдено — уточните запрос.' : project !== 'all' ? 'В этом проекте контактов пока нет.' : 'Контактов пока нет.'}
            <br />
            {!q && project !== 'all' && <button className="btn" onClick={() => setProject('all')}>Показать все проекты</button>}
            {!q && project === 'all' && <button className="btn" onClick={() => setModal(true)}>Создать первый контакт</button>}
          </div>
        )}
        {data?.items.map((c) => (
          <div className="row-line" key={c.id}>
            <div>
              <div className="row-name"><Link to={`/crm/contacts/${c.id}`}>{c.name}</Link>{c.company ? <span className="row-meta"> · {c.company}</span> : null}</div>
              <div className="row-meta">{[c.phone, c.email, c.messenger].filter(Boolean).join(' · ') || 'без контактов'}</div>
            </div>
            <span className="row-badges">
              <ProjectBadge id={c.project_id} when={project === 'all'} />
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
