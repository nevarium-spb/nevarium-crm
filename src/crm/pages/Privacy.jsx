import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, repo } from '../api.js'
import { Modal, apiErrorToast, fmtDate, onRefresh, relTime, toast } from '../ui.jsx'

// Раздел исполняет обещание политики ПДн: запрос субъекта → срок 10 рабочих дней →
// обезличивание. Срок жёсткий и юридический, поэтому просроченные показываем первыми
// и красным: пропущенный срок — это повод для жалобы в Роскомнадзор.
export default function Privacy({ user }) {
  const isAdmin = user.role === 'admin'
  const [data, setData] = useState(null)
  const [kinds, setKinds] = useState({})
  const [today, setToday] = useState('')
  const [contacts, setContacts] = useState([])
  const [modal, setModal] = useState(null)
  const [audit, setAudit] = useState(null)
  const [showAudit, setShowAudit] = useState(false)

  const load = useCallback(() => {
    api('/crm/pd-requests')
      .then((r) => {
        setData(r.items)
        setKinds(r.kinds)
        setToday(r.today)
      })
      .catch(apiErrorToast)
    repo.list('contacts').then((r) => setContacts(r.items)).catch(() => setContacts([]))
  }, [])
  useEffect(load, [load])
  useEffect(() => onRefresh(load), [load])

  const loadAudit = () => {
    setShowAudit((v) => !v)
    if (!audit) api('/crm/audit').then((r) => setAudit(r.items)).catch(apiErrorToast)
  }

  const OPEN_STATUSES = ['new', 'pending_unverified']
  const open = useMemo(
    () => (data ?? []).filter((r) => OPEN_STATUSES.includes(r.status)).sort((a, b) => a.due_date.localeCompare(b.due_date)),
    [data]
  )
  const closed = useMemo(() => (data ?? []).filter((r) => !OPEN_STATUSES.includes(r.status)), [data])
  const overdue = open.filter((r) => today && r.due_date < today).length

  const resolve = async (row, { anonymize }) => {
    const what = anonymize
      ? `Обезличить контакт «${row.contact_name}»?\n\nБудут стёрты имя, телефон, почта, заметки и переписка. Сделка и её стадия останутся для статистики. Отменить это будет нельзя.`
      : 'Отметить запрос исполненным без обезличивания?'
    if (!window.confirm(what)) return
    try {
      const res = await api(`/crm/pd-requests/${row.id}`, { method: 'PATCH', body: { status: 'done', anonymize } })
      toast(res.anonymized ? 'Контакт обезличен, запрос закрыт' : 'Запрос закрыт')
      load()
    } catch (err) {
      if (err.data?.error === 'no_contact') toast('Сначала укажите, кто из контактов это', 'error')
      else if (err.data?.error === 'kind_not_erasable') toast('Для такого вида запроса обезличивание не нужно', 'error')
      else if (err.data?.error === 'not_verified') toast('Сначала подтвердите личность отправителя', 'error')
      else apiErrorToast(err)
    }
  }

  // Запрос с сайта не подтверждает, что его отправил сам владелец данных — веб-форма
  // доступна кому угодно, знающему чужой email/телефон. Подтверждение — по каналу,
  // УЖЕ СОХРАНЁННОМУ в карточке контакта в CRM, а не по тому, что указано в форме
  // (иначе подтверждение получит тот, кто прислал запрос, будь он вообще посторонним).
  const verify = async (row) => {
    if (!window.confirm('Подтвердите: вы связались с человеком по контакту ИЗ КАРТОЧКИ в CRM (не по тому, что указан в форме) и убедились, что запрос от него?')) return
    try {
      await api(`/crm/pd-requests/${row.id}`, { method: 'PATCH', body: { status: 'new' } })
      toast('Личность подтверждена, запрос можно исполнять')
      load()
    } catch (err) { apiErrorToast(err) }
  }

  const reject = async (row) => {
    const why = window.prompt('Причина отказа (останется в журнале):', '')
    if (why === null) return
    try {
      await api(`/crm/pd-requests/${row.id}`, { method: 'PATCH', body: { status: 'rejected', note: [row.note, `Отказ: ${why}`].filter(Boolean).join('\n') } })
      toast('Запрос отмечен как отклонённый')
      load()
    } catch (err) { apiErrorToast(err) }
  }

  const linkContact = async (row, contactId) => {
    try {
      await api(`/crm/pd-requests/${row.id}`, { method: 'PATCH', body: { contact_id: contactId || null } })
      load()
    } catch (err) { apiErrorToast(err) }
  }

  return (
    <>
      <div className="crm-head">
        <div>
          <h1 className="crm-h1">Права ПДн</h1>
          <div className="crm-sub">
            {data ? `${open.length} в работе${overdue ? ` · ${overdue} просрочено` : ''} · срок по закону 10 рабочих дней` : ' '}
          </div>
        </div>
        <button className="btn primary" onClick={() => setModal({})}>+ Запрос</button>
      </div>

      <div className="tile">
        {!data && <><div className="skeleton" /><div className="skeleton" style={{ width: '65%' }} /></>}
        {data && open.length === 0 && (
          <div className="empty">
            Открытых запросов нет.<br />
            Запросы приходят формой с сайтов или заводятся вручную, если человек написал на почту.
          </div>
        )}
        {open.map((row) => {
          const late = today && row.due_date < today
          return (
            <div className="row-line" key={row.id} style={late ? { borderLeft: '3px solid var(--danger, #e5484d)', paddingLeft: 10 } : undefined}>
              <div style={{ minWidth: 0 }}>
                <div className="row-name">
                  {kinds[row.kind] ?? row.kind}
                  {row.status === 'pending_unverified' && (
                    <span className="row-meta" style={{ color: 'var(--danger, #e5484d)' }}> · личность не подтверждена</span>
                  )}
                  {row.anonymized_at ? <span className="row-meta"> · уже обезличен</span> : null}
                </div>
                <div className="row-meta">
                  {row.requester || '—'}
                  {row.contact_id ? (
                    <> · <Link to={`/crm/contacts/${row.contact_id}`}>{row.contact_name}</Link></>
                  ) : (
                    <> · <b>клиент не сопоставлен</b></>
                  )}
                  {row.project_name ? ` · ${row.project_name}` : ''}
                  {` · принят ${relTime(row.created_at)}`}
                </div>
                {row.note ? <div className="row-meta" style={{ whiteSpace: 'pre-wrap' }}>{row.note}</div> : null}
                {!row.contact_id && (
                  <select
                    style={{ marginTop: 6, maxWidth: 260 }}
                    defaultValue=""
                    onChange={(e) => linkContact(row, e.target.value)}
                  >
                    <option value="">— выбрать контакт —</option>
                    {contacts.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}{c.email ? ` · ${c.email}` : ''}</option>
                    ))}
                  </select>
                )}
              </div>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className={`task-due${late ? ' over' : ''}`}>
                  {late ? `просрочено · ${fmtDate(row.due_date)}` : `до ${fmtDate(row.due_date)}`}
                </span>
                {row.status === 'pending_unverified' ? (
                  row.contact_id ? (
                    <button className="btn" style={{ minHeight: 32, fontSize: 12 }} onClick={() => verify(row)}>
                      Подтвердить личность
                    </button>
                  ) : (
                    <span className="row-meta">сначала сопоставьте контакт</span>
                  )
                ) : (
                  isAdmin && ['delete', 'stop'].includes(row.kind) && row.contact_id && !row.anonymized_at && (
                    <button className="btn danger" style={{ minHeight: 32, fontSize: 12 }} onClick={() => resolve(row, { anonymize: true })}>
                      Обезличить и закрыть
                    </button>
                  )
                )}
                {row.status !== 'pending_unverified' && (
                  <button className="btn" style={{ minHeight: 32, fontSize: 12 }} onClick={() => resolve(row, { anonymize: false })}>
                    Исполнено
                  </button>
                )}
                <button className="btn" style={{ minHeight: 32, fontSize: 12 }} onClick={() => reject(row)}>Отказ</button>
              </span>
            </div>
          )
        })}
      </div>

      {closed.length > 0 && (
        <div className="tile" style={{ marginTop: 14 }}>
          <div className="tile-title"><h2>Закрытые ({closed.length})</h2></div>
          {closed.map((row) => (
            <div className="row-line" key={row.id}>
              <div>
                <div className="row-name">{kinds[row.kind] ?? row.kind}</div>
                <div className="row-meta">
                  {row.requester || '—'} · {row.status === 'done' ? 'исполнен' : 'отказ'} {row.resolved_at ? relTime(row.resolved_at) : ''}
                  {row.anonymized_at ? ' · контакт обезличен' : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {isAdmin && (
        <div className="tile" style={{ marginTop: 14 }}>
          <div className="tile-title"><h2>Журнал действий</h2></div>
          <div className="crm-cap">
            Кто и что менял в CRM. Хранится в базе, а не в логах сервера — логи теряются при обновлении приложения.
          </div>
          <button className="btn" style={{ minHeight: 32, fontSize: 12.5, marginTop: 10 }} onClick={loadAudit}>
            {showAudit ? 'Скрыть журнал' : 'Показать журнал'}
          </button>
          {showAudit && !audit && <div className="skeleton" style={{ marginTop: 10 }} />}
          {showAudit && audit && (
            <div style={{ marginTop: 10, maxHeight: 360, overflowY: 'auto' }}>
              {audit.length === 0 && <div className="empty">Пока пусто.</div>}
              {audit.map((a) => (
                <div className="row-line" key={a.id}>
                  <div>
                    <div className="row-name" style={{ fontSize: 13 }}>
                      {ACTION_LABEL[a.action] ?? a.action} · {a.entity}
                      {a.entity_id ? ` #${a.entity_id}` : ''}
                    </div>
                    <div className="row-meta">
                      {a.user_email || 'система'}
                      {a.detail ? ` · ${a.detail}` : ''}
                    </div>
                  </div>
                  <span className="row-meta">{relTime(a.created_at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {modal && <RequestModal kinds={kinds} contacts={contacts} onSaved={load} onClose={() => setModal(null)} />}
    </>
  )
}

const ACTION_LABEL = {
  create: 'создано',
  update: 'изменено',
  delete: 'удалено',
  anonymize: 'обезличено',
  import: 'импорт данных',
  'demo-clear': 'очистка демо',
}

function RequestModal({ kinds, contacts, onSaved, onClose }) {
  const [kind, setKind] = useState('delete')
  const [requester, setRequester] = useState('')
  const [contactId, setContactId] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const res = await api('/crm/pd-requests', { method: 'POST', body: { kind, requester, contact_id: contactId || null, note } })
      toast(`Запрос зарегистрирован, исполнить до ${fmtDate(res.due_date)}`)
      onSaved()
      onClose()
    } catch (err) {
      if (err.data?.error === 'bad_input') setError('Укажите, от кого запрос: адрес или контакт из базы.')
      else { apiErrorToast(err); setError('Не удалось сохранить.') }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Запрос по персональным данным" onClose={onClose}>
      <form className="crm-form" onSubmit={submit}>
        <label>
          Что просит
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(kinds).map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </select>
        </label>
        <label>
          От кого (почта или телефон из письма)
          <input value={requester} onChange={(e) => setRequester(e.target.value)} placeholder="ivan@example.ru" />
        </label>
        <label>
          Кто это в базе (если нашли)
          <select value={contactId} onChange={(e) => setContactId(e.target.value)}>
            <option value="">— не сопоставлен —</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.email ? ` · ${c.email}` : ''}</option>
            ))}
          </select>
        </label>
        <label>
          Заметка
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Текст обращения, если нужен" />
        </label>
        <div className="crm-cap">Срок исполнения посчитается сам — 10 рабочих дней от сегодня.</div>
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="crm-form-actions">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn primary" disabled={busy}>Зарегистрировать</button>
        </div>
      </form>
    </Modal>
  )
}
