// Clock-out and break reminders in the TYMRAK phone app (does nothing on the website).
// They are planned on the phone from the employee's current clock state, every time the
// clock screen loads it, so a punch from another device or a manager's correction is picked
// up the next time the app opens:
//   - still clocked in CLOCK_OUT_AFTER_HOURS after clocking in  -> "Still clocked in?"
//   - still on break BREAK_AFTER_MINUTES after starting it      -> "Still on break?"
// Clocking out (or ending the break) cancels them. The phone asks for permission the first
// time a reminder is needed, and the employee can turn reminders off on the clock screen.

export const CLOCK_OUT_AFTER_HOURS = 10;
export const BREAK_AFTER_MINUTES = 60;
export const REMINDER_IDS = { clockOut: 7101, longBreak: 7102 };
const OFF_KEY = "tymrak-reminders-off";

export function remindersPlugin(scope = globalThis) {
  const capacitor = scope?.Capacitor;
  if (!capacitor || typeof capacitor.isNativePlatform !== "function" || !capacitor.isNativePlatform()) return null;
  const plugin = capacitor.Plugins?.LocalNotifications;
  return plugin && typeof plugin.schedule === "function" ? plugin : null;
}

function storageOf(scope) { try { return scope.localStorage || null; } catch { return null; } }
export function remindersOn(scope = globalThis) { return storageOf(scope)?.getItem(OFF_KEY) !== "1"; }
export function setRemindersOn(on, scope = globalThis) {
  const storage = storageOf(scope);
  if (!storage) return;
  if (on) storage.removeItem(OFF_KEY); else storage.setItem(OFF_KEY, "1");
}

const at = iso => new Date(iso).getTime();
const timeText = (ms, timeZone) => new Date(ms).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) });

// What to remind about, given the clock screen's state. Only future reminders are planned.
export function planReminders({ status, punches = [], lastPunch = null, timeZone, now = Date.now() }) {
  const plan = [];
  if (status === "working") {
    const clockIns = punches.filter(p => p.punch_type === "clock_in").map(p => at(p.punched_at)).filter(Number.isFinite);
    const start = clockIns.length ? Math.max(...clockIns) : null;
    const when = start === null ? null : start + CLOCK_OUT_AFTER_HOURS * 3600000;
    if (when && when > now) plan.push({ id: REMINDER_IDS.clockOut, at: when, title: "Still clocked in?",
      body: `You clocked in at ${timeText(start, timeZone)} and haven't clocked out. Open TYMRAK if you've finished work.` });
  } else if (status === "on_break" && lastPunch?.punch_type === "break_start") {
    const start = at(lastPunch.punched_at);
    const when = start + BREAK_AFTER_MINUTES * 60000;
    if (Number.isFinite(when) && when > now) plan.push({ id: REMINDER_IDS.longBreak, at: when, title: "Still on break?",
      body: `Your break started at ${timeText(start, timeZone)} and hasn't ended. Open TYMRAK when you're back.` });
  }
  return plan;
}

const allIds = () => Object.values(REMINDER_IDS).map(id => ({ id }));

export async function clearReminders(scope = globalThis) {
  const plugin = remindersPlugin(scope);
  if (!plugin) return "unsupported";
  try { await plugin.cancel({ notifications: allIds() }); } catch { /* nothing scheduled */ }
  return "cleared";
}

// Replaces any planned reminders with the ones for this state. Never throws.
export async function syncReminders(state, scope = globalThis) {
  const plugin = remindersPlugin(scope);
  if (!plugin) return "unsupported";
  try {
    await plugin.cancel({ notifications: allIds() }).catch(() => {});
    if (!remindersOn(scope)) return "off";
    const plan = planReminders({ ...state, now: state.now ?? Date.now() });
    if (!plan.length) return "none";
    let permission = (await plugin.checkPermissions())?.display;
    if (permission === "prompt" || permission === "prompt-with-rationale") permission = (await plugin.requestPermissions())?.display;
    if (permission !== "granted") return "denied";
    await plugin.schedule({ notifications: plan.map(item => ({ id: item.id, title: item.title, body: item.body, schedule: { at: new Date(item.at), allowWhileIdle: true } })) });
    return "scheduled";
  } catch {
    return "error";
  }
}

// A small "Clock-out reminders" switch, shown only in the phone app.
export function mountReminderSetting(container, onChange, scope = globalThis) {
  if (!container || !remindersPlugin(scope)) return null;
  const doc = container.ownerDocument;
  const label = doc.createElement("label");
  label.className = "reminder-setting";
  const box = doc.createElement("input");
  box.type = "checkbox";
  box.checked = remindersOn(scope);
  const text = doc.createElement("span");
  text.textContent = `Remind me if I forget to clock out (after ${CLOCK_OUT_AFTER_HOURS} hours) or end a break (after ${BREAK_AFTER_MINUTES} minutes)`;
  label.append(box, text);
  box.addEventListener("change", () => { setRemindersOn(box.checked, scope); onChange?.(box.checked); });
  container.replaceChildren(label);
  container.hidden = false;
  return box;
}
