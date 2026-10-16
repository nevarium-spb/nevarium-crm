// Блоки «Настроек» (ADR-020): мой профиль, безопасность, уведомления и сроки (админ).
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { PASSWORD_REASONS } from '../AccountPages.jsx'
import { WRONG_ADDRESS, apiErrorToast, relTime, toast } from '../ui.jsx'

const PLAN_TITLES = {
  stage: 'Проверка этапа',
  repair: 'Ремонт под контролем',
  house: 'Дом под контролем',
  monthly: 'Объект помесячно',
  company: 'Компания',
}

/** «Chrome · Windows» из строки User-Agent — для истории входов (сырая строка длинная и неинформативная). */
export function browserLabel(ua = '') {
  const b = /Edg\//.test(ua) ? 'Edge' : /YaBrowser/.test(ua) ? 'Яндекс Браузер' : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ''
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''
  return [b, os].filter(Boolean).join(' · ') || (ua ? ua.slice(0, 40) : 'неизвестно')
}

function PasswordInput({ value, onChange, show, label, autoComplete = 'new-password' }) {
  return (
    <label>
      {label}
      <input type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} required />
    </label>
  )
}

export default function AccountSettings({ user }) {
  const isAdmin = user.role === 'admin'
  const [me, setMe] = useState(null)
  const [logins, setLogins] = useState(null)

  const loadMe = useCallback(() => {
    api('/crm/me').then(setMe).catch(apiErrorToast)
    api('/crm/me/logins').then(setLogins).catch(() => setLogins(null))
  }, [])
  useEffect(loadMe, [loadMe])

  return (
    <>
      <ProfileTile me={me} onChanged={loadMe} />
      <SecurityTile logins={logins} />
      {isAdmin && <AdminSettingsTile mailAvailable={me?.mailAvailable} />}
    </>
  )
}

