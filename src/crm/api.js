// Единая обёртка над fetch: 401 → выход на логин, 409 → конфликт,
// сеть → typed error. Никакой обработки ошибок в компонентах напрямую.
let onUnauthorized = null
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn
}

export class ApiError extends Error {
  constructor(kind, extra = {}) {
    super(kind)
    this.kind = kind
    Object.assign(this, extra)
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  let res
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError('network')
  }
  if (res.status === 401) {
    onUnauthorized?.()
    throw new ApiError('unauthorized')
  }
  if (res.status === 409) throw new ApiError('conflict', { data: await res.json().catch(() => null) })
  if (res.status === 429) throw new ApiError('throttled', { data: await res.json().catch(() => null) })
  if (!res.ok) throw new ApiError('error', { status: res.status, data: await res.json().catch(() => null) })
  if (res.status === 204) return null
  return res.json()
}

export const repo = {
  // project: slug проекта либо 'all'/пусто — «все проекты» (фильтр не отправляем)
  list: (entity, { q, project } = {}) => {
    const p = new URLSearchParams()
    if (q) p.set('q', q)
    if (project && project !== 'all') p.set('project', project)
    const qs = p.toString()
    return api(`/crm/${entity}${qs ? `?${qs}` : ''}`)
  },
  projects: () => api('/crm/projects'),
  create: (entity, data) => api(`/crm/${entity}`, { method: 'POST', body: data }),
  update: (entity, id, data) => api(`/crm/${entity}/${id}`, { method: 'PATCH', body: data }),
  remove: (entity, id) => api(`/crm/${entity}/${id}`, { method: 'DELETE' }),
  contactCard: (id) => api(`/crm/contacts/${id}`),
  dashboard: ({ project } = {}) => api(`/crm/dashboard${project && project !== 'all' ? `?project=${encodeURIComponent(project)}` : ''}`),
  diagnostics: () => api('/crm/diagnostics'),
}
