import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { ProjectFilter, useProjectFilter } from '../projects.jsx'
import { apiErrorToast, fmtMoney, onRefresh, toast } from '../ui.jsx'
import { channelTitle } from '../../shared/attribution.js'

// Свой счётчик посещений сайтов (ADR-027): заходы, страницы, маршруты, источники и заявки по каналам.
// Без cookie и IP — в базе только суммы за день, поэтому страница открыта всем сотрудникам.
const PERIODS = [[7, '7 дней'], [30, '30 дней'], [90, '90 дней'], [365, 'Год']]
const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '—')
const fmtDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })

export default function Analytics({ user }) {
  const [project, setProject] = useProjectFilter()
  const [days, setDays] = useState(30)
  const [data, setData] = useState(null)

  const reqId = useRef(0)
  const load = useCallback(() => {
    const id = ++reqId.current
    api(`/crm/analytics?days=${days}&project=${encodeURIComponent(project)}`)
      .then((d) => id === reqId.current && setData(d))
      .catch((e) => id === reqId.current && apiErrorToast(e))
  }, [days, project])
  useEffect(load, [load])
  useEffect(() => onRefresh(load), [load])

  const clear = async () => {
    if (!window.confirm('Удалить всю статистику посещений и маршрутов по всем проектам? Заявки и сделки не затрагиваются. Отменить нельзя.')) return
    try {
      const r = await api('/crm/analytics/visits', { method: 'DELETE' })
      toast(`Статистика очищена (строк: ${r.removed})`)
      load()
    } catch (err) { apiErrorToast(err) }
  }

  return (
    <>
      <h1 className="crm-h1">Аналитика</h1>
      <div className="crm-sub">Посещения сайтов — свой счётчик, без cookie и IP-адресов. Заявки и оплаты — по источнику сделки.</div>
      <div className="an-filters">
        <ProjectFilter value={project} onChange={setProject} />
        <div className="proj-filter" role="group" aria-label="Период">
          {PERIODS.map(([d, label]) => (
            <button key={d} type="button" className={days === d ? 'on' : ''} aria-pressed={days === d} onClick={() => setDays(d)}>{label}</button>
          ))}
        </div>
      </div>

      {!data ? <div className="tile"><div className="skeleton" /><div className="skeleton" style={{ width: '60%' }} /></div> : (
        <>
          <div className="an-stats">
            <Stat label="Заходы" value={data.totals.visits} />
            <Stat label="Просмотры страниц" value={data.totals.views} />
            <Stat label="Заявки" value={data.totals.leads} hint={`${pct(data.totals.leads, data.totals.visits)} от заходов`} />
            <Stat label="Оплаты" value={data.totals.paid} hint={`${pct(data.totals.paid, data.totals.leads)} от заявок`} />
            <Stat label="Выручка" value={fmtMoney(data.totals.revenue)} />
          </div>

          <section className="tile an-block" aria-label="Заходы по дням">
            <div className="tile-title"><span className="tile-num">01</span><h2>Заходы по дням</h2></div>
            <DayBars rows={data.byDay} fromDay={data.fromDay} days={data.days} />
          </section>

          <section className="tile an-block" aria-label="Каналы">
            <div className="tile-title"><span className="tile-num">02</span><h2>Откуда приходят</h2></div>
            {data.channels.length === 0 ? <div className="empty">Пока нет ни заходов, ни заявок за этот период.</div> : (
              <div className="an-table-wrap">
                <table className="an-table">
                  <thead><tr><th>Канал</th><th>Заходы</th><th>Заявки</th><th>Заявки / заходы</th><th>Оплаты</th><th>Выручка</th></tr></thead>
                  <tbody>
                    {data.channels.map((c) => (
                      <tr key={c.channel || '-'}>
                        <td>{channelTitle(c.channel)}</td>
                        <td><Bar value={c.visits} max={data.channels[0]?.visits || 1} /></td>
                        <td>{c.leads}</td>
                        <td>{c.visits ? pct(c.leads, c.visits) : '—'}</td>
                        <td>{c.paid}</td>
                        <td>{fmtMoney(c.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="crm-cap">«Не указан» — заявки без источника: добавлены вручную или с сайта до подключения счётчика. Источник сделки можно поправить в её форме.</div>
          </section>

          <section className="tile an-block" aria-label="Маршруты">
            <div className="tile-title"><span className="tile-num">03</span><h2>Маршруты заходов</h2></div>
            {data.routes.length === 0 ? <div className="empty">Маршрутов пока нет.</div> : data.routes.map((r) => (
              <div className="row-line" key={r.steps.join('|')}>
                <div className="an-route">
                  {r.steps.map((s, i) => (
                    <span key={i} className="an-route-part">
                      {i > 0 && <span className="an-arrow" aria-hidden="true">→</span>}
                      <span className={s.startsWith('★') ? 'an-step goal' : 'an-step'}>{s}</span>
                    </span>
                  ))}
                </div>
                <span className="an-count">{r.count}</span>
              </div>
            ))}
            <div className="crm-cap">Порядок страниц, открытых за один заход (вкладку), до 10 шагов; «★ заявка» — сайт отметил отправку формы. Число — сколько заходов прошли ровно этот путь.</div>
          </section>

          <div className="crm-grid">
            <ListTile num="04" title="Переходы" rows={data.transitions.map((t) => ({ k: `${t.from} → ${t.to}`, v: t.count }))} empty="Переходов пока нет." />
            <ListTile num="05" title="Популярные страницы" rows={data.pages.map((p) => ({ k: p.path, v: p.views }))} empty="Просмотров пока нет." unit="просм." />
            <ListTile num="06" title="Страницы входа" rows={data.entries.map((e) => ({ k: e.path, v: e.count }))} empty="Нет данных." />
            <ListTile num="07" title="Где уходят" rows={data.exits.map((e) => ({ k: e.path, v: e.count }))} empty="Нет данных." />
            <ListTile num="08" title="Сайты-источники" rows={data.refs.map((r) => ({ k: r.ref_host, v: r.visits }))} empty="Переходов с других сайтов пока нет." />
            <ListTile num="09" title="Метки ссылок (utm)" rows={data.campaigns.map((c) => ({ k: [c.utm_source, c.utm_campaign].filter(Boolean).join(' · '), v: c.visits }))} empty="Ссылок с метками пока не было." />
          </div>

          {user.role === 'admin' && (
            <div style={{ marginTop: 16 }}>
              <button className="btn danger" onClick={clear}>Очистить статистику посещений</button>
              <div className="crm-cap">Нужно на общем запуске — убрать тестовые заходы. Заявки и сделки не затрагиваются.</div>
            </div>
          )}
        </>
      )}
    </>
  )
}

function Stat({ label, value, hint }) {
  return (
    <div className="tile an-stat">
      <div className="an-stat-label">{label}</div>
      <div className="an-stat-value">{value}</div>
      {hint && <div className="an-stat-hint">{hint}</div>}
    </div>
  )
}

function Bar({ value, max }) {
  return (
    <span className="an-bar" title={`Заходов: ${value}`}>
      <span className="an-bar-fill" style={{ width: `${max ? Math.max(2, (value / max) * 100) : 0}%` }} />
      <span className="an-bar-num">{value}</span>
    </span>
  )
}

/** Заходы по дням: один ряд — столбики одного цвета, легенда не нужна (заголовок называет ряд); значение — по наведению и в подписи. */
function DayBars({ rows, fromDay, days }) {
  const by = new Map(rows.map((r) => [r.day, r]))
  const list = []
  const start = new Date(`${fromDay}T12:00:00Z`)
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 864e5).toISOString().slice(0, 10)
    list.push({ day: d, visits: by.get(d)?.visits || 0, views: by.get(d)?.views || 0 })
  }
  const max = Math.max(1, ...list.map((r) => r.visits))
  if (!rows.length) return <div className="empty">Заходов за этот период нет. Счётчик начинает считать, как только сайт подключит скрипт.</div>
  return (
    <>
      <div className="an-days" role="img" aria-label={`Заходы по дням, максимум ${max}`}>
        {list.map((r) => (
          <span key={r.day} className="an-day" title={`${fmtDay(r.day)}: заходов ${r.visits}, просмотров ${r.views}`}>
            <span className="an-day-fill" style={{ height: `${(r.visits / max) * 100}%` }} />
          </span>
        ))}
      </div>
      <div className="an-days-axis"><span>{fmtDay(list[0].day)}</span><span>макс. {max} в день</span><span>{fmtDay(list[list.length - 1].day)}</span></div>
    </>
  )
}

function ListTile({ num, title, rows, empty, unit = '' }) {
  return (
    <section className="tile" aria-label={title}>
      <div className="tile-title"><span className="tile-num">{num}</span><h2>{title}</h2></div>
      {rows.length === 0 ? <div className="empty">{empty}</div> : rows.map((r) => (
        <div className="row-line" key={r.k}>
          <div className="an-key">{r.k}</div>
          <span className="an-count">{r.v}{unit ? ` ${unit}` : ''}</span>
        </div>
      ))}
    </section>
  )
}
