import { useCallback, useEffect, useState } from 'react'
import { api } from './api.js'
import { Modal, apiErrorToast, onRefresh, relTime, toast } from './ui.jsx'
import { formatBytes } from './pages/AccountSettings.jsx'

// Загрузки клиента по личной ссылке (фото и видео этапа) и отчёты в кабинете (ADR-025, задание сайта 2026-10-20).
// Файлы — данные клиента: в них бывают координаты съёмки, поэтому скачивает только вошедший сотрудник, каждое открытие пишется в журнал.

const ruDate = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '')

// Что сказал сервер про письмо клиенту при открытии приёма.
const MAIL_NOTE = {
  queued: 'Письмо клиенту поставлено в очередь — уйдёт в течение минуты.',
  disabled: 'Письма клиентам выключены в «Настройках» — отправьте сообщение ниже сами.',
  no_address: 'У клиента нет почты — отправьте сообщение ниже сами.',
  opted_out: 'Клиент просил не писать ему на почту — отправьте сообщение ниже сами.',
  no_consent: 'Нет согласия клиента на обработку данных — письмо не отправлено, отправьте сообщение ниже сами.',
}

function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text)
  } catch { /* ниже запасной путь */ }
  const area = document.createElement('textarea')
  area.value = text
  document.body.appendChild(area)
  area.select()
  document.execCommand('copy')
  area.remove()
  return Promise.resolve()
}

function OpenUploadModal({ contactId, onClose, onDone }) {
  const [stages, setStages] = useState([])
  const [stageCode, setStageCode] = useState('')
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState('primary')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  // Этапы — из действующих пакетов клиента; можно и вписать свой.
  useEffect(() => {
    api(`/crm/contacts/${contactId}/entitlements`).then((s) => {
      const seen = new Map()
      for (const e of s.entitlements || []) {
        if (e.status !== 'active') continue
        for (const st of e.stages || []) if (!seen.has(st.code)) seen.set(st.code, st.title)
      }
      const list = [...seen].map(([code, name]) => ({ code, title: name }))
      setStages(list)
      if (list.length) setStageCode(list[0].code)
    }).catch(() => setStages([]))
  }, [contactId])

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      const body = { kind }
      if (stageCode) body.stage_code = stageCode
      else body.stage_title = title.trim()
      setResult(await api(`/crm/contacts/${contactId}/uploads`, { method: 'POST', body }))
      onDone()
    } catch (err) {
      const code = err?.data?.error
      if (code === 'already_open') toast('Приём по этому этапу уже открыт — закройте его («Принято») или дождитесь срока', 'error')
      else if (code === 'bad_stage') toast('Выберите этап или впишите название', 'error')
      else if (code === 'anonymized') toast('Контакт обезличен — приём открыть нельзя', 'error')
      else apiErrorToast(err)
    } finally { setBusy(false) }
  }

  if (result) {
    return (
      <Modal title="Приём фото открыт" onClose={onClose}>
        <p className="crm-cap">Срок — до {ruDate(result.expiresOn)}. {MAIL_NOTE[result.mail] || ''}</p>
        <div className="crm-form">
          <label>
            Готовое сообщение клиенту (со ссылкой)
            <textarea rows={5} readOnly value={result.message} onFocus={(e) => e.target.select()} />
          </label>
          <span className="crm-cap">Ссылка личная: она открывает кабинет клиента и показывается один раз — не пересылайте её никому, кроме клиента.</span>
          <div className="crm-form-actions">
            <button type="button" className="btn" onClick={() => copyText(result.message).then(() => toast('Скопировано'))}>Скопировать</button>
            <button type="button" className="btn primary" onClick={onClose}>Готово</button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Открыть приём фото и видео этапа" onClose={onClose}>
      <form className="crm-form" onSubmit={submit}>
        <label>
          Этап
          <select value={stageCode} onChange={(e) => setStageCode(e.target.value)}>
            {stages.map((s) => <option key={s.code} value={s.code}>{s.title}</option>)}
            <option value="">Другой этап (впишу сам)…</option>
          </select>
        </label>
        {!stageCode && (
          <label>
            Название этапа
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} required autoFocus />
          </label>
        )}
        <label>
          Вид проверки
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="primary">Первичная — до 30 фото и 2 видео</option>
            <option value="recheck">Повторная — до 10 фото, без видео</option>
          </select>
        </label>
        <span className="crm-cap">Приём открыт 7 дней. Клиент загружает файлы с телефона по своей личной ссылке в кабинете.</span>
        <div className="crm-form-actions">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Открываем…' : 'Открыть приём'}</button>
        </div>
      </form>
    </Modal>
  )
}

