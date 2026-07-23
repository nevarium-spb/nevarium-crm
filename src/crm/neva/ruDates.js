// Русские относительные даты → YYYY-MM-DD в Europe/Moscow.
// Правило недели: «в пятницу» = ближайшая СЛЕДУЮЩАЯ пятница, сегодня исключается.
const WEEKDAYS = [
  ['воскресенье', 'воскресенья', 'вс'],
  ['понедельник', 'понедельника', 'пн'],
  ['вторник', 'вторника', 'вт'],
  ['среда', 'среду', 'среды', 'ср'],
  ['четверг', 'четверга', 'чт'],
  ['пятница', 'пятницу', 'пятницы', 'пт'],
  ['суббота', 'субботу', 'субботы', 'сб'],
]

export function mskToday(offsetDays = 0, nowMs = Date.now()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date(nowMs + offsetDays * 864e5))
}

function mskWeekday(nowMs = Date.now()) {
  const short = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Moscow', weekday: 'short' }).format(new Date(nowMs))
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(short)
}

// Возвращает { date, rest } — распознанную дату и текст без неё, либо null.
export function extractRuDate(text, nowMs = Date.now()) {
  const lower = text.toLowerCase()

  const simple = [
    [/(?:^|\s)послезавтра(?=\s|$|[.,])/u, 2],
    [/(?:^|\s)завтра(?=\s|$|[.,])/u, 1],
    [/(?:^|\s)сегодня(?=\s|$|[.,])/u, 0],
  ]
  for (const [re, offset] of simple) {
    const m = lower.match(re)
    if (m) return { date: mskToday(offset, nowMs), rest: cut(text, m) }
  }

  // DD.MM или DD.MM.YYYY
  const dm = lower.match(/(?:^|\s)(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?(?=\s|$|[.,])/u)
  if (dm) {
    const day = Number(dm[1]), month = Number(dm[2])
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      const today = mskToday(0, nowMs)
      let year = dm[3] ? Number(dm[3]) : Number(today.slice(0, 4))
      let date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      if (!dm[3] && date < today) date = `${year + 1}${date.slice(4)}`
      return { date, rest: cut(text, dm) }
    }
  }

  // дни недели, опционально с предлогом «в/во»
  for (let dow = 0; dow < 7; dow++) {
    for (const word of WEEKDAYS[dow]) {
      const re = new RegExp(`(?:^|\\s)(?:во?\\s+)?${word}(?=\\s|$|[.,])`, 'u')
      const m = lower.match(re)
      if (m) {
        const todayDow = mskWeekday(nowMs)
        let diff = (dow - todayDow + 7) % 7
        if (diff === 0) diff = 7 // сегодняшний день недели → следующая неделя
        return { date: mskToday(diff, nowMs), rest: cut(text, m) }
      }
    }
  }

  return null
}

function cut(text, match) {
  return (text.slice(0, match.index) + ' ' + text.slice(match.index + match[0].length)).replace(/\s+/g, ' ').trim()
}
