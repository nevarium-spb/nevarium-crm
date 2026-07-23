import { useEffect, useRef, useState } from 'react'
import { repo } from './api.js'
import { Modal, toast, apiErrorToast, emitRefresh } from './ui.jsx'
import { STAGES } from '../shared/stages.js'

export { STAGES }
export const INTERACTION_TYPES = ['звонок', 'встреча', 'письмо', 'сообщение', 'другое']

const TITLES = {
  contacts: ['Новый контакт', 'Контакт'],
  deals: ['Новая сделка', 'Сделка'],
  tasks: ['Новая задача', 'Задача'],
  interactions: ['Новое действие', 'Действие'],
}

// Универсальная форма сущности. Правила из спеки: блокировка двойного сабмита,
// предупреждение о несохранённом, 409 → предложение обновить.
export function EntityModal({ entity, initial = {}, onSaved, onClose }) {
  const isEdit = Boolean(initial.id)
  const [values, setValues] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [contacts, setContacts] = useState(null)
  const dirty = useRef(false)

  const needContacts = entity !== 'contacts'
  useEffect(() => {
    if (needContacts) repo.list('contacts').then((r) => setContacts(r.items)).catch(() => setContacts([]))
  }, [needContacts])

  const set = (field) => (e) => {
    dirty.current = true
    setValues((v) => ({ ...v, [field]: e.target.value }))
  }

  const close = () => {
    if (dirty.current && !window.confirm('Есть несохранённые изменения. Закрыть?')) return
    onClose()
  }

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const data = { ...values }
      if (entity === 'deals' && data.amount === '') data.amount = null
      if (entity === 'deals' && data.amount != null) data.amount = Number(data.amount)
      if (data.contact_id) data.contact_id = Number(data.contact_id)
      let res
      if (isEdit) {
        res = await repo.update(entity, initial.id, { ...data, expectedUpdatedAt: initial.updated_at })
      } else {
        res = await repo.create(entity, data)
        if (res.duplicateOf) toast(`Похоже на дубль: ${res.duplicateOf.name} (#${res.duplicateOf.id})`, 'error')
      }
      toast('Сохранено')
      dirty.current = false
      onSaved(res.item)
      emitRefresh()
      onClose()
    } catch (err) {
      if (err.kind === 'conflict') setError('Запись изменена в другом окне. Закройте и откройте её заново.')
      else if (err.data?.error === 'field_required') setError('Заполните обязательные поля.')
      else {
        apiErrorToast(err)
        setError('Не удалось сохранить.')
      }
    } finally {
      setBusy(false)
    }
  }

  const contactRequired = needContacts && entity !== 'tasks'
  const contactSelect = needContacts && (
    <label>
      Контакт{contactRequired ? ' *' : ''}
      <select value={values.contact_id ?? ''} onChange={set('contact_id')} required={contactRequired}>
        <option value="">— не выбран —</option>
        {(contacts ?? []).map((c) => (
          <option key={c.id} value={c.id}>{c.name}{c.company ? ` · ${c.company}` : ''}</option>
        ))}
      </select>
    </label>
  )

  return (
    <Modal title={TITLES[entity][isEdit ? 1 : 0]} onClose={close}>
      <form className="crm-form" onSubmit={submit}>
        {entity === 'contacts' && (
          <>
            <label>Имя *<input value={values.name ?? ''} onChange={set('name')} required maxLength={200} autoFocus /></label>
            <label>Компания<input value={values.company ?? ''} onChange={set('company')} maxLength={200} /></label>
            <div className="crm-form-row">
              <label>Телефон<input value={values.phone ?? ''} onChange={set('phone')} maxLength={30} /></label>
              <label>Email<input type="email" value={values.email ?? ''} onChange={set('email')} maxLength={200} /></label>
            </div>
            <label>Мессенджер (Telegram/WhatsApp)<input value={values.messenger ?? ''} onChange={set('messenger')} maxLength={100} /></label>
            <label>Заметка<textarea value={values.note ?? ''} onChange={set('note')} maxLength={2000} /></label>
          </>
        )}
        {entity === 'deals' && (
          <>
            <label>Название *<input value={values.title ?? ''} onChange={set('title')} required maxLength={300} autoFocus /></label>
            {contactSelect}
            <div className="crm-form-row">
              <label>Этап
                <select value={values.stage ?? 'Новый'} onChange={set('stage')}>
                  {STAGES.map((s) => <option key={s}>{s}</option>)}
                </select>
              </label>
              <label>Сумма, ₽<input type="number" min="0" value={values.amount ?? ''} onChange={set('amount')} /></label>
            </div>
            <label>Заметка<textarea value={values.note ?? ''} onChange={set('note')} maxLength={2000} /></label>
          </>
        )}
        {entity === 'tasks' && (
          <>
            <label>Задача *<input value={values.title ?? ''} onChange={set('title')} required maxLength={300} autoFocus /></label>
            {contactSelect}
            <label>Срок<input type="date" value={values.due_date ?? ''} onChange={set('due_date')} /></label>
          </>
        )}
        {entity === 'interactions' && (
          <>
            {contactSelect}
            <div className="crm-form-row">
              <label>Тип
                <select value={values.type ?? 'звонок'} onChange={set('type')}>
                  {INTERACTION_TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </label>
              <label>Когда<input type="datetime-local" value={values.happened_at?.slice(0, 16) ?? ''} onChange={set('happened_at')} /></label>
            </div>
            <label>Заметка<textarea value={values.note ?? ''} onChange={set('note')} maxLength={2000} autoFocus /></label>
          </>
        )}
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="crm-form-actions">
          <button type="button" className="btn" onClick={close}>Отмена</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
        </div>
      </form>
    </Modal>
  )
}
