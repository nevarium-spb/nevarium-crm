import { useEffect, useSyncExternalStore } from 'react'

// ---------- тосты (модульный стор, доступен из любого места) ----------
let toasts = []
let listeners = new Set()
let toastId = 0
const emit = () => listeners.forEach((l) => l())

export function toast(text, kind = 'info') {
  const id = ++toastId
  toasts = [...toasts, { id, text, kind }]
  emit()
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id)
    emit()
  }, 4000)
}

export function apiErrorToast(err) {
  if (err?.kind === 'network') toast('Нет связи с сервером', 'error')
  else if (err?.kind === 'conflict') toast('Запись изменена в другом окне — обновите', 'error')
  else if (err?.kind !== 'unauthorized') toast('Ошибка сервера', 'error')
}

export function Toasts() {
  const items = useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => toasts
  )
  return (
    <div className="crm-toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`crm-toast${t.kind === 'error' ? ' error' : ''}`}>{t.text}</div>
      ))}
    </div>
  )
}

// ---------- модалка ----------
export function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="crm-modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="crm-modal" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  )
}

// ---------- форматирование ----------
export const fmtMoney = (n) =>
  n == null ? '— ₽' : `${Number(n).toLocaleString('ru-RU')} ₽`

export function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

export function relTime(iso) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.round(diff / 60000)
  if (min < 1) return 'только что'
  if (min < 60) return `${min} мин назад`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} ч назад`
  const d = Math.round(h / 24)
  return d === 1 ? 'вчера' : `${d} дн назад`
}

export { mskToday as mskTodayStr } from './neva/ruDates.js'

// ---------- сигнал «данные изменились» (палитра → открытая страница) ----------
const refreshListeners = new Set()
export function emitRefresh() {
  refreshListeners.forEach((cb) => cb())
}
export function onRefresh(cb) {
  refreshListeners.add(cb)
  return () => refreshListeners.delete(cb)
}