function ProfileTile({ me, onChanged }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState({ newEmail: '', currentPassword: '' })
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', newPassword2: '' })
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState({ email: '', pw: '' })

  useEffect(() => { if (me) setName(me.name) }, [me])
  if (!me) return <section className="tile"><div className="skeleton" /></section>

  const saveName = async (e) => {
    e.preventDefault()
    setBusy('name')
    try { await api('/crm/me', { method: 'PATCH', body: { name } }); toast('Имя сохранено'); onChanged() } catch (err) { apiErrorToast(err) } finally { setBusy('') }
  }

  const changeEmail = async (e) => {
    e.preventDefault()
    setBusy('email'); setMsg((m) => ({ ...m, email: '' }))
    try {
      await api('/crm/me/email', { method: 'POST', body: email })
      setMsg((m) => ({ ...m, email: `Письмо со ссылкой отправлено на ${email.newEmail}. Email сменится после подтверждения (30 минут); на текущий адрес ушло уведомление.` }))
      setEmail({ newEmail: '', currentPassword: '' })
    } catch (err) {
      const code = err.data?.error
      const text = code === 'forbidden' ? WRONG_ADDRESS : code === 'wrong_password' ? 'Текущий пароль неверный.'
        : code === 'mail_unavailable' ? 'Почта сервера не настроена — сменить email с подтверждением сейчас нельзя.'
        : code === 'mail_failed' ? 'Не удалось отправить письмо на новый адрес. Проверьте адрес и попробуйте позже.'
        : code === 'email_taken' ? 'Такой email уже используется.'
        : code === 'bad_input' ? 'Проверьте адрес: он должен быть корректным и отличаться от текущего.'
        : err.kind === 'throttled' ? 'Слишком много попыток. Подождите немного.' : 'Не удалось выполнить запрос.'
      setMsg((m) => ({ ...m, email: text }))
    } finally { setBusy('') }
  }

  const changePassword = async (e) => {
    e.preventDefault()
    if (pw.newPassword !== pw.newPassword2) return setMsg((m) => ({ ...m, pw: 'Новые пароли не совпадают.' }))
    setBusy('pw'); setMsg((m) => ({ ...m, pw: '' }))
    try {
      await api('/crm/me/password', { method: 'POST', body: pw })
      setPw({ currentPassword: '', newPassword: '', newPassword2: '' })
      toast('Пароль изменён, остальные сессии завершены')
    } catch (err) {
      const code = err.data?.error
      const text = code === 'forbidden' ? WRONG_ADDRESS : code === 'wrong_password' ? 'Текущий пароль неверный.'
        : code === 'weak_password' ? (PASSWORD_REASONS[err.data.reason] || 'Пароль не подходит.')
        : code === 'mismatch' ? 'Новые пароли не совпадают.'
        : err.kind === 'throttled' ? 'Слишком много попыток. Подождите немного.' : 'Не удалось сменить пароль.'
      setMsg((m) => ({ ...m, pw: text }))
    } finally { setBusy('') }
  }

  return (
    <section className="tile" aria-label="Мой профиль">
      <div className="tile-title"><span className="tile-num">00</span><h2>Мой профиль</h2></div>

      <form className="crm-form" onSubmit={saveName}>
        <label>Имя<input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required /></label>
        <div className="crm-form-actions"><button type="submit" className="btn" disabled={busy === 'name' || name.trim() === me.name}>Сохранить имя</button></div>
      </form>

      <h3 style={{ margin: '14px 0 6px', fontSize: 14 }}>Email для входа: {me.email}</h3>
      {!me.mailAvailable && <div className="crm-cap">Почта сервера не настроена — смена email с подтверждением пока недоступна.</div>}
      <form className="crm-form" onSubmit={changeEmail}>
        <label>Новый email<input type="email" value={email.newEmail} onChange={(e) => setEmail({ ...email, newEmail: e.target.value })} required disabled={!me.mailAvailable} /></label>
        <label>Текущий пароль<input type="password" value={email.currentPassword} onChange={(e) => setEmail({ ...email, currentPassword: e.target.value })} autoComplete="current-password" required disabled={!me.mailAvailable} /></label>
        {msg.email && <p className="crm-cap" role="status">{msg.email}</p>}
        <div className="crm-form-actions"><button type="submit" className="btn" disabled={busy === 'email' || !me.mailAvailable}>Сменить email</button></div>
      </form>

      <h3 style={{ margin: '14px 0 6px', fontSize: 14 }}>Пароль</h3>
      <form className="crm-form" onSubmit={changePassword}>
        <PasswordInput label="Текущий пароль" value={pw.currentPassword} show={show} autoComplete="current-password" onChange={(v) => setPw({ ...pw, currentPassword: v })} />
        <PasswordInput label={`Новый пароль (от ${me.minPasswordLength} символов)`} value={pw.newPassword} show={show} onChange={(v) => setPw({ ...pw, newPassword: v })} />
        <PasswordInput label="Новый пароль ещё раз" value={pw.newPassword2} show={show} onChange={(v) => setPw({ ...pw, newPassword2: v })} />
        <label className="tariff-check"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Показать пароли</label>
        <div className="crm-cap">Слишком распространённые пароли не принимаются. После смены остальные устройства выйдут, вам придёт письмо.</div>
        {msg.pw && <p className="field-error" role="alert">{msg.pw}</p>}
        <div className="crm-form-actions"><button type="submit" className="btn primary" disabled={busy === 'pw'}>Сменить пароль</button></div>
      </form>
    </section>
  )
}

