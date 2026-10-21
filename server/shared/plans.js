// Тарифы — ОДИН источник цифр для сайта и CRM (решение владельца 2026-10-15: «цены в одном
// месте»). Раньше цены жили дважды — в PRICING сайта (src/data/site.js) и в PLANS CRM
// (server/entitlements.js), и смена цены на сайте не доходила до расчёта зачёта в CRM.
//
// Файл лежит в двух репозиториях байт-в-байт одинаковым:
//   G:\nevarium_vizor\src\shared\plans.js        ← источник истины, правят здесь
//   G:\nevarium-crm\server\shared\plans.js       ← копия, CRM импортирует её
// После правки: `npm run shared:sync` (копирует), `npm run shared:check` (сверяет).
// Тест src/shared/plans.test.js сверяет с этим файлом карточки PRICING сайта — тексты
// карточек пишет владелец, а цифры в них обязаны совпадать с цифрами здесь.
//
// Ограничения файла: без импортов и без TypeScript (его подключают и Vite, и Node CRM).
// Коды тарифов и этапов — из контракта docs/SUBSCRIPTIONS.md, раздел 2.

/** Тарифы: название, цена в рублях; у пакетов — число этапов и цена этапа в пакете. */
export const PLANS = {
  stage: { title: 'Проверка этапа', price: 4990 },
  repair: { title: 'Ремонт под контролем', price: 19900, stages: 5, perStage: 3980 },
  house: { title: 'Дом под контролем', price: 29900, stages: 8, perStage: 3740 },
  monthly: { title: 'Объект помесячно', price: 14900 },
  company: { title: 'Компания', price: 11900 },
  recheck: { title: 'Повторная проверка', price: 1990 },
}

export const PACKAGE_PLANS = ['repair', 'house']
export const PERIOD_PLANS = ['monthly', 'company']

/** Этапы пакетов: [код, название]. Названия — как в карточках пакетов на сайте. */
export const STAGES = {
  repair: [
    ['electrical', 'электрика'], ['plumbing', 'сантехника'], ['waterproofing', 'гидроизоляция'],
    ['screed', 'стяжка'], ['plaster', 'штукатурка'],
  ],
  house: [
    ['base', 'основание'], ['foundation_rebar', 'армирование фундамента'],
    ['foundation', 'фундамент после распалубки'], ['walls', 'стены'], ['floors', 'перекрытия'],
    ['roof', 'кровля'], ['windows', 'окна и утепление'], ['engineering', 'инженерные системы'],
  ],
}

/** Лимиты проверки (раздел 4 контракта). */
export const LIMITS = {
  photos: 30,
  freePhotos: 5,
  recheckPhotos: 10,
  videos: 2,
  recheckWorkdays: 3,
  expiringSoonDays: 3,
  checksPerPeriod: 4,
  periodDays: 30,
}

/**
 * Доплаты к проверке: срочно за 6 часов и в выходные (решение владельца 2026-10-20, ADR-024 CRM):
 * за КАЖДУЮ такую проверку, в том числе внутри пакетов; срочная и выходная не складываются —
 * срочная в выходной стоит одну срочную доплату.
 */
export const EXTRAS = { urgent: 3500, weekend: 2000 }

/** Цена в формате сайта: 19900 → «19 900 ₽» (обычный пробел — как в PRICING). */
export function rub(n) {
  return `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ₽`
}
