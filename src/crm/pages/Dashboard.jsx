import { useCallback, useEffect, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { repo } from '../api.js'
import { apiErrorToast, fmtMoney, onRefresh, relTime } from '../ui.jsx'

const GREETINGS = [
  [5, 'Доброе утро'],
  [12, 'Добрый день'],
  [18, 'Добрый вечер'],
  [23, 'Доброй ночи'],
]

function greeting(name) {
  const h = Number(new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: 'numeric', hour12: false }).format(new Date()))
  const word = (GREETINGS.find(([limit]) => h < limit) || [24, 'Доброй ночи'])[1]
  return `${word}${name ? `, ${name.split(' ')[0]}` : ''}`
}

export default function Dashboard() {
  const [data, setData] = useState(null)
  const { user: me } = useOutletContext()

  const load = useCallback(() => {
    repo.dashboard().then(setData).catch(apiErrorToast)
  }, [])

  useEffect(load, [load])
  useEffect(() => onRefresh(load), [load])

  const toggleTask = async (t) => {
    try {
      await repo.update('tasks', t.id, { done: t.done ? 0 : 1 })
      load()
    } catch (err) {
      apiErrorToast(err)
    }
  }

  if (!data)
    return (
      <>
        <div className="skeleton" style={{ width: 260, height: 24 }} />
        <div className="crm-grid">
          <div className="tile"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" style={{ width: '60%' }} /></div>
          <div className="tile"><div className="skeleton" /><div className="skeleton" style={{ width: '70%' }} /></div>
        </div>
      </>
    )

  const dayLine = [
    new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' }),
    `${data.inbox.length} нов. ${plural(data.inbox.length, 'лид', 'лида', 'лидов')}`,
    data.counts.overdue > 0 ? `${data.counts.overdue} просрочено` : null,
  ].filter(Boolean).join(' · ')

  const maxSum = Math.max(...data.funnel.map((f) => f.sum || 0), 1)
  const totalOpen = data.funnel.reduce((s, f) => s + (f.sum || 0), 0)

  return (
    <>
      <h1 className="crm-h1">{greeting(me?.name)}</h1>
      <div className="crm-sub">{dayLine}</div>
      <div className="crm-grid">
        <section className="tile" aria-label="Новые лиды">
          <div className="tile-title"><span className="tile-num">01</span><h2>Новые лиды</h2></div>
          {data.inbox.length === 0 && (
            <div className="empty">Пока тихо. Новые лиды с сайта появятся здесь.<br />
              <Link to="/crm/contacts" className="btn">Добавить вручную</Link>
            </div>
          )}
          {data.inbox.map((lead) => (
            <div className="row-line" key={lead.id}>
              <div>
                <div className="row-name"><Link to={`/crm/contacts/${lead.id}`}>{lead.name}{lead.company ? ` · ${lead.company}` : ''}</Link></div>
                <div className="row-meta">
                  {lead.deal_title || 'без сделки'} · {lead.source === 'site-chat' ? 'из чата Невы' : 'с сайта'}, {relTime(lead.created_at)}
                </div>
              </div>
              <span className={`badge${lead.suspicious ? ' warn' : ''}`}>{lead.suspicious ? 'подозрительный' : 'новый'}</span>
            </div>
          ))}
        </section>

        <section className="tile" aria-label="Задачи на сегодня">
          <div className="tile-title"><span className="tile-num">02</span><h2>Сегодня</h2></div>
          {data.tasksToday.length === 0 && <div className="empty">Все задачи закрыты.<br /><Link to="/crm/tasks" className="btn">Новая задача</Link></div>}
          {data.tasksToday.map((t) => (
            <div className={`task-line${t.done ? ' done' : ''}`} key={t.id}>
              <button className={`task-check${t.done ? ' done' : ''}`} onClick={() => toggleTask(t)} aria-label="Выполнено" />
              <span className="task-title">{t.title}{t.contact_name ? ` — ${t.contact_name}` : ''}</span>
              <span className={`task-due${t.due_date < data.today ? ' over' : ''}`}>
                {t.due_date < data.today ? 'просрочено' : 'сегодня'}
              </span>
            </div>
          ))}
        </section>

        <section className="tile span2" aria-label="Воронка">
          <div className="tile-title"><span className="tile-num">03</span><h2>Воронка · {fmtMoney(totalOpen)} в работе</h2></div>
          {data.counts.deals === 0 && <div className="empty">Сделок пока нет — создайте первую на канбане.<br /><Link to="/crm/deals" className="btn">К сделкам</Link></div>}
          {data.counts.deals > 0 && data.funnel.map((f) => (
            <div className="funnel-row" key={f.stage}>
              <span className="funnel-label">{f.stage}{f.n ? ` · ${f.n}` : ''}</span>
              <div className="funnel-bar-wrap">{f.sum > 0 && <div className="funnel-bar" style={{ width: `${Math.max(4, (f.sum / maxSum) * 100)}%` }} />}</div>
              <span className="funnel-sum">{fmtMoney(f.sum || null)}{f.noAmount > 0 ? ` (+${f.noAmount} без суммы)` : ''}</span>
            </div>
          ))}
          {data.counts.deals > 0 && (
            <div className="funnel-terminal">
              {data.terminal.map((t) => <span key={t.stage}>{t.stage}: {t.n} · {fmtMoney(t.sum || 0)}</span>)}
            </div>
          )}
        </section>

        <section className="tile span2" aria-label="Последние действия">
          <div className="tile-title"><span className="tile-num">04</span><h2>Последние действия</h2></div>
          {data.activity.length === 0 && <div className="empty">История пуста — залогируйте первый звонок через Неву (Ctrl K).</div>}
          {data.activity.map((a) => (
            <div className="act-line" key={a.id}>
              <span className="act-dot" />
              <div>
                {a.type[0].toUpperCase() + a.type.slice(1)}{a.contact_name ? ` с ${a.contact_name}` : ''}{a.note ? ` — ${a.note}` : ''}
                <span className="act-time">{a.user_name || 'система'} · {relTime(a.happened_at)}</span>
              </div>
            </div>
          ))}
        </section>
      </div>
    </>
  )
}

function plural(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}
