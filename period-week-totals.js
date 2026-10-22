// Group ISO local-calendar dates into configured workweeks for display only.
export function groupPeriodWeeks(days, startKey, endKey, weekStartDay = 0) {
  const parse = key => new Date(key + "T12:00:00Z");
  const keyOf = date => date.toISOString().slice(0, 10);
  const cursor = parse(startKey), end = parse(endKey);
  cursor.setUTCDate(cursor.getUTCDate() - ((cursor.getUTCDay() - Number(weekStartDay) + 7) % 7));
  const byDate = new Map(days.map(day => [day.dateKey || day.date, day]));
  const weeks = [];
  while (cursor <= end) {
    const weekStart = keyOf(cursor), last = new Date(cursor);
    last.setUTCDate(last.getUTCDate() + 6);
    const weekEnd = keyOf(last);
    const visibleStart = weekStart < startKey ? startKey : weekStart;
    const visibleEnd = weekEnd > endKey ? endKey : weekEnd;
    const entries = [...byDate].filter(([date]) => date >= visibleStart && date <= visibleEnd)
      .sort(([a], [b]) => a.localeCompare(b)).map(([, day]) => day);
    const sum = field => entries.reduce((n, day) => n + (Number(day[field]) || 0), 0);
    weeks.push({ weekStart, weekEnd, visibleStart, visibleEnd, entries,
      workedMilliseconds: sum("workedMilliseconds"),
      regularMilliseconds: sum("regularMilliseconds"),
      overtimeMilliseconds: sum("overtimeMilliseconds") });
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  const sum = field => weeks.reduce((n, week) => n + week[field], 0);
  return { weeks, totals: { workedMilliseconds: sum("workedMilliseconds"),
    regularMilliseconds: sum("regularMilliseconds"),
    overtimeMilliseconds: sum("overtimeMilliseconds") } };
}