export function UploadsBlock({ contactId, anonymized }) {
  const [uploads, setUploads] = useState(null)
  const [reports, setReports] = useState([])
  const [opening, setOpening] = useState(false)

  const load = useCallback(() => {
    api(`/crm/contacts/${contactId}/uploads`).then((r) => setUploads(r.items)).catch(() => setUploads([]))
    api(`/crm/contacts/${contactId}/reports`).then((r) => setReports(r.items)).catch(() => setReports([]))
  }, [contactId])
  useEffect(load, [load])
  useEffect(() => onRefresh(load), [load])

  const close = async (u) => {
    if (!window.confirm(`Отметить «Принято» по этапу «${u.stage}»? Клиент больше не сможет загружать файлы по этому приёму.`)) return
    try {
      await api(`/crm/uploads/${u.id}/close`, { method: 'POST' })
      toast('Приём закрыт')
      load()
    } catch (err) { apiErrorToast(err) }
  }

  const items = uploads || []
  if (anonymized && !items.length && !reports.length) return null

  return (
    <>
      <section className="tile" aria-label="Загрузки клиента">
        <div className="tile-title">
          <span className="tile-num">▣</span><h2>Загрузки клиента</h2>
          {!anonymized && <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setOpening(true)}>Открыть приём фото</button>}
        </div>
        {uploads && items.length === 0 && <div className="empty">Приёмов не было. Откройте приём, чтобы клиент мог прислать фото и видео этапа.</div>}
        {items.map((u) => (
          <div className="row-line" key={u.id} style={!u.open ? { opacity: 0.6 } : undefined}>
            <div style={{ minWidth: 0 }}>
              <div className="row-name">
                {u.stage}{u.kind === 'recheck' ? ' · повторная' : ''}
                <span className="row-meta"> · {u.closedAt ? 'принято' : u.open ? `открыт до ${ruDate(u.expiresOn)}` : 'срок вышел'}</span>
              </div>
              <div className="row-meta">Фото: {u.photos.used} из {u.photos.limit}{u.videos.limit > 0 ? ` · видео: ${u.videos.used} из ${u.videos.limit}` : ''}</div>
              {u.files.map((f) => (
                <div className="row-meta" key={f.id}>
                  {f.kind === 'video' ? '🎬' : '📷'} {f.original_name || `${f.kind === 'video' ? 'Видео' : 'Фото'} ${f.idx + 1}`} · {formatBytes(f.size)} · {relTime(f.created_at)}{' '}
                  <a href={`/api/crm/upload-files/${f.id}`} download>Скачать</a>
                </div>
              ))}
            </div>
            {u.open && <button className="btn" style={{ minHeight: 30, fontSize: 12 }} onClick={() => close(u)}>Принято</button>}
          </div>
        ))}
        {items.some((u) => u.files.length > 0) && (
          <div className="crm-cap">Исходные файлы без сжатия, в них могут быть координаты съёмки — это данные клиента, не пересылайте их в мессенджеры.</div>
        )}
      </section>

      {reports.length > 0 && (
        <section className="tile" aria-label="Отчёты в кабинете">
          <div className="tile-title"><span className="tile-num">PDF</span><h2>Отчёты в кабинете</h2></div>
          {reports.map((r) => (
            <div className="row-line" key={r.id}>
              <div>
                <div className="row-name">{r.number}{r.stage ? ` · ${r.stage}` : ''}</div>
                <div className="row-meta">версия {r.version} · {formatBytes(r.size)} · {relTime(r.publishedAt)}</div>
              </div>
              <a className="btn" href={`/api/crm/reports/${r.id}`} download>Скачать</a>
            </div>
          ))}
          <div className="crm-cap">Клиент видит эти отчёты в личном кабинете по своей ссылке.</div>
        </section>
      )}

      {opening && <OpenUploadModal contactId={contactId} onClose={() => setOpening(false)} onDone={load} />}
    </>
  )
}
