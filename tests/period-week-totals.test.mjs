import test from "node:test";
import assert from "node:assert/strict";
import { groupPeriodWeeks } from "../period-week-totals.js";
const ms = hours => hours * 3600000;
test("partial semi-monthly weeks, weekly overtime and grand total", () => {
  const days = [
    ["2026-10-19",8,8,0],["2026-10-20",7,7,0],["2026-10-21",8,8,0],
    ["2026-10-22",8,8,0],["2026-10-23",8,8,0],["2026-10-24",7,5,2]
  ].map(([date,worked,regular,overtime]) => ({
    date, workedMilliseconds:ms(worked), regularMilliseconds:ms(regular),
    overtimeMilliseconds:ms(overtime)
  }));
  const { weeks, totals } = groupPeriodWeeks(days,"2026-10-16","2026-10-31",0);
  assert.equal(weeks.length,3);
  assert.deepEqual(weeks.map(w=>w.workedMilliseconds),[0,ms(46),0]);
  assert.equal(totals.workedMilliseconds,ms(46));
  assert.equal(totals.regularMilliseconds,ms(44));
  assert.equal(totals.overtimeMilliseconds,ms(2));
});
test("empty period still shows partial weeks and zero grand total",()=>{
  const result=groupPeriodWeeks([],"2026-10-16","2026-10-31",0);
  assert.equal(result.weeks.length,3);
  assert.equal(result.totals.workedMilliseconds,0);
});
test("week start configuration changes grouping",()=>{
  const days=[{dateKey:"2026-10-18",workedMilliseconds:ms(2),regularMilliseconds:ms(2),overtimeMilliseconds:0}];
  const sunday=groupPeriodWeeks(days,"2026-10-16","2026-10-31",0);
  const monday=groupPeriodWeeks(days,"2026-10-16","2026-10-31",1);
  assert.equal(sunday.weeks[1].workedMilliseconds,ms(2));
  assert.equal(monday.weeks[0].workedMilliseconds,ms(2));
});
