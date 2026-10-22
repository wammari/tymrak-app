// Pair individual work sessions without treating gaps between shifts as paid time.
// The caller supplies chronological punches; a session is attributed to its clock-in date.
export function buildWorkSessions(punches, now = Date.now()) {
  const sessions = [];
  let active = null;
  for (const punch of [...punches].sort((a,b) => Date.parse(a.punched_at)-Date.parse(b.punched_at))) {
    const time = Date.parse(punch.punched_at);
    if (!Number.isFinite(time)) continue;
    if (punch.punch_type === "clock_in") {
      if (active) { active.missingPunch = true; sessions.push(finish(active)); }
      active = { clockIn:punch.punched_at, clockOut:null, location:punch.location_name || "—",
        workedMilliseconds:0, started:time, breakStarted:null, missingPunch:false, punches:[punch] };
      continue;
    }
    if (!active) {
      sessions.push({ clockIn:null, clockOut:punch.punch_type==="clock_out"?punch.punched_at:null,
        location:punch.location_name||"—",workedMilliseconds:0,missingPunch:true,punches:[punch] });
      continue;
    }
    active.punches.push(punch);
    if (punch.punch_type==="break_start" && active.started!==null) {
      active.workedMilliseconds+=Math.max(0,time-active.started);
      active.started=null;active.breakStarted=time;
    } else if (punch.punch_type==="break_end" && active.breakStarted!==null) {
      active.breakStarted=null;active.started=time;
    } else if (punch.punch_type==="clock_out") {
      if (active.started!==null) active.workedMilliseconds+=Math.max(0,time-active.started);
      active.clockOut=punch.punched_at;
      sessions.push(finish(active));active=null;
    }
  }
  if (active) {
    active.missingPunch=true;
    if (active.started!==null) active.workedMilliseconds+=Math.max(0,now-active.started);
    sessions.push(finish(active));
  }
  return sessions;
}
function finish(session) {
  const { started, breakStarted, ...publicSession }=session;
  return publicSession;
}
export function summarizeSessions(sessions) {
  return { workedMilliseconds:sessions.reduce((sum,s)=>sum+s.workedMilliseconds,0),
    missingPunch:sessions.some(s=>s.missingPunch) };
}
