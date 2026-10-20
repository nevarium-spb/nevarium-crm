import { useEffect, useState } from 'react'
import { api, repo } from './api.js'
import { Modal, apiErrorToast, toast } from './ui.jsx'

// Слияние дублей контактов (только администратор). Сервер сам проверяет всё, что здесь показано: проект, обезличенность,
// телефоны. Окно лишь помогает выбрать вторую карточку и честно предупреждает, что отменить слияние нельзя.
const REFUSALS = {
  different_project: 'Карточки из разных проектов — объединять нельзя.',
  anonymized: 'Одна из карточек обезличена — объединять нельзя.',
  phones_differ: 'У карточек разные телефоны. Уберите лишний телефон в присоединяемой карточке («Изменить») и повторите.',
  not_found: 'Карточка не найдена — обновите страницу.',
  admin_only: 'Объединять может только администратор.',
}

const line = (c) => [c.phone, c.email, c.messenger].filter(Boolean).join(' · ') || 'нет данных'

export function MergeModal({ contact, onClose, onDone }) {
  const [candidates, setCandidates] = useState(null)
  const [q, setQ] = useState('')
  const [found, setFound] = useState([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api(`/crm/contacts/${contact.id}/duplicates`).then((r) => setCandidates(r.items)).catch(() => setCandidates([]))
  }, [contact.id])

  // Поиск вручную — на случай дубля, который CRM сама не нашла (разные телефоны, опечатка в почте).
  useEffect(() => {
    const text = q.trim()
    if (text.length < 2) { setFound([]); return undefined }
    let alive = true
    const t = setTimeout(() => {
      repo.list('contacts', { q: text }).then((r) => {
        if (!alive) return
        setFound(r.items.filter((c) => c.id !== contact.id && !c.anonymized_at && c.project_id === contact.project_id).slice(0, 10))
      }).catch(() => {})
    }, 250)
    return () => { alive = false; clearTimeout(t) }
  }, [q, contact.id, contact.project_id])

  const merge = async (c) => {
    if (!window.confirm(
      `Присоединить карточку «${c.name}» к «${contact.name}»?\n\n`
      + `Сделки, задачи, история, согласия, запросы ПДн, тарифы и фото карточки «${c.name}» перейдут в «${contact.name}». `
      + 'Недостающие телефон, почта и ник дополнятся, отличающиеся значения попадут в заметку.\n'
      + `Карточка «${c.name}» исчезнет.\n\nОтменить это будет НЕЛЬЗЯ.`
    )) return
    setBusy(true)
    try {
      await api(`/crm/contacts/${contact.id}/merge`, { method: 'POST', body: { from_id: c.id } })
      toast('Карточки объединены')
      onDone()
    } catch (err) {
      const code = err?.data?.error
      if (REFUSALS[code]) toast(REFUSALS[code], 'error')
      else apiErrorToast(err)
    } finally { setBusy(false) }
  }

  const row = (c, why) => (
    <div className="row-line" key={c.id}>
      <div>
        <div className="row-name">{c.name}</div>
        <div className="row-meta">{line(c)}{c.deals != null ? ` · сделок: ${c.deals}` : ''}{why ? ` · совпало: ${why}` : ''}{c.archived ? ' · в архиве' : ''}</div>
      </div>
      <button className="btn danger" disabled={busy} onClick={() => merge(c)}>Присоединить</button>
    </div>
  )

  return (
    <Modal title={`Объединить с «${contact.name}»`} onClose={onClose}>
      <p className="crm-cap">Эта карточка остаётся, выбранная — присоединяется к ней и исчезает. Отменить слияние нельзя.</p>
      <h3 style={{ fontSize: 14, margin: '12px 0 4px' }}>Возможные дубли</h3>
      {candidates === null && <div className="skeleton" />}
      {candidates?.length === 0 && <div className="empty">CRM не нашла карточек с тем же телефоном, почтой или ником.</div>}
      {candidates?.map((c) => row(c, c.reasons.join(', ')))}
      <h3 style={{ fontSize: 14, margin: '16px 0 4px' }}>Найти вручную</h3>
      {/* .crm-form задаёт вид полей CRM (тёмный фон, светлый текст); вне него поле выходило белым с белым текстом */}
      <div className="crm-form">
        <input placeholder="Имя, телефон или почта (от 2 символов)" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {found.map((c) => row(c))}
      {q.trim().length >= 2 && found.length === 0 && <div className="crm-cap">Ничего не найдено в этом проекте.</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn" onClick={onClose}>Закрыть</button>
      </div>
    </Modal>
  )
}
