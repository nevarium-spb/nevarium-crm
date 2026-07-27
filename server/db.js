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
