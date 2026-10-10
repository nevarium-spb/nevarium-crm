// Тарифы клиентов в интерфейсе CRM (ADR-019): блок «Тариф» в карточке клиента и
// значок тарифа с предупреждениями в списках (контакты, канбан сделок). Правила
// считает сервер (server/entitlements.js) — здесь только показ и ручные действия.
import { useCallback, useEffect, useState } from 'react'
import { api } from './api.js'
import { Modal, apiErrorToast, fmtMoney, onRefresh, relTime, toast } from './ui.jsx'

const ru = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '—')
const STATUS_LABEL = { active: 'действует', cancelled: 'отменён', credited: 'засчитан в пакет' }

/** Значки всех клиентов с тарифом — один запрос на список. */
export function useTariffBadges() {
  const [items, setItems] = useState({})
  const load = useCallback(() => {
    api('/crm/entitlements/badges').then((r) => setItems(r.items || {})).catch(() => setItems({}))
  }, [])
  useEffect(load, [load])
  useEffect(() => onRefresh(load), [load])
  return items
}

export function TariffBadge({ badge }) {
  if (!badge) return null
  const warn = badge.warnings?.length > 0
  return (
    <span className={`badge${warn ? ' warn' : ''}`} title={warn ? badge.warnings.map((w) => w.text).join('\n') : `до ${ru(badge.expiresOn)}`}>
      {badge.title}{warn ? ' ⚠' : ''}
    </span>
  )
}

function EntitlementForm({ initial, plans, stages, onSave, onClose }) {
  const editing = Boolean(initial.id)
  const [f, setF] = useState({
    plan: initial.plan || 'repair',
    starts_on: initial.startsOn || '',
    expires_on: initial.expiresOn || '',
    paid_amount: initial.paidAmount ?? '',
    objects: (initial.objects || []).join('\n'),
    stages: initial.stages?.map((s) => s.code) || null,
    urgent: Boolean(initial.urgent),
    weekend: Boolean(initial.weekend),
    parent_report: initial.parentReport || '',
    note: initial.note || '',
  })
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  const planStages = stages[f.plan] || []
  const chosen = f.stages ?? planStages.map(([c]) => c)
  const toggleStage = (code) => setF((x) => {
    const cur = x.stages ?? planStages.map(([c]) => c)
    return { ...x, stages: cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code] }
  })
  const submit = (e) => {
    e.preventDefault()
    const body = {
      expires_on: f.expires_on || null,
      paid_amount: f.paid_amount === '' ? null : Number(f.paid_amount),
      urgent: f.urgent, weekend: f.weekend, note: f.note,
      objects: f.objects.split('\n').map((s) => s.trim()).filter(Boolean),
      parent_report: f.parent_report,
    }
    if (planStages.length) body.stages = chosen
    if (!editing) {
      body.plan = f.plan
      if (f.starts_on) body.starts_on = f.starts_on
      if (!f.expires_on) delete body.expires_on // сервер посчитает срок по тарифу
      if (f.paid_amount === '') delete body.paid_amount // по умолчанию — цена тарифа
    }
    onSave(body)
  }
  return (
    <Modal title={editing ? `Изменить: ${initial.title}` : 'Назначить тариф'} onClose={onClose}>
      <form className="crm-form" onSubmit={submit}>
        {!editing && (
          <label>
            Тариф
            <select value={f.plan} onChange={(e) => setF((x) => ({ ...x, plan: e.target.value, stages: null }))}>
              {Object.entries(plans).map(([code, p]) => <option key={code} value={code}>{p.title} — {fmtMoney(p.price)}</option>)}
            </select>
          </label>
        )}
        {!editing && (
          <label>
            Дата оплаты
            <input type="date" value={f.starts_on} onChange={set('starts_on')} />
            <span className="crm-cap">Пусто — сегодня.</span>
          </label>
        )}
        <label>
          Действует до (включительно)
          <input type="date" value={f.expires_on} onChange={set('expires_on')} />
          {!editing && <span className="crm-cap">Пусто — по тарифу: пакеты и разовая — год, помесячные — 30 дней.</span>}
        </label>
        <label>
          Оплачено, ₽
          <input type="number" min="0" value={f.paid_amount} onChange={set('paid_amount')} placeholder={editing ? '' : String(plans[f.plan]?.price ?? '')} />
        </label>
        {planStages.length > 0 && (
          <fieldset className="tariff-stages">
            <legend>Этапы пакета</legend>
            {planStages.map(([code, title]) => (
              <label key={code} className="tariff-check">
                <input type="checkbox" checked={chosen.includes(code)} onChange={() => toggleStage(code)} /> {title}
              </label>
            ))}
          </fieldset>
        )}
        {['monthly', 'company'].includes(f.plan) && (
          <label>
            Объекты (по одному в строке — ссылка на объект NVizor или название)
            <textarea rows={3} value={f.objects} onChange={set('objects')} />
          </label>
        )}
        {f.plan === 'recheck' && (
          <label>
            Номер исходного отчёта
            <input value={f.parent_report} onChange={set('parent_report')} placeholder="NV-2026-…" />
          </label>
        )}
        <label className="tariff-check"><input type="checkbox" checked={f.urgent} onChange={set('urgent')} /> Срочность оплачена (+2 000 ₽)</label>
        <label className="tariff-check"><input type="checkbox" checked={f.weekend} onChange={set('weekend')} /> Выходной день оплачен (+2 000 ₽)</label>
        <label>
          Комментарий
          <input value={f.note} onChange={set('note')} maxLength={1000} />
        </label>
        <div className="crm-form-actions">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn primary">{editing ? 'Сохранить' : 'Назначить'}</button>
        </div>
      </form>
    </Modal>
  )
}

