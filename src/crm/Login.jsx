import { useState } from 'react'
import { api } from './api.js'
import './crm.css'

export default function Login({ onLogin }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const user = await api('/auth/login', { method: 'POST', body: { email, password } })
      onLogin(user)
    } catch (err) {
      if (err.kind === 'throttled') setError(`Слишком много попыток. Попробуйте через ${err.data?.retryAfter ?? 30} с.`)
      else if (err.kind === 'network') setError('Нет связи с сервером.')
      else setError('Неверный email или пароль.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="crm-login">
      <form className="crm-login-card" onSubmit={submit}>
        <div className="crm-login-mark" aria-hidden="true">N</div>
        <h1>Невариум CRM</h1>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus />
        </label>
        <label>
          Пароль
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {error && <p className="crm-login-error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Входим…' : 'Войти'}</button>
      </form>
    </div>
  )
}
