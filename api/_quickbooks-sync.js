// Pure QuickBooks sync logic: matching employees and turning an approved timecard into
// QuickBooks time entries. No network or database access here.

const normalize = value => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");

// Suggested matches for employees who are not matched yet: same email first, then the same
// full name, and only when exactly one QuickBooks employee fits and is not already taken.
export function suggestMatches(employees, quickBooksEmployees, existingLinks = []) {
  const taken = new Set(existingLinks.map(link => String(link.external_id)));
  const linked = new Set(existingLinks.map(link => link.employee_id));
  const byEmail = new Map(), byName = new Map();
  for (const person of quickBooksEmployees) {
    if (taken.has(person.id)) continue;
    const email = normalize(person.email);
    if (email) byEmail.set(email, [...(byEmail.get(email) || []), person]);
    for (const name of new Set([normalize(person.name), normalize(`${person.givenName} ${person.familyName}`)])) {
      if (name) byName.set(name, [...(byName.get(name) || []), person]);
    }
  }
  const suggestions = [], used = new Set();
  for (const employee of employees) {
    if (linked.has(employee.id)) continue;
    const emailMatches = byEmail.get(normalize(employee.email)) || [];
    const nameMatches = [...new Map((byName.get(normalize(`${employee.first_name} ${employee.last_name}`)) || []).map(p => [p.id, p])).values()];
    const [person, matchedBy] = emailMatches.length === 1 ? [emailMatches[0], "email"]
      : nameMatches.length === 1 ? [nameMatches[0], "name"] : [null, null];
    if (person && !used.has(person.id)) {
      used.add(person.id);
      suggestions.push({ employeeId: employee.id, externalId: person.id, externalName: person.name, matchedBy });
    }
  }
  return suggestions;
}

const minutesOf = milliseconds => Math.round((milliseconds || 0) / 60000);

// The time entries for one approved timecard. First version: regular hours are sent, one
// entry per day; overtime and double time are listed for the admin to enter in QuickBooks
// payroll, so no overtime is ever paid at the regular rate by mistake.
export function timecardEntries(days) {
  const entries = [], manual = [];
  for (const day of days) {
    const regular = minutesOf(day.regularMilliseconds);
    if (regular > 0) entries.push({ date: day.date, minutes: regular });
    const overtime = minutesOf(day.overtimeMilliseconds), doubleTime = minutesOf(day.doubleTimeMilliseconds);
    if (overtime > 0) manual.push({ date: day.date, kind: "overtime", minutes: overtime });
    if (doubleTime > 0) manual.push({ date: day.date, kind: "double_time", minutes: doubleTime });
  }
  return { entries, manual };
}

export function timeActivity(entry, externalEmployeeId, period) {
  return {
    TxnDate: entry.date,
    NameOf: "Employee",
    EmployeeRef: { value: String(externalEmployeeId) },
    Hours: Math.floor(entry.minutes / 60),
    Minutes: entry.minutes % 60,
    BillableStatus: "NotBillable",
    Description: `Tymrak: regular hours (approved pay period ${period.startKey} to ${period.endKey})`
  };
}

// Days still to send, given the entries already created for this timecard.
export function missingEntries(entries, alreadySent = []) {
  const sent = new Set(alreadySent.map(entry => entry.date));
  return entries.filter(entry => !sent.has(entry.date));
}

export function formatMinutes(minutes) {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}
