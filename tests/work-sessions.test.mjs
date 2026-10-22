import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkSessions, summarizeSessions } from "../work-sessions.js";
const punch=(type,time)=>({punch_type:type,punched_at:`2026-10-21T${time}:00Z`});
test("split shifts exclude off-clock gaps",()=>{
  const sessions=buildWorkSessions([punch("clock_in","10:00"),punch("clock_out","11:00"),punch("clock_in","15:00"),punch("clock_out","15:30")]);
  assert.equal(sessions.length,2);
  assert.deepEqual(sessions.map(s=>s.workedMilliseconds),[3600000,1800000]);
  assert.equal(summarizeSessions(sessions).workedMilliseconds,5400000);
});
test("break time excluded",()=>{
  const sessions=buildWorkSessions([punch("clock_in","10:00"),punch("break_start","10:30"),punch("break_end","10:45"),punch("clock_out","11:00")]);
  assert.equal(sessions[0].workedMilliseconds,2700000);
});
test("unmatched punches flagged",()=>{
  const sessions=buildWorkSessions([punch("clock_out","09:00"),punch("clock_in","10:00")],Date.parse("2026-10-21T10:30:00Z"));
  assert.equal(sessions.length,2);
  assert.equal(summarizeSessions(sessions).missingPunch,true);
  assert.equal(sessions[1].workedMilliseconds,1800000);
});
test("repeated clock in does not count time between sessions",()=>{
  const sessions=buildWorkSessions([punch("clock_in","10:00"),punch("clock_in","12:00"),punch("clock_out","12:30")]);
  assert.equal(sessions[0].missingPunch,true);
  assert.equal(sessions[0].workedMilliseconds,0);
  assert.equal(sessions[1].workedMilliseconds,1800000);
});
