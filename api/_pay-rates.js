// Hourly rates and estimated gross pay. Pure functions: no network or database access.
//
// A rate applies from its start date until the next rate starts. Pay is worked out day by
// day, so a raise in the middle of a pay period is paid correctly on each side of it.
// Overtime and double time use the multipliers of the province's overtime rule.

const HOUR = 3600000;

export function rateOn(rates, dateKey) {
  let found = null;
  for (const rate of rates) if (rate.effective_from <= dateKey && (!found || rate.effective_from > found.effective_from)) found = rate;
  return found;
}

const multiplier = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

// days: [{date, regularMilliseconds, overtimeMilliseconds, doubleTimeMilliseconds}]
export function estimatePay(days, rates, rule, period) {
  const overtimeMultiplier = multiplier(rule?.overtime_multiplier, 1.5);
  const doubleTimeMultiplier = multiplier(rule?.double_time_multiplier, 2);
  const ratesUsed = new Map();
  let regularCents = 0, overtimeCents = 0, doubleTimeCents = 0, unpricedMs = 0;
  for (const day of days) {
    const worked = (day.regularMilliseconds || 0) + (day.overtimeMilliseconds || 0) + (day.doubleTimeMilliseconds || 0);
    if (!worked) continue;
    const rate = rateOn(rates, day.date);
    if (!rate) { unpricedMs += worked; continue; }
    const cents = Number(rate.hourly_rate) * 100;
    ratesUsed.set(rate.effective_from, Number(rate.hourly_rate));
    regularCents += (day.regularMilliseconds || 0) / HOUR * cents;
    overtimeCents += (day.overtimeMilliseconds || 0) / HOUR * cents * overtimeMultiplier;
    doubleTimeCents += (day.doubleTimeMilliseconds || 0) / HOUR * cents * doubleTimeMultiplier;
  }
  const current = period ? rateOn(rates, period.endKey) : null;
  const dollars = cents => Math.round(cents) / 100;
  return {
    hourlyRate: current ? Number(current.hourly_rate) : null,
    rateSince: current?.effective_from || null,
    rateChangedInPeriod: ratesUsed.size > 1,
    overtimeMultiplier, doubleTimeMultiplier,
    regularPay: dollars(regularCents), overtimePay: dollars(overtimeCents), doubleTimePay: dollars(doubleTimeCents),
    estimatedGross: dollars(Math.round(regularCents) + Math.round(overtimeCents) + Math.round(doubleTimeCents)),
    hoursWithoutRate: Math.round(unpricedMs / 36000) / 100
  };
}

export function parseRate(value) {
  const text = String(value ?? "").trim().replace(/^\$/, "");
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(text)) return null;
  const rate = Number(text);
  return rate > 0 && rate < 10000 ? Math.round(rate * 100) / 100 : null;
}
