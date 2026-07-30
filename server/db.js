import Database from 'better-sqlite3'
export { STAGES, TERMINAL_STAGES } from '../src/shared/stages.js'

// Порядок миграций фиксирован; PRAGMA user_version хранит номер последней применённой.
// Экспортируется, чтобы тесты могли поднять базу в состоянии «до миграции».
export const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    token_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    company TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    messenger TEXT DEFAULT '',
    note TEXT DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    suspicious INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by INTEGER
  );
  CREATE TABLE deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL REFERENCES contacts(id),
    title TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT 'Новый',
    amount INTEGER,
    note TEXT DEFAULT '',
    closed_at TEXT,
    demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by INTEGER
  );
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    contact_id INTEGER REFERENCES contacts(id),
    deal_id INTEGER REFERENCES deals(id),
    due_date TEXT,
    done INTEGER NOT NULL DEFAULT 0,
    done_at TEXT,
    demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by INTEGER
  );
  CREATE TABLE interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL REFERENCES contacts(id),
    deal_id INTEGER REFERENCES deals(id),
    type TEXT NOT NULL DEFAULT 'другое',
    note TEXT DEFAULT '',
    happened_at TEXT NOT NULL,
    demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by INTEGER
  );
  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    sent_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_deals_contact ON deals(contact_id);
  CREATE INDEX idx_deals_stage ON deals(stage);
  CREATE INDEX idx_tasks_contact ON tasks(contact_id);
  CREATE INDEX idx_tasks_due ON tasks(due_date);
  CREATE INDEX idx_interactions_contact ON interactions(contact_id);
  CREATE INDEX idx_outbox_pending ON outbox(sent_at) WHERE sent_at IS NULL;
  `,
  // v2: списки сортируются по updated_at — без индекса это full scan на каждый запрос
  `
  CREATE INDEX idx_contacts_updated ON contacts(updated_at);
  CREATE INDEX idx_deals_updated ON deals(updated_at);
  CREATE INDEX idx_tasks_updated ON tasks(updated_at);
  CREATE INDEX idx_interactions_updated ON interactions(updated_at);
  CREATE INDEX idx_contacts_inbox ON contacts(source, archived, created_at);
  `,
  // v3: мультипроектность — заявки разных бизнесов в одном инбоксе.
  // project_id объявлен NOT NULL DEFAULT 1 БЕЗ REFERENCES намеренно: SQLite запрещает
  // ADD COLUMN с REFERENCES и ненулевым дефолтом («Cannot add a REFERENCES column with
  // non-NULL default value»), а nullable-колонка допускала бы заявку без проекта — такая
  // выпала бы из отфильтрованного инбокса, то есть потерялась. Гарантия «у каждой заявки
  // есть проект» важнее ссылочной целостности: проекты не удаляются (UI для этого нет).
  // Существующие строки дефолт проставляет сам — отдельный backfill не нужен.
  `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  INSERT INTO projects (id, slug, display_name, created_at) VALUES
    (1, 'nevarium1', 'Невариум Лаб ИИ', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    (2, 'nevarium-vizor', 'Невариум Визор', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  ALTER TABLE contacts ADD COLUMN project_id INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE deals ADD COLUMN project_id INTEGER NOT NULL DEFAULT 1;
  CREATE INDEX idx_contacts_project ON contacts(project_id, archived, created_at);
  CREATE INDEX idx_deals_project ON deals(project_id, stage);
  `,
  // v4: origins проекта — источники, с которых принимаются заявки.
  // Один список решает две задачи: CORS-допуск публичного /api/leads и
  // определение проекта по домену сайта (запасной путь, если форма не
  // передала project). Через запятую, без слеша на конце, в нижнем регистре.
  // У Визора пусто: сайт ещё не развёрнут, домен неизвестен — заполнить перед
  // подключением его форм, иначе браузер заблокирует отправку (CORS).
  `
  ALTER TABLE projects ADD COLUMN origins TEXT NOT NULL DEFAULT '';
  UPDATE projects SET origins = 'https://nevarium-lab.ru,https://www.nevarium-lab.ru,https://nevarium1.vercel.app'
    WHERE slug = 'nevarium1';
  `,
  // v5: домен сайта Визора стал известен. Заводим оба варианта — с www и без:
  // лишний origin безвреден (просто никогда не совпадёт), а недостающий тихо
  // ломает отправку формы. Если сайт будет ещё и на *.vercel.app — дописать туда же.
  `
  UPDATE projects SET origins = 'https://nevarium-vizor.ru,https://www.nevarium-vizor.ru'
    WHERE slug = 'nevarium-vizor';
  `,
  // v6: воронка возврата («отказы»). Когда сделка уходит в «Проиграно», CRM заводит
  // серию задач-напоминаний на 2 месяца: связаться с клиентом и узнать, не изменилось
  // ли что-то. Писем не шлём — только задачи менеджеру (почтового сервиса у нас нет).
  //
  // tasks.winback_sequence_id объявлен БЕЗ REFERENCES по той же причине, что и
  // project_id в v3: SQLite не даёт добавить колонку с REFERENCES иначе как с
  // DEFAULT NULL, а здесь дефолт NULL как раз и нужен (обычные задачи вне серий) —
  // но ради единообразия и простоты чтения оставляем без внешнего ключа, целостность
  // держит приложение: серия удаляется вместе со своими задачами в одной транзакции.
  `
  CREATE TABLE winback_sequences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_id INTEGER NOT NULL REFERENCES deals(id),
    contact_id INTEGER NOT NULL REFERENCES contacts(id),
    reason TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    started_at TEXT NOT NULL,
    finished_at TEXT,
    created_by INTEGER
  );
  ALTER TABLE tasks ADD COLUMN winback_sequence_id INTEGER;
  CREATE INDEX idx_winback_deal ON winback_sequences(deal_id, status);
  CREATE INDEX idx_tasks_winback ON tasks(winback_sequence_id);
  `,
  // v7: уведомления теперь уходят в Telegram и MAX параллельно, независимо друг от
  // друга — падение одного канала не должно ни блокировать другой, ни требовать
  // повторной отправки туда, куда уже доставлено. Переименовываем старые
  // sent_at/attempts/last_error в tg_* (RENAME COLUMN переносит и определение
  // индекса — проверено) и заводим симметричные max_*.
  `
  ALTER TABLE outbox RENAME COLUMN sent_at TO tg_sent_at;
  ALTER TABLE outbox RENAME COLUMN attempts TO tg_attempts;
  ALTER TABLE outbox RENAME COLUMN last_error TO tg_last_error;
  ALTER TABLE outbox ADD COLUMN max_sent_at TEXT;
  ALTER TABLE outbox ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE outbox ADD COLUMN max_last_error TEXT;
  CREATE INDEX idx_outbox_pending_max ON outbox(max_sent_at) WHERE max_sent_at IS NULL;
  `,
  // v8: исполнение прав субъекта ПДн (152-ФЗ ст. 14, 20, 21) — то, что политика на
  // сайтах уже публично обещает выполнять «в течение 10 рабочих дней». До этой миграции
  // обязательство было, а механизма не было. ADR-011.
  //
  // pd_requests.contact_id nullable намеренно: запрос с публичной формы приходит от
  // человека, которого ещё надо найти в базе по почте/телефону (он мог писать с другого
  // адреса). Несопоставленный запрос всё равно должен быть виден и иметь дедлайн —
  // иначе он потеряется, а срок идёт. project_id как у остальных: NOT NULL DEFAULT 1
  // без REFERENCES (см. причины в v3).
  //
  // audit_log: раньше audit() писал только в лог процесса, который на App Platform
  // теряется при передеплое. Для проверки РКН и для вопроса «кто удалил контакт»
  // нужен след в самой базе. user_email денормализован: пользователя могут удалить,
  // а запись в журнале обязана остаться читаемой.
  `
  CREATE TABLE pd_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER,
    kind TEXT NOT NULL DEFAULT 'delete',
    status TEXT NOT NULL DEFAULT 'new',
    requester TEXT DEFAULT '',
    note TEXT DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    project_id INTEGER NOT NULL DEFAULT 1,
    due_date TEXT NOT NULL,
    resolved_at TEXT,
    resolved_by INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    user_email TEXT DEFAULT '',
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id INTEGER,
    detail TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );
  ALTER TABLE contacts ADD COLUMN anonymized_at TEXT;
  CREATE INDEX idx_pd_open ON pd_requests(status, due_date);
  CREATE INDEX idx_pd_contact ON pd_requests(contact_id);
  CREATE INDEX idx_audit_created ON audit_log(created_at);
  CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
  `,
]

/**
 * Виды запросов субъекта ПДн — ровно то, что перечислено в п.7 политики на сайтах.
 * Ключи хранятся в pd_requests.kind, подписи показываются в интерфейсе.
 */
export const PD_REQUEST_KINDS = {
  access: 'узнать, какие данные есть',
  correct: 'исправить неточные данные',
  delete: 'отозвать согласие и удалить данные',
  stop: 'прекратить обработку',
}

/** Срок исполнения по 152-ФЗ и по обещанию в политике — 10 рабочих дней. */
export const PD_DEADLINE_WORKDAYS = 10

/**
 * Дедлайн = N рабочих дней от даты (только пн–пт).
 * Государственные праздники сознательно не учитываем: их даты каждый год переносятся
 * постановлением, и держать этот календарь в коде — источник тихих ошибок. Без них
 * дедлайн получается раньше законного, то есть в запас, а не в просрочку.
 */
export function addWorkdays(fromIsoDate, days = PD_DEADLINE_WORKDAYS) {
  const d = new Date(`${fromIsoDate}T00:00:00Z`)
  let left = days
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1)
    const weekday = d.getUTCDay()
    if (weekday !== 0 && weekday !== 6) left--
  }
  return d.toISOString().slice(0, 10)
}

/**
 * Расписание воронки возврата: через сколько дней после отказа ставим задачу.
 * Два месяца, три касания — чаще превращается в рутину, которую перестают замечать.
 */
export const WINBACK_STEPS = [
  { days: 7, title: 'Написать клиенту: уточнить причину отказа' },
  { days: 30, title: 'Позвонить клиенту: узнать, не изменилась ли ситуация' },
  { days: 60, title: 'Финальное касание: предложить вернуться к задаче' },
]

/** Проект по умолчанию для строк без явной привязки (совпадает с DEFAULT в схеме). */
export const DEFAULT_PROJECT_ID = 1

export function openDb(file) {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  const current = db.pragma('user_version', { simple: true })
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v])
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
  return db
}

export function now() {
  return new Date().toISOString()
}
