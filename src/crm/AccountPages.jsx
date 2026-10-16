// Публичные страницы учётной записи (ADR-020): восстановление пароля и подтверждение
// нового email по ссылке из письма, форма «Забыли пароль?» на экране входа.
// Ключ из письма лежит во фрагменте адреса (#t=…): он не уходит на сервер при загрузке
// страницы и не попадает в журналы доступа; читаем его один раз и убираем из адресной строки.
import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import './crm.css'

export const PASSWORD_REASONS = {
  too_short: 'Минимум 12 символов.',
  too_long: 'Слишком длинный пароль.',
  repetitive: 'Пароль слишком однообразный.',
  personal: 'Пароль содержит ваш email или имя.',
  common: 'Это слишком распространённый пароль — выберите другой.',
}

function takeTokenFromHash() {
  const m = /[#&]t=([A-Za-z0-9_-]+)/.exec(window.location.hash)
  if (m) window.history.replaceState(null, '', window.location.pathname)
  return m ? m[1] : ''
}

function Shell({ title, children }) {
  return (
    <div className="crm-login">
      <div className="crm-login-card">
        <div className="crm-login-mark" aria-hidden="true">N</div>
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  )
}

const toLogin = () => window.location.assign('/crm')

/** Страница по ссылке «восстановить пароль» (/crm/reset#t=…). */
export function ResetPasswordPage() {
  const token = useRef(takeTokenFromHash())
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  if (!token.current && !done) {
    return (
      <Shell title="Ссылка недействительна">
        <p className="crm-cap">Откройте ссылку из письма целиком или запросите новую на экране входа («Забыли пароль?»).</p>
        <button type="button" onClick={toLogin}>К входу</button>
      </Shell>
    )
  }
  if (done) {
    return (
      <Shell title="Пароль изменён">
        <p className="crm-cap">Все прежние сессии завершены. Войдите с новым паролем.</p>
        <button type="button" onClick={toLogin}>Войти</button>
      </Shell>
    )
  }

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    if (password !== password2) return setError('Пароли не совпадают.')
    setBusy(true)
    setError('')
    try {
      await api('/auth/reset', { method: 'POST', body: { token: token.current, password } })
      setDone(true)
    } catch (err) {
      const code = err.data?.error
      if (code === 'weak_password') setError(PASSWORD_REASONS[err.data.reason] || 'Пароль не подходит.')
      else if (code === 'invalid_token') { token.current = ''; setError('Ссылка недействительна или устарела — запросите новую на экране входа.') }
      else if (err.kind === 'throttled') setError('Слишком много попыток. Попробуйте позже.')
      else if (err.kind === 'network') setError('Нет связи с сервером.')
      else setError('Не удалось сменить пароль.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell title="Новый пароль">
      <form onSubmit={submit} style={{ display: 'contents' }}>
        <label>
          Новый пароль
          <div className="pw-field">
            <input type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={12} required autoFocus />
            <button type="button" className="pw-toggle" onClick={() => setShow((v) => !v)} aria-label={show ? 'Скрыть пароль' : 'Показать пароль'} tabIndex={-1}>{show ? '🙈' : '👁'}</button>
          </div>
        </label>
        <label>
          Повторите пароль
          <input type={show ? 'text' : 'password'} value={password2} onChange={(e) => setPassword2(e.target.value)} autoComplete="new-password" minLength={12} required />
        </label>
        <p className="crm-cap">Минимум 12 символов; слишком распространённые пароли не принимаются.</p>
        {error && <p className="crm-login-error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Сохраняем…' : 'Сменить пароль'}</button>
      </form>
    </Shell>
  )
}

/** Страница по ссылке «подтвердить новый email» (/crm/confirm-email#t=…). */
export function ConfirmEmailPage() {
  const [state, setState] = useState('loading') // loading | ok | invalid | taken | error
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    const token = takeTokenFromHash()
    if (!token) return setState('invalid')
    api('/auth/confirm-email', { method: 'POST', body: { token } })
      .then(() => setState('ok'))
      .catch((err) => {
        if (err.data?.error === 'email_taken') setState('taken')
        else if (err.data?.error === 'invalid_token') setState('invalid')
        else setState('error')
      })
  }, [])

  const texts = {
    loading: ['Подтверждаем email…', ''],
    ok: ['Email изменён', 'Теперь входите в CRM с новым адресом.'],
    invalid: ['Ссылка недействительна', 'Она уже использована или устарела (действует 30 минут). Запросите смену email в «Настройках» ещё раз.'],
    taken: ['Адрес уже занят', 'Этот email уже используется другой учётной записью.'],
    error: ['Не получилось', 'Попробуйте открыть ссылку ещё раз чуть позже.'],
  }
  const [title, text] = texts[state]
  return (
    <Shell title={title}>
      {text && <p className="crm-cap">{text}</p>}
      {state !== 'loading' && <button type="button" onClick={toLogin}>{state === 'ok' ? 'Войти' : 'К входу'}</button>}
    </Shell>
  )
}

/** Форма «Забыли пароль?» внутри карточки входа. */
export function ForgotPasswordForm({ onBack }) {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [state, setState] = useState('form') // form | sent | unavailable
  const [error, setError] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await api('/auth/forgot', { method: 'POST', body: { email } })
      setState('sent')
    } catch (err) {
      if (err.data?.error === 'mail_unavailable') setState('unavailable')
      else if (err.kind === 'throttled') setError('Слишком много запросов. Попробуйте позже.')
      else if (err.kind === 'network') setError('Нет связи с сервером.')
      else setError('Не удалось отправить запрос.')
    } finally {
      setBusy(false)
    }
  }

  if (state === 'sent') {
    return (
      <div className="crm-login-card">
        <div className="crm-login-mark" aria-hidden="true">N</div>
        <h1>Проверьте почту</h1>
        <p className="crm-cap">Если адрес зарегистрирован — письмо со ссылкой отправлено. Ссылка действует 30 минут и срабатывает один раз.</p>
        <button type="button" onClick={onBack}>К входу</button>
      </div>
    )
  }
  if (state === 'unavailable') {
    return (
      <div className="crm-login-card">
        <div className="crm-login-mark" aria-hidden="true">N</div>
        <h1>Недоступно</h1>
        <p className="crm-cap">Восстановление пароля по почте сейчас недоступно (почта сервера не настроена). Сбросить пароль можно командой <b>npm run reset-admin</b> в консоли сервера.</p>
        <button type="button" onClick={onBack}>К входу</button>
      </div>
    )
  }
  return (
    <form className="crm-login-card" onSubmit={submit}>
      <div className="crm-login-mark" aria-hidden="true">N</div>
      <h1>Восстановление пароля</h1>
      <label>
        Email учётной записи
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus />
      </label>
      {error && <p className="crm-login-error" role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? 'Отправляем…' : 'Отправить ссылку'}</button>
      <button type="button" className="crm-login-link" onClick={onBack}>Назад</button>
    </form>
  )
}