function SecurityTile({ logins }) {
  const logoutAll = async () => {
    if (!window.confirm('Выйти на всех устройствах, включая это? Потребуется войти заново.')) return
    try {
      await api('/crm/me/logout-all', { method: 'POST' })
      window.location.assign('/crm')
    } catch (err) { apiErrorToast(err) }
  }
  return (
    <section className="tile" aria-label="Безопасность">
      <div className="tile-title"><span className="tile-num">00</span><h2>Безопасность</h2></div>
      <button className="btn danger" onClick={logoutAll}>Выйти на всех устройствах</button>
      <h3 style={{ margin: '14px 0 6px', fontSize: 14 }}>Последние входы</h3>
      {!logins && <div className="row-meta">История недоступна.</div>}
      {logins?.items.length === 0 && <div className="row-meta">Пока нет записей.</div>}
      {logins?.items.map((l) => (
        <div className="row-line" key={l.id}>
          <div>
            <div className="row-name">{browserLabel(l.user_agent)}</div>
            <div className="row-meta">{l.ip || 'IP неизвестен'} · {relTime(l.created_at)} · {new Date(l.created_at).toLocaleString('ru-RU')}</div>
          </div>
        </div>
      ))}
      {logins && <div className="crm-cap">Показаны последние {logins.items.length} из хранимых {logins.keepDays} дней. Увидели незнакомый вход — смените пароль и нажмите «Выйти на всех устройствах».</div>}
    </section>
  )
}

function AdminSettingsTile({ mailAvailable }) {
  const [s, setS] = useState(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => { api('/crm/settings').then(setS).catch(apiErrorToast) }, [])
  useEffect(load, [load])
  if (!s) return <section className="tile"><div className="skeleton" /></section>

  const save = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await api('/crm/settings', { method: 'PATCH', body: { notify: s.notify, reminderDays: s.reminderDays, freeLinkDays: s.freeLinkDays } })
      setS((x) => ({ ...x, ...res }))
      toast('Настройки сохранены')
    } catch (err) {
      if (err.data?.error === 'bad_input') toast('Проверьте числа: напоминания — 1…365 дней, срок кабинета Free — 1…90', 'error')
      else apiErrorToast(err)
    } finally { setBusy(false) }
  }

  return (
    <section className="tile" aria-label="Уведомления и сроки">
      <div className="tile-title"><span className="tile-num">00</span><h2>Уведомления и сроки</h2></div>
      <form className="crm-form" onSubmit={save}>
        <h3 style={{ margin: '0 0 2px', fontSize: 14 }}>Каналы уведомлений о заявках</h3>
        <label className="tariff-check"><input type="checkbox" checked={s.notify.telegram} onChange={(e) => setS({ ...s, notify: { ...s.notify, telegram: e.target.checked } })} /> Telegram</label>
        <label className="tariff-check"><input type="checkbox" checked={s.notify.max} onChange={(e) => setS({ ...s, notify: { ...s.notify, max: e.target.checked } })} /> MAX</label>
        <div className="crm-cap">Выключенный канал ничего не получает и не копит очередь — при включении старые уведомления не придут. Тексты по-прежнему без персональных данных.</div>

        <h3 style={{ margin: '10px 0 2px', fontSize: 14 }}>За сколько дней напоминать о конце тарифа</h3>
        {Object.entries(PLAN_TITLES).map(([plan, title]) => (
          <label key={plan}>
            {title} (по умолчанию {s.defaults.reminderDays[plan]})
            <input type="number" min="1" max="365" value={s.reminderDays[plan]} required
              onChange={(e) => setS({ ...s, reminderDays: { ...s.reminderDays, [plan]: e.target.value === '' ? '' : Number(e.target.value) } })} />
          </label>
        ))}

        <h3 style={{ margin: '10px 0 2px', fontSize: 14 }}>Кабинет клиента</h3>
        <label>
          Срок ссылки Free, дней (по умолчанию {s.defaults.freeLinkDays})
          <input type="number" min="1" max="90" value={s.freeLinkDays} required onChange={(e) => setS({ ...s, freeLinkDays: e.target.value === '' ? '' : Number(e.target.value) })} />
        </label>
        <div className="crm-cap">Действует для новых ссылок; уже выданные сохраняют свой срок.</div>
        {mailAvailable === false && <div className="crm-cap">Почта сервера (SMTP) не настроена: восстановление пароля и смена email по письму недоступны.</div>}
        <div className="crm-form-actions"><button type="submit" className="btn primary" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button></div>
      </form>
    </section>
  )
}
