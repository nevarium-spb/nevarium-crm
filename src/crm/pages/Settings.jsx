import { useCallback, useEffect, useRef, useState } from 'react'
import { api, repo } from '../api.js'
import { Modal, apiErrorToast, toast } from '../ui.jsx'

export default function Settings({ user }) {
  const isAdmin = user.role === 'admin'
  const [users, setUsers] = useState([])
  const [diag, setDiag] = useState(null)
  const [userModal, setUserModal] = useState(null) // {} для нового, user для сброса пароля
  const fileRef = useRef(null)

  const load = useCallback(() => {
    api('/crm/users').then((r) => setUsers(r.items)).catch(apiErrorToast)
    repo.diagnostics().then(setDiag).catch(() => setDiag(null))
  }, [])
  useEffect(load, [load])

  const exportJson = async () => {
    try {
      const data = await api('/crm/export')
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `nevarium-crm-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(a.href)
      toast('Экспорт готов')
    } catch (err) { apiErrorToast(err) }
  }

  const importJson = async (file) => {
    if (!file) return
    if (!window.confirm('Импорт ЗАМЕНИТ все текущие данные CRM (контакты, сделки, задачи, историю). Продолжить?')) return
    if (!window.confirm('Точно? Отменить будет нельзя. Рекомендуем сначала сделать экспорт.')) return
    try {
      const text = await file.text()
      const res = await api('/crm/import', { method: 'POST', body: JSON.parse(text) })
      toast(`Импортировано: ${Object.entries(res.counts).map(([k, v]) => `${k}: ${v}`).join(', ')}`)
      load()
    } catch (err) {
      if (err instanceof SyntaxError) toast('Файл повреждён — ничего не импортировано', 'error')
      else if (err.data?.error === 'newer_version') toast('Файл из более новой версии — обновите приложение', 'error')
      else if (err.data?.error === 'bad_file') toast('Файл повреждён — ничего не импортировано', 'error')
      else apiErrorToast(err)
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const demoSeed = async () => {
    try {
      await api('/crm/demo-seed', { method: 'POST' })
      toast('Демо-данные добавлены')
      load()
    } catch (err) { apiErrorToast(err) }
  }

  const demoClear = async () => {
    try {
      await api('/crm/demo', { method: 'DELETE' })
      toast('Демо-данные удалены')
      load()
    } catch (err) { apiErrorToast(err) }
  }

  const removeUser = async (u) => {
    if (!window.confirm(`Удалить пользователя ${u.name}? Его сессии закроются, записи сохранят авторство.`)) return
    try {
      await api(`/crm/users/${u.id}`, { method: 'DELETE' })
      toast('Пользователь удалён')
      load()
    } catch (err) { apiErrorToast(err) }
  }

  return (
    <>
      <h1 className="crm-h1">Настройки</h1>
      <div className="crm-sub">Вы вошли как {user.name} ({user.role === 'admin' ? 'администратор' : 'участник'})</div>
      <div className="settings-grid">
        <section className="tile" aria-label="Команда">
          <div className="tile-title"><span className="tile-num">01</span><h2>Команда</h2></div>
          {users.map((u) => (
            <div className="row-line" key={u.id}>
              <div>
                <div className="row-name">{u.name}</div>
                <div className="row-meta">{u.email} · {u.role === 'admin' ? 'администратор' : 'участник'}</div>
              </div>
              {isAdmin && (
                <span style={{ display: 'flex', gap: 6 }}>
                  <button className="btn" style={{ minHeight: 32, fontSize: 12 }} onClick={() => setUserModal(u)}>Сбросить пароль</button>
                  {u.id !== user.id && <button className="btn danger" style={{ minHeight: 32, fontSize: 12 }} onClick={() => removeUser(u)}>✕</button>}
                </span>
              )}
            </div>
          ))}
          {isAdmin && <button className="btn" style={{ marginTop: 10 }} onClick={() => setUserModal({})}>+ Пользователь</button>}
        </section>

        <section className="tile" aria-label="Данные">
          <div className="tile-title"><span className="tile-num">02</span><h2>Данные</h2></div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {isAdmin ? (
              <>
                <button className="btn" onClick={exportJson}>Экспорт JSON</button>
                <a className="btn" href="/api/crm/contacts.csv" download>Контакты CSV</a>
                <button className="btn danger" onClick={() => fileRef.current?.click()}>Импорт JSON</button>
                <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => importJson(e.target.files?.[0])} />
              </>
            ) : (
              <span className="crm-cap">Экспорт и импорт данных доступны администратору.</span>
            )}
          </div>
          <div className="crm-cap">Ночной бэкап создаётся на сервере автоматически и отправляется копией в MAX. В Telegram он не уходит: в базе персональные данные клиентов, а Telegram зарубежный.</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button className="btn" onClick={demoSeed}>Добавить демо-данные</button>
            <button className="btn" onClick={demoClear}>Очистить демо</button>
          </div>
        </section>

        <section className="tile" aria-label="Диагностика">
          <div className="tile-title"><span className="tile-num">03</span><h2>Диагностика</h2></div>
          {!diag && <div className="empty">Недоступна</div>}
          {diag && (
            <div className="diag">
              <span>Схема БД: <b>v{diag.schemaVersion}</b> · Сервер (МСК): <b>{diag.serverTimeMsk}</b></span>
              <span>Контакты: <b>{diag.counts.contacts}</b> · Сделки: <b>{diag.counts.deals}</b> · Задачи: <b>{diag.counts.tasks}</b> · Действия: <b>{diag.counts.interactions}</b></span>
              <span>Уведомления в очереди: Telegram <b>{diag.outboxPending.tg}</b> · MAX <b>{diag.outboxPending.max}</b></span>
            </div>
          )}
          <div className="crm-cap">Рекомендуемый браузер — Chromium (Chrome, Edge, Яндекс). Данные хранятся на сервере.</div>
        </section>
      </div>
      {userModal && <UserModal existing={userModal.id ? userModal : null} onDone={load} onClose={() => setUserModal(null)} />}
    </>
  )
}

function UserModal({ existing, onDone, onClose }) {
  const [name, setName] = useState(existing?.name ?? '')
  const [email, setEmail] = useState(existing?.email ?? '')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('member')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (existing) await api(`/crm/users/${existing.id}`, { method: 'PATCH', body: { password } })
      else await api('/crm/users', { method: 'POST', body: { name, email, password, role } })
      toast(existing ? 'Пароль обновлён — его сессии сброшены' : 'Пользователь создан')
      onDone()
      onClose()
    } catch (err) {
      if (err.data?.error === 'email_taken') setError('Такой email уже есть.')
      else if (err.data?.error === 'bad_input') setError('Проверьте поля: пароль минимум 8 символов.')
      else { apiErrorToast(err); setError('Не удалось сохранить.') }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={existing ? `Сброс пароля: ${existing.name}` : 'Новый пользователь'} onClose={onClose}>
      <form className="crm-form" onSubmit={submit}>
        {!existing && (
          <>
            <label>Имя *<input value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></label>
            <label>Email *<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
            <label>Роль
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="member">Участник</option>
                <option value="admin">Администратор</option>
              </select>
            </label>
          </>
        )}
        <label>{existing ? 'Новый пароль *' : 'Пароль *'}<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required autoFocus={Boolean(existing)} /></label>
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="crm-form-actions">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
        </div>
      </form>
    </Modal>
  )
}
