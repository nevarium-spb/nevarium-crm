import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { repo } from '../api.js'
import { EntityModal } from '../forms.jsx'
import { ProjectBadge, ProjectFilter, shortProject, useProjectFilter } from '../projects.jsx'
import { SOURCE_LABEL, apiErrorToast, fmtMoney, onRefresh, relTime } from '../ui.jsx'

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
  const [project, setProject] = useProjectFilter()
  const [taskModal, setTaskModal] = useState(null)

  // Нумеруем запросы: медленный ответ по прошлому проекту не должен затереть свежий.
  const reqId = useRef(0)
  const load = useCallback(() => {
    const id = ++reqId.current
    repo
      .dashboard({ project })
      .then((d) => id === reqId.current && setData(d))
      .catch((e) => id === reqId.current && apiErrorToast(e))
  }, [project])

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

  // Подстраховка от рассинхрона версий: во время обновления сервера свежий
  // фронтенд может пару минут ходить в старый API без stats. Лучше показать
  // дашборд без блока аналитики, чем белый экран.
  const stats = data.stats || { days: 0, byProject: [], bySource: [] }
  const totalLeads = stats.byProject.reduce((s, r) => s + r.n, 0)

  return (
    <>
      <div className="crm-head">
        <div>
          <h1 className="crm-h1">{greeting(me?.name)}</h1>
          <div className="crm-sub">{dayLine}</div>
        </div>
        <ProjectFilter value={project} onChange={setProject} />
      </div>
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
              <span className="row-badges">
                <ProjectBadge id={lead.project_id} when={project === 'all'} />
                <span className={`badge${lead.suspicious ? ' warn' : ''}`}>{lead.suspicious ? 'подозрительный' : 'новый'}</span>
              </span>
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

        {/* Блок отвечает на вопрос «я про кого-нибудь забыл?». Сделка уходит отсюда,
            как только по ней появится взаимодействие или открытая задача — поэтому
            кнопка «Поставить задачу» здесь и есть способ закрыть строку. */}
        <section className="tile span2" aria-label="Остывающие сделки">
          <div className="tile-title">
            <span className="tile-num">03</span>
            <h2>Остывают{data.cooling.length ? ` · ${data.cooling.length}` : ''}</h2>
          </div>
          {data.cooling.length === 0 && (
            <div className="empty">Ничего не остывает — по всем живым сделкам есть свежее касание или запланированная задача.</div>
          )}
          {data.cooling.length > 0 && (
            <div className="crm-cap" style={{ marginBottom: 8 }}>
              Тишина дольше {data.coolingDays} дней. Сделки с открытой задачей сюда не попадают.
            </div>
          )}
          {data.cooling.map((row) => (
            <div className="row-line" key={row.id}>
              <div style={{ minWidth: 0 }}>
                <div className="row-name">
                  <Link to={`/crm/contacts/${row.contact_id}`}>{row.contact_name}</Link>
                  {row.amount ? <span className="row-meta"> · {fmtMoney(row.amount)}</span> : null}
                </div>
                <div className="row-meta">
                  {row.title} · {row.stage} · {row.no_touch ? 'ни одного касания с' : 'последнее касание'} {relTime(row.last_touch)}
                </div>
              </div>
              <span className="row-badges">
                <ProjectBadge id={row.project_id} when={project === 'all'} />
                <button
                  className="btn"
                  style={{ minHeight: 32, fontSize: 12 }}
                  // Срок по умолчанию — сегодня: иначе задача без даты уходит в «без срока»,
                  // сделка пропадает из «остывают», и на дашборде не остаётся никакого следа.
                  onClick={() => setTaskModal({ contact_id: row.contact_id, deal_id: row.id, due_date: data.today, title: `Связаться: ${row.contact_name}` })}
                >
                  Поставить задачу
                </button>
              </span>
            </div>
          ))}
        </section>

        <section className="tile span2" aria-label="Воронка">
          <div className="tile-title"><span className="tile-num">04</span><h2>Воронка · {fmtMoney(totalOpen)} в работе</h2></div>
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
          <div className="tile-title"><span className="tile-num">05</span><h2>Последние действия</h2></div>
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

        <section className="tile span2" aria-label="Аналитика заявок">
          <div className="tile-title">
            <span className="tile-num">06</span>
            <h2>Заявки за {stats.days} дней · {totalLeads}</h2>
          </div>
          {totalLeads === 0 && <div className="empty">За этот период заявок не было.</div>}
          {totalLeads > 0 && (
            <div className="stats-cols">
              <div>
                <div className="stats-cap">По проектам</div>
                {stats.byProject.map((r) => (
                  <StatRow key={r.id} label={shortProject(r.name)} n={r.n} total={totalLeads} />
                ))}
              </div>
              <div>
                <div className="stats-cap">Откуда пришли</div>
                {stats.bySource.map((r) => (
                  <StatRow key={r.source} label={SOURCE_LABEL[r.source] || r.source} n={r.n} total={totalLeads} />
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
      {taskModal && (
        <EntityModal entity="tasks" initial={taskModal} onSaved={load} onClose={() => setTaskModal(null)} />
      )}
    </>
  )
}

function StatRow({ label, n, total }) {
  return (
    <div className="funnel-row">
      <span className="funnel-label">{label}</span>
      <div className="funnel-bar-wrap">
        <div className="funnel-bar" style={{ width: `${Math.max(4, (n / total) * 100)}%` }} />
      </div>
      <span className="funnel-sum">{n}</span>
    </div>
  )
}

function plural(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}