/** Блок «Тариф» в карточке клиента. */
export function TariffBlock({ contactId }) {
  const [state, setState] = useState(null)
  const [form, setForm] = useState(null) // {} — назначить, entitlement — изменить
  const [link, setLink] = useState(null)

  const load = useCallback(() => {
    api(`/crm/contacts/${contactId}/entitlements`).then(setState).catch(apiErrorToast)
  }, [contactId])
  useEffect(load, [load])
  useEffect(() => onRefresh(load), [load])

  if (!state) return <section className="tile span2"><div className="skeleton" /></section>

  const act = async (fn, okText) => {
    try { await fn(); toast(okText); load() } catch (err) {
      if (err.data?.error === 'nothing_to_credit') toast('Нет действующих разовых проверок для зачёта', 'error')
      else apiErrorToast(err)
    }
  }
  const save = (body) => act(async () => {
    if (form.id) await api(`/crm/entitlements/${form.id}`, { method: 'PATCH', body })
    else await api('/crm/entitlements', { method: 'POST', body: { ...body, contact_id: contactId } })
    setForm(null)
  }, form?.id ? 'Тариф изменён' : 'Тариф назначен')

  const renew = (e) => {
    const sum = window.prompt(`Продлить «${e.title}»? Сумма оплаты, ₽ (пусто — не менять):`, '')
    if (sum === null) return
    act(() => api(`/crm/entitlements/${e.id}/renew`, { method: 'POST', body: sum ? { paid_amount: Number(sum) } : {} }), 'Тариф продлён')
  }
  const cancel = (e) => window.confirm(`Отменить тариф «${e.title}»? Он перестанет учитываться в проверках.`)
    && act(() => api(`/crm/entitlements/${e.id}/cancel`, { method: 'POST' }), 'Тариф отменён')
  const convert = (plan) => window.confirm(`Перевести разовые проверки в «${state.plans[plan].title}»? Оплаченное засчитается, срок — год от сегодняшней доплаты.`)
    && act(() => api(`/crm/contacts/${contactId}/entitlements/convert`, { method: 'POST', body: { plan } }), 'Переведено в пакет')
  const issueLink = async () => {
    try {
      const r = await api(`/crm/contacts/${contactId}/client-links`, { method: 'POST' })
      setLink(r.url)
      load()
    } catch (err) { apiErrorToast(err) }
  }
  const revokeAll = () => window.confirm('Отозвать все личные ссылки клиента? Старые ссылки из отчётов перестанут открывать кабинет.')
    && act(() => api(`/crm/contacts/${contactId}/client-links/revoke-all`, { method: 'POST' }), 'Ссылки отозваны')

  const ents = state.entitlements
  const hasStage = ents.some((e) => e.plan === 'stage' && e.status === 'active')

  return (
    <section className="tile span2" aria-label="Тариф">
      <div className="tile-title">
        <span className="tile-num">₽</span><h2>Тариф</h2>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => setForm({})}>Назначить</button>
          {hasStage && <button className="btn" onClick={() => convert(state.offer?.plan || 'repair')}>Перевести в пакет</button>}
        </div>
      </div>

      {ents.length === 0 && <div className="empty">Оплаченных тарифов нет. Free учитывается отдельно — экран «NVizor Free».</div>}
      {ents.map((e) => (
        <div className="row-line" key={e.id} style={e.status !== 'active' ? { opacity: 0.55 } : undefined}>
          <div style={{ minWidth: 0 }}>
            <div className="row-name">
              {e.title}
              <span className="row-meta"> · {STATUS_LABEL[e.status] || e.status}</span>
              {e.warnings.map((w) => <span key={w.code} className="badge warn" style={{ marginLeft: 6 }}>{w.text}</span>)}
            </div>
            <div className="row-meta">
              с {ru(e.startsOn)} до {e.expiresOn ? ru(e.expiresOn) : 'без срока'}
              {e.daysLeft !== null && e.status === 'active' ? ` · ${e.daysLeft >= 0 ? `осталось ${e.daysLeft} дн.` : 'истёк'}` : ''}
              {e.paidAmount != null ? ` · оплачено ${fmtMoney(e.paidAmount)}` : ''}
              {e.urgent ? ' · срочность' : ''}{e.weekend ? ' · выходные' : ''}
              {e.objects?.length ? ` · объекты: ${e.objects.join(', ')}` : ''}
              {e.note ? ` · ${e.note}` : ''}
            </div>
            {e.stages.length > 0 && (
              <div className="row-meta">
                Этапы: осталось {e.stages.filter((s) => !s.checked).length} из {e.stages.length} —{' '}
                {e.stages.map((s) => `${s.checked ? '✓' : '○'} ${s.title}${s.recheckUsed ? ' (повторная ✓)' : ''}`).join(' · ')}
              </div>
            )}
            {e.period && <div className="row-meta">Проверки периода: {e.period.used} из {e.period.limit}, период до {ru(e.period.endsOn)}</div>}
          </div>
          {e.status === 'active' && (
            <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn" style={{ minHeight: 30, fontSize: 12 }} onClick={() => renew(e)}>Продлить</button>
              <button className="btn" style={{ minHeight: 30, fontSize: 12 }} onClick={() => setForm(e)}>Изменить</button>
              <button className="btn danger" style={{ minHeight: 30, fontSize: 12 }} onClick={() => cancel(e)}>Отменить</button>
            </span>
          )}
        </div>
      ))}

      {state.offer && (
        <div className="crm-cap" style={{ marginTop: 8 }}>
          Предложение клиенту: «{state.offer.title}» за {fmtMoney(state.offer.price)}, засчитывается {fmtMoney(state.offer.credit)}, доплата {fmtMoney(state.offer.toPay)}.
        </div>
      )}

      <h3 style={{ margin: '14px 0 6px', fontSize: 14 }}>Выданные проверки ({state.checks.length})</h3>
      {state.checks.length === 0 && <div className="row-meta">Пока ни одной — их присылает приложение NVizor после выдачи отчёта.</div>}
      {state.checks.slice(0, 50).map((c) => {
        const owner = ents.find((e) => e.id === c.entitlementId)
        return (
          <div className="row-meta" key={c.id}>
            {ru(String(c.issuedAt).slice(0, 10))} · {c.reportNumber || 'без номера'} · {c.kind === 'recheck' ? 'повторная' : 'первичная'}
            {c.stageCode ? ` · этап ${c.stageCode}` : ''} · {c.photos} фото{c.videos ? `, ${c.videos} видео` : ''}
            {' · '}{owner ? owner.title : 'вне тарифа'}
          </div>
        )
      })}

      <h3 style={{ margin: '14px 0 6px', fontSize: 14 }}>Личные ссылки в кабинет</h3>
      <div className="row-line">
        <div className="row-meta">
          Действующих: {state.links.active}{state.links.lastCreatedAt ? ` · последняя выпущена ${relTime(state.links.lastCreatedAt)}` : ''}
        </div>
        <span style={{ display: 'flex', gap: 6 }}>
          <button className="btn" style={{ minHeight: 30, fontSize: 12 }} onClick={issueLink}>Выпустить</button>
          {state.links.active > 0 && <button className="btn danger" style={{ minHeight: 30, fontSize: 12 }} onClick={revokeAll}>Отозвать все</button>}
        </span>
      </div>
      {link && (
        <div className="crm-cap" style={{ overflowWrap: 'anywhere' }}>
          Ссылка (показывается один раз — CRM хранит только её отпечаток): <b>{link}</b>{' '}
          <button className="btn" style={{ minHeight: 26, fontSize: 12 }} onClick={() => navigator.clipboard?.writeText(link).then(() => toast('Скопировано'))}>Копировать</button>
        </div>
      )}

      {form && <EntitlementForm initial={form} plans={state.plans} stages={state.stages} onSave={save} onClose={() => setForm(null)} />}
    </section>
  )
}
