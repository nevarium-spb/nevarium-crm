// Выбор проекта: общий для всех страниц CRM.
// Список проектов меняется крайне редко, поэтому грузим его один раз за сессию
// и держим в модульном кэше — иначе каждая страница дёргала бы API заново.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { repo } from './api.js'

const STORAGE_KEY = 'nv-crm-project'

let cache = null
let inflight = null

export function loadProjects() {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = repo
      .projects()
      .then((r) => {
        cache = r.items
        inflight = null
        return cache
      })
      .catch((err) => {
        inflight = null
        throw err
      })
  }
  return inflight
}

/** Короткое имя для бейджа: префикс «Невариум» общий для всех и только занимает место. */
export const shortProject = (name) => String(name || '').replace(/^Невариум\s+/i, '')

/**
 * Выбранный проект — один на всю CRM и переживает перезагрузку:
 * переключился на «Визор» в контактах — он же останется в сделках.
 */
export function useProjectFilter() {
  const [project, setState] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || 'all'
    } catch {
      return 'all'
    }
  })
  const setProject = useCallback((slug) => {
    setState(slug)
    try {
      localStorage.setItem(STORAGE_KEY, slug)
    } catch {
      /* приватный режим — просто не запоминаем */
    }
  }, [])
  return [project, setProject]
}

export function useProjects() {
  const [projects, setProjects] = useState(cache || [])
  useEffect(() => {
    let alive = true
    loadProjects()
      .then((list) => alive && setProjects(list))
      .catch(() => {
        /* фильтр не критичен: без списка просто не покажем переключатель */
      })
    return () => {
      alive = false
    }
  }, [])
  return projects
}

/** Переключатель проектов. При единственном проекте не показывается — нечего выбирать. */
export function ProjectFilter({ value, onChange }) {
  const projects = useProjects()
  if (projects.length < 2) return null
  return (
    <div className="proj-filter" role="group" aria-label="Фильтр по проекту">
      <button type="button" className={value === 'all' ? 'on' : ''} onClick={() => onChange('all')} aria-pressed={value === 'all'}>
        Все
      </button>
      {projects.map((p) => (
        <button
          key={p.slug}
          type="button"
          className={value === p.slug ? 'on' : ''}
          onClick={() => onChange(p.slug)}
          aria-pressed={value === p.slug}
          title={p.display_name}
        >
          {shortProject(p.display_name)}
        </button>
      ))}
    </div>
  )
}

/**
 * Бейдж проекта на карточке. Показываем только в режиме «Все»: когда список
 * уже отфильтрован, бейдж повторял бы одно и то же в каждой строке.
 */
export function ProjectBadge({ id, when = true }) {
  const projects = useProjects()
  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  if (!when) return null
  const project = byId.get(id)
  if (!project) return null
  return <span className="badge proj">{shortProject(project.display_name)}</span>
}
