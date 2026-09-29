import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { apiErrorToast, onRefresh, toast } from '../ui.jsx'

// Общая история тарифа Free настольного приложения NVizor (ADR-016): кому уже выдан
// бесплатный отчёт. Записи присылает само приложение при формировании PDF; здесь только
// просмотр и удаление ошибочной/тестовой записи. Только для admin — это ПДн клиентов.
export default function NvizorFree({ user }) {
  const isAdmin = user.role === 'admin'
  const [data, setData] = useState(null)
  const [q, setQ] = useState('')

  // Как в «Контактах»: медленный старый ответ не должен затереть свежий.
  const reqId = useRef(0)
  const load = useCallback((query = '') => {
    const id = ++reqId.current
    api(`/crm/nvizor-free${query ? `?q=${encodeURIComponent(query)}` : ''}`)
      .then((d) => id === reqId.current && setData(d))
      .catch((e) => id === reqId.current && apiErrorToast(e))
  }, [])

  useEffect(() => {
    if (!isAdmin) return undefined
    const t = setTimeout(() => load(q), q ? 250 : 0)
    return () => clearTimeout(t)
  }, [q, load, isAdmin])
  useEffect(() => (isAdmin ? onRefresh(() => load(q)) : undefined), [q, load, isAdmin])

  const remove = async (r) => {
    const what =
      `Удалить запись о бесплатном отчёте «${r.clientName || 'без имени'}»?\n\n` +
      'Клиент снова сможет получить бесплатный отчёт на других ПК. На том ПК, где отчёт ' +
      'выдан, запись останется в базе приложения. Отменить удаление нельзя.'
    if (!window.confirm(what)) return
    try {
      await api(`/crm/nvizor-free/${r.id}`, { method: 'DELETE' })
      toast('Запись удалена')
      load(q)
    } catch (err) {
      if (err.status === 404) {
        toast('Запись уже удалена', 'error')
        load(q)
      } else apiErrorToast(err)
    }
  }

  if (!isAdmin) {
    return (
      <>
        <div className="crm-head"><h1 className="crm-h1">NVizor Free</h1></div>
        <div className="tile"><div className="empty">Раздел доступен только администратору.</div></div>
      </>
    )
  }

  return (
    <>
      <div className="crm-head">
        <div>
          <h1 className="crm-h1">NVizor Free</h1>
          <div className="crm-sub">{data ? `Выдано бесплатных отчётов: ${data.total} · один на клиента` : ' '}</div>
        </div>
      </div>
      <div className="crm-filters">
        <input
          className="crm-search"
          placeholder="Поиск: имя клиента или цифры телефона…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Поиск по выданным бесплатным отчётам"
        />
      </div>
      <div className="tile" style={{ marginTop: 16 }}>
        {!data && <><div className="skeleton" /><div className="skeleton" style={{ width: '70%' }} /></>}
        {data && data.items.length === 0 && (
          <div className="empty">
            {q ? 'Ничего не найдено — уточните запрос.' : 'Бесплатных отчётов пока не выдано.'}
            <br />
            {!q && 'Записи появляются сами, когда приложение NVizor формирует PDF по тарифу Free.'}
          </div>
        )}
        {data?.items.map((r) => (
          <div className="row-line" key={r.id}>
            <div style={{ minWidth: 0 }}>
              <div className="row-name">
                {r.clientName || 'без имени'}
                {r.phoneKey ? <span className="row-meta"> · {fmtPhone(r.phoneKey)}</span> : null}
              </div>
              <div className="row-meta">
                {`выдан ${fmtDateTime(r.usedAt)}`}
                {` · фото: ${r.photoCount}`}
                {r.devices.length ? ` · ${r.devices.map(fmtDevice).join(', ')}` : ''}
                {r.locationCount ? ` · мест съёмки: ${r.locationCount}` : ''}
              </div>
            </div>
            <button className="btn danger" style={{ minHeight: 32, fontSize: 12 }} onClick={() => remove(r)}>
              Удалить
            </button>
          </div>
        ))}
      </div>
      <div className="crm-cap" style={{ marginTop: 10 }}>
        Историю ведёт приложение NVizor: перед каждым запросом Free оно сверяет клиента по телефону, имени,
        устройству съёмки, самим фото и месту. Решение «отказ или предупреждение» принимает приложение.
      </div>
    </>
  )
}

/** Ключ телефона — последние 10 цифр: 9210000001 → +7 921 000-00-01. */
function fmtPhone(key) {
  const d = String(key)
  if (d.length !== 10) return d
  return `+7 ${d.slice(0, 3)} ${d.slice(3, 6)}-${d.slice(6, 8)}-${d.slice(8)}`
}

function fmtDevice(d) {
  return String(d).replace(/\|/g, ' ')
}

function fmtDateTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso || ''
  return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
