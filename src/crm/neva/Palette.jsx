import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { repo } from '../api.js'
import { EntityModal } from '../forms.jsx'
import { apiErrorToast, emitRefresh, toast } from '../ui.jsx'
import { parseCommand } from './parser.js'

const HINTS = ['лид Марина, Северный свет, +7 921…', 'задача: отправить КП в пятницу', 'звонок с Ивановым: обсудили пилот']

// Палитра Ctrl+K: авто-детект команда/поиск по префиксам грамматики.
// Команды НИКОГДА не пишут без предпросмотра-подтверждения; неуверенный
// разбор откатывается к обычной форме.
export default function Palette({ onClose }) {
  const navigate = useNavigate()
  const inputRef = useRef(null)
  const [query, setQuery] = useState('')
  const [contacts, setContacts] = useState([])
  const [deals, setDeals] = useState([])
  const [tasks, setTasks] = useState([])
  const [sel, setSel] = useState(0)
  const [preview, setPreview] = useState(null) // intent на подтверждении
  const [fallbackForm, setFallbackForm] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    inputRef.current?.focus()
    Promise.all([repo.list('contacts'), repo.list('deals'), repo.list('tasks')])
      .then(([c, d, t]) => {
        setContacts(c.items)
        setDeals(d.items)
        setTasks(t.items)
      })
      .catch(() => {})
  }, [])

  const intent = useMemo(() => parseCommand(query, { contacts }), [query, contacts])

  const results = useMemo(() => {
    if (intent || query.trim().length < 2) return []
    const q = query.trim().toLowerCase()
    const hit = (s) => (s || '').toLowerCase().includes(q)
    return [
      ...contacts.filter((c) => hit(c.name) || hit(c.company) || hit(c.phone) || hit(c.email)).slice(0, 5).map((c) => ({ kind: 'контакт', label: c.name + (c.company ? ` · ${c.company}` : ''), to: `/crm/contacts/${c.id}` })),
      ...deals.filter((d) => hit(d.title)).slice(0, 4).map((d) => ({ kind: 'сделка', label: `${d.title} · ${d.stage}`, to: '/crm/deals' })),
      ...tasks.filter((t) => !t.done && hit(t.title)).slice(0, 3).map((t) => ({ kind: 'задача', label: t.title, to: '/crm/tasks' })),
    ]
  }, [query, intent, contacts, deals, tasks])

  useEffect(() => setSel(0), [query])

  const go = (r) => {
    onClose()
    navigate(r.to)
  }

  const confirm = async () => {
    if (busy || !preview) return
    setBusy(true)
    try {
      if (preview.kind === 'lead') {
        const res = await repo.create('contacts', {
          name: preview.name, company: preview.company, phone: preview.phone, email: preview.email, source: 'manual',
        })
        await repo.create('deals', { contact_id: res.item.id, title: 'Новая заявка', stage: 'Новый' })
        if (res.duplicateOf) toast(`Похоже на дубль: ${res.duplicateOf.name}`, 'error')
        toast(`Лид «${preview.name}» создан`)
        onClose()
        navigate(`/crm/contacts/${res.item.id}`)
      } else if (preview.kind === 'task') {
        await repo.create('tasks', { title: preview.title, contact_id: preview.contact?.id ?? null, due_date: preview.dueDate })
        toast('Задача создана')
        emitRefresh()
        onClose()
      } else if (preview.kind === 'interaction') {
        await repo.create('interactions', { contact_id: preview.contact.id, type: preview.type, note: preview.note })
        toast('Действие записано')
        emitRefresh()
        onClose()
      }
    } catch (err) {
      apiErrorToast(err)
    } finally {
      setBusy(false)
    }
  }

  const openForm = () => {
    const i = intent || preview
    if (!i) return
    if (i.kind === 'lead') setFallbackForm({ entity: 'contacts', initial: { name: i.name, company: i.company, phone: i.phone, email: i.email } })
    else if (i.kind === 'task') setFallbackForm({ entity: 'tasks', initial: { title: i.title, contact_id: i.contact?.id, due_date: i.dueDate } })
    else setFallbackForm({ entity: 'interactions', initial: { type: i.type, note: i.note || i.rawName } })
  }

  const onKey = (e) => {
    if (e.key === 'Escape') return onClose()
    if (preview) {
      if (e.key === 'Enter') {
        e.preventDefault()
        confirm()
      }
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)) }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (intent) {
        if (intent.kind === 'interaction-unmatched') openForm()
        else setPreview(intent)
      } else if (results[sel]) go(results[sel])
    }
  }

  if (fallbackForm)
    return <EntityModal entity={fallbackForm.entity} initial={fallbackForm.initial} onSaved={() => {}} onClose={onClose} />

  return (
    <div className="crm-palette-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="crm-palette" role="dialog" aria-modal="true" aria-label="Нева">
        <div className="crm-palette-input">
          <span className="crm-palette-n" aria-hidden="true">N</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPreview(null) }}
            onKeyDown={onKey}
            placeholder="Поиск или команда: лид…, задача:…, звонок с…"
            aria-label="Команда или поиск"
          />
          <kbd>Esc</kbd>
        </div>

        {preview && (
          <div className="crm-preview">
            <h3>Нева поняла так — подтвердить?</h3>
            <dl className="crm-preview-card">
              {preview.kind === 'lead' && (
                <>
                  <dt>Новый лид</dt><dd>{preview.name}{preview.company ? ` · ${preview.company}` : ''}</dd>
                  {(preview.phone || preview.email) && <><dt>Контакты</dt><dd>{[preview.phone, preview.email].filter(Boolean).join(' · ')}</dd></>}
                  <dt>Сделка</dt><dd>«Новая заявка» в этапе Новый</dd>
                </>
              )}
              {preview.kind === 'task' && (
                <>
                  <dt>Задача</dt><dd>{preview.title}</dd>
                  {preview.contact && <><dt>Контакт</dt><dd>{preview.contact.name}</dd></>}
                  <dt>Срок</dt><dd>{preview.dueDate || 'без срока'}</dd>
                </>
              )}
              {preview.kind === 'interaction' && (
                <>
                  <dt>{preview.type}</dt><dd>с {preview.contact.name}</dd>
                  {preview.note && <><dt>Заметка</dt><dd>{preview.note}</dd></>}
                </>
              )}
            </dl>
            <div className="crm-preview-actions">
              <button className="btn primary" onClick={confirm} disabled={busy}>{busy ? 'Создаём…' : 'Подтвердить ⏎'}</button>
              <button className="btn" onClick={openForm}>Открыть форму</button>
              <button className="btn" onClick={() => setPreview(null)}>Назад</button>
            </div>
          </div>
        )}

        {!preview && intent && intent.kind !== 'interaction-unmatched' && (
          <div className="crm-preview">
            <h3>Команда распознана — Enter для предпросмотра</h3>
            <button className="btn primary" onClick={() => setPreview(intent)}>Показать предпросмотр</button>
          </div>
        )}

        {!preview && intent?.kind === 'interaction-unmatched' && (
          <div className="crm-preview">
            <h3>Не нахожу контакт «{intent.rawName}» — открыть форму?</h3>
            <button className="btn primary" onClick={openForm}>Открыть форму</button>
          </div>
        )}

        {!preview && !intent && results.length > 0 && (
          <div className="crm-palette-list" role="listbox">
            {results.map((r, i) => (
              <button key={`${r.kind}-${r.label}-${i}`} className={`crm-palette-item${i === sel ? ' sel' : ''}`} onClick={() => go(r)} role="option" aria-selected={i === sel}>
                <span>{r.label}</span>
                <span className="crm-palette-kind">{r.kind}</span>
              </button>
            ))}
          </div>
        )}

        {!preview && !intent && results.length === 0 && (
          <div className="crm-palette-hint">
            {HINTS.map((h) => (
              <span key={h} onClick={() => setQuery(h.replace('…', ' '))} style={{ cursor: 'pointer' }}>{h}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
