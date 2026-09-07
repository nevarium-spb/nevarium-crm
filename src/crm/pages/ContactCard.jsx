import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, repo } from '../api.js'
import { EntityModal } from '../forms.jsx'
import { apiErrorToast, fmtMoney, onRefresh, relTime, toast } from '../ui.jsx'

export default function ContactCard({ user }) {
  const { id } = useParams()
  const navigate = useNavigate()
  const [card, setCard] = useState(null)
  const [missing, setMissing] = useState(false)
  const [modal, setModal] = useState(null) // {entity, initial}
  const [tab, setTab] = useState('all')

  const load = useCallback(() => {
    repo.contactCard(id).then(setCard).catch((err) => {
      if (err.status === 404) setMissing(true)
      else apiErrorToast(err)
    })
  }, [id])
  useEffect(load, [load])
  useEffect(() => onRefresh(load), [load])

  if (missing)
    return <div className="empty">Контакт не найден. <Link to="/crm/contacts" className="btn">К списку</Link></div>
  if (!card)
    return <><div className="skeleton" style={{ width: 220, height: 24 }} /><div className="tile"><div className="skeleton" /><div className="skeleton" /></div></>

  const { contact, deals, tasks, interactions } = card

  const archive = async () => {
    try {
      await repo.update('contacts', contact.id, { archived: contact.archived ? 0 : 1 })
      toast(contact.archived ? 'Возвращён из архива' : 'Контакт в архиве')
      load()
    } catch (err) { apiErrorToast(err) }
  }

  const removeDeal = async (deal) => {
    if (!window.confirm(`Удалить сделку «${deal.title}»? Действия по контакту сохранятся.`)) return
    try {
      await repo.remove('deals', deal.id)
      toast('Сделка удалена')
      load()
    } catch (err) { apiErrorToast(err) }
  }

  const remove = async () => {
    if (!window.confirm(`Удалить контакт «${contact.name}» вместе с задачами и историей?`)) return
    try {
      await repo.remove('contacts', contact.id)
      toast('Контакт удалён')
      navigate('/crm/contacts')
    } catch (err) {
      if (err.kind === 'conflict' || err.data?.error === 'has_deals') toast('У контакта есть сделки — используйте архив', 'error')
      else apiErrorToast(err)
    }
  }

  // Обезличивание по требованию клиента (152-ФЗ). Необратимо, поэтому подтверждение
  // прямо перечисляет, что исчезнет, а что останется — владелец не программист.
  const anonymize = async () => {
    if (!window.confirm(
      `Обезличить контакт «${contact.name}»?\n\n`
      + 'Будут стёрты: имя, компания, телефон, почта, мессенджер, заметки, тексты действий и переписка с чатом.\n'
      + 'Останутся: сделки со стадиями и суммами (для статистики), даты действий.\n'
      + 'Задачи по этому контакту будут удалены, напоминания воронки возврата отменены.\n\n'
      + 'Отменить это будет НЕЛЬЗЯ.'
    )) return
    try {
      await api(`/crm/contacts/${contact.id}/anonymize`, { method: 'POST' })
      toast('Контакт обезличен')
      load()
    } catch (err) {
      if (err.data?.error === 'admin_only') toast('Обезличивать может только администратор', 'error')
      else apiErrorToast(err)
    }
  }

  const timeline = [
    ...interactions.map((i) => ({ kind: 'interaction', at: i.happened_at, item: i })),
    ...tasks.map((t) => ({ kind: 'task', at: t.due_date || t.created_at, item: t })),
  ].sort((a, b) => (b.at || '').localeCompare(a.at || ''))
  const shown = timeline.filter((e) => tab === 'all' || (tab === 'calls' && e.kind === 'interaction') || (tab === 'tasks' && e.kind === 'task'))

  return (
    <>
      <div className="crm-head">
        <div>
          <h1 className="crm-h1">{contact.name}</h1>
          <div className="crm-sub">
            {[contact.company, contact.phone, contact.email, contact.messenger].filter(Boolean).join(' · ') || 'нет данных'}
            {contact.suspicious ? ' · ⚠ подозрительный' : ''}{contact.archived ? ' · в архиве' : ''}
            {contact.anonymized_at ? ' · 🔒 обезличен по запросу клиента' : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => setModal({ entity: 'contacts', initial: contact })}>Изменить</button>
          <button className="btn" onClick={() => setModal({ entity: 'interactions', initial: { contact_id: contact.id } })}>+ Действие</button>
          <button className="btn" onClick={() => setModal({ entity: 'tasks', initial: { contact_id: contact.id } })}>+ Задача</button>
          <button className="btn" onClick={() => setModal({ entity: 'deals', initial: { contact_id: contact.id } })}>+ Сделка</button>
          <button className="btn" onClick={archive}>{contact.archived ? 'Из архива' : 'В архив'}</button>
          {user?.role === 'admin' && !contact.anonymized_at && (
            <button className="btn danger" onClick={anonymize} title="Исполнить требование клиента об удалении данных (152-ФЗ)">
              Обезличить
            </button>
          )}
          {deals.length === 0 && <button className="btn danger" onClick={remove}>Удалить</button>}
        </div>
      </div>

      <div className="crm-grid">
        <section className="tile" aria-label="Сделки контакта">
          <div className="tile-title"><span className="tile-num">01</span><h2>Сделки</h2></div>
          {deals.length === 0 && <div className="empty">Сделок нет.</div>}
          {deals.map((d) => (
            <div className="row-line" key={d.id}>
              <div>
                <div className="row-name">{d.title}</div>
                <div className="row-meta">{d.stage}{d.note ? ` · ${d.note.slice(0, 80)}` : ''}</div>
              </div>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="deal-amount">{fmtMoney(d.amount)}</span>
                <button
                  className="btn danger"
                  style={{ minHeight: 28, padding: '2px 10px', fontSize: 12 }}
                  title="Удалить сделку"
                  onClick={() => removeDeal(d)}
                >✕</button>
              </span>
            </div>
          ))}
        </section>

        <section className="tile" aria-label="Заметка">
          <div className="tile-title"><span className="tile-num">02</span><h2>Заметка</h2></div>
          <p style={{ color: 'var(--text-2)', fontSize: 14 }}>{contact.note || '—'}</p>
          <div className="crm-cap">Источник: {contact.source} · создан {relTime(contact.created_at)}</div>
        </section>

        <section className="tile span2" aria-label="История">
          <div className="tile-title">
            <span className="tile-num">03</span><h2>История</h2>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              {[['all', 'Всё'], ['calls', 'Действия'], ['tasks', 'Задачи']].map(([key, label]) => (
                <button key={key} className={`btn${tab === key ? ' primary' : ''}`} style={{ minHeight: 32, padding: '4px 12px', fontSize: 12.5 }} onClick={() => setTab(key)}>{label}</button>
              ))}
            </div>
          </div>
          {shown.length === 0 && <div className="empty">Пока пусто — залогируйте звонок или создайте задачу.</div>}
          {shown.map((e) => (
            <div className="act-line" key={`${e.kind}-${e.item.id}`}>
              <span className="act-dot" style={e.kind === 'task' ? { background: 'var(--accent-3)', boxShadow: '0 0 8px var(--accent-3)' } : undefined} />
              {/* pre-wrap обязателен: транскрипты чата и записи о повторных заявках
                  многострочные, без него весь диалог схлопывается в одну строку.
                  break-word — на случай длинных ссылок в переписке. */}
              <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {e.kind === 'interaction'
                  ? `${e.item.type[0].toUpperCase()}${e.item.type.slice(1)}${e.item.note ? ` — ${e.item.note}` : ''}`
                  : `Задача: ${e.item.title}${e.item.done ? ' ✓' : ''}`}
                <span className="act-time">{relTime(e.at)}</span>
              </div>
            </div>
          ))}
        </section>
      </div>
      {modal && <EntityModal entity={modal.entity} initial={modal.initial} onSaved={load} onClose={() => setModal(null)} />}
    </>
  )
}
