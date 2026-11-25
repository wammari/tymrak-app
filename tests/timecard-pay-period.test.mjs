import "./_test-environment.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
    applyOvertime,
    buildDailyRecords,
    selectOvertimeRuleForPeriod
} from "../timecard-calculation.js";
import * as payPeriods from "../pay-periods.js";
import { dateKey } from "../timecard-calculation.js";

const source =
    fs.readFileSync(
        new URL("../timecard.html", import.meta.url),
        "utf8"
    );

function extractFunction(name) {
    const start =
        source.indexOf(`function ${name}(`);

    assert.notEqual(
        start,
        -1,
        `Could not find ${name}`
    );

    const bodyStart =
        source.indexOf("{", start);

    let depth = 0;

    for (
        let index = bodyStart;
        index < source.length;
        index += 1
    ) {
        if (source[index] === "{") {
            depth += 1;
        } else if (source[index] === "}") {
            depth -= 1;

            if (depth === 0) {
                return source.slice(
                    start,
                    index + 1
                );
            }
        }
    }

    throw new Error(`Could not parse ${name}`);
}

const functionNames = [
    "toEmployeePeriod",
    "getCurrentPayPeriod",
    "getPreviousPayPeriod",
    "getNextPayPeriod",
    "canNavigateToPayPeriod",
    "formatDate",
    "getDatePartsInEmployeeTimeZone",
    "createDateInEmployeeTimeZone",
    "formatDuration"
];

// The page's own period functions, run with the shared pay-periods.js they import.
function pageFunctions(paySchedule) {
    return Function(
        "payPeriodFor", "previousPayPeriod", "nextPayPeriod", "dateKey", "paySchedule",
        `
        let employeeTimeZone = "America/Edmonton";
        let currentPayPeriod = null;
        ${functionNames.map(extractFunction).join("\n")}
        return {
            ${functionNames.join(",")}
        };
    `)(payPeriods.payPeriodFor, payPeriods.previousPayPeriod, payPeriods.nextPayPeriod, dateKey, paySchedule);
}

const functions = pageFunctions(payPeriods.DEFAULT_PAY_SCHEDULE);
functions.getPayPeriod = (year, month, half) =>
    functions.getCurrentPayPeriod(
        new Date(Date.UTC(year, month, half === 1 ? 10 : 20, 18))
    );

assert.match(
    source,
    /from "\.\/pay-periods\.js"/,
    "timecard.html must use the shared pay periods"
);

assert.match(
    source,
    /supabase\.rpc\(\s*"employee_pay_schedule",\s*\{ p_employee_id: employee\.id \}\s*\)/,
    "timecard.html must load the company's own pay schedule"
);

// The overtime rule and daily calculations now live in the shared module that the
// timecard page imports, so they are tested from there.
functions.selectOvertimeRuleForPeriod = selectOvertimeRuleForPeriod;

assert.match(
    source,
    /from "\.\/timecard-calculation\.js"/,
    "timecard.html must use the shared timecard calculation"
);

function assertPeriod(
    period,
    expectedStart,
    expectedEnd
) {
    assert.equal(
        functions.formatDate(period.start),
        expectedStart
    );
    assert.equal(
        functions.formatDate(period.end),
        expectedEnd
    );
}

const current =
    functions.getCurrentPayPeriod(
        new Date("2026-10-01T18:00:00.000Z")
    );

assertPeriod(
    current,
    "Oct 1, 2026",
    "Oct 15, 2026"
);

const septemberSecond =
    functions.getPreviousPayPeriod(current);

assertPeriod(
    septemberSecond,
    "Sep 16, 2026",
    "Sep 30, 2026"
);

const septemberFirst =
    functions.getPreviousPayPeriod(
        septemberSecond
    );

assertPeriod(
    septemberFirst,
    "Sep 1, 2026",
    "Sep 15, 2026"
);

assertPeriod(
    functions.getPreviousPayPeriod(
        septemberFirst
    ),
    "Aug 16, 2026",
    "Aug 31, 2026"
);

assertPeriod(
    functions.getPayPeriod(2026, 1, 2),
    "Feb 16, 2026",
    "Feb 28, 2026"
);

assertPeriod(
    functions.getPayPeriod(2028, 1, 2),
    "Feb 16, 2028",
    "Feb 29, 2028"
);

assert.equal(
    functions.canNavigateToPayPeriod(
        functions.getNextPayPeriod(current),
        current
    ),
    false
);

assert.equal(
    functions.canNavigateToPayPeriod(
        functions.getNextPayPeriod(
            septemberSecond
        ),
        current
    ),
    true
);

const historicalRule = {
    id: "historical",
    effective_from: "2026-01-01",
    effective_to: "2026-09-30"
};

const currentRule = {
    id: "current",
    effective_from: "2026-10-01",
    effective_to: null
};

assert.equal(
    functions.selectOvertimeRuleForPeriod(
        [historicalRule, currentRule],
        "2026-09-16",
        "2026-09-30"
    ).id,
    "historical"
);

assert.equal(
    functions.selectOvertimeRuleForPeriod(
        [historicalRule, currentRule],
        "2026-10-01",
        "2026-10-15"
    ).id,
    "current"
);

assert.throws(
    () =>
        functions.selectOvertimeRuleForPeriod(
            [historicalRule, currentRule],
            "2026-09-16",
            "2026-10-15"
        ),
    error =>
        error.code ===
        "OVERTIME_RULE_BOUNDARY"
);

assert.throws(
    () =>
        functions.selectOvertimeRuleForPeriod(
            [{
                id: "mid-period-change",
                effective_from: "2026-09-25",
                effective_to: null
            }],
            "2026-09-16",
            "2026-09-30"
        ),
    error =>
        error.code ===
        "OVERTIME_RULE_BOUNDARY"
);

const [calculatedShift] =
    applyOvertime(
        buildDailyRecords([
            {
                punch_type: "clock_in",
                punched_at:
                    "2026-09-28T14:00:00.000Z"
            },
            {
                punch_type: "clock_out",
                punched_at:
                    "2026-09-29T02:00:00.000Z"
            }
        ], "America/Edmonton"),
        {
            calculation_method: "greater_daily_or_weekly",
            daily_overtime_enabled: true,
            weekly_overtime_enabled: true,
            daily_threshold_hours: 8,
            weekly_threshold_hours: 44,
            week_start_day: 0
        }
    );

const shift = calculatedShift;

assert.equal(calculatedShift.date, "2026-09-28");

assert.equal(
    functions.formatDuration(
        shift.workedMilliseconds
    ),
    "12:00"
);

assert.equal(
    functions.formatDuration(
        calculatedShift.regularMilliseconds
    ),
    "08:00"
);

assert.equal(
    functions.formatDuration(
        calculatedShift.overtimeMilliseconds
    ),
    "04:00"
);

// A weekly company: periods run Monday to Sunday from its start date, and the page
// moves a week at a time without reaching into the future.
const weekly = pageFunctions({ frequency: "weekly", anchorDate: "2026-11-02" });
const thisWeek = weekly.getCurrentPayPeriod(new Date("2026-11-18T18:00:00.000Z"));
assert.equal(weekly.formatDate(thisWeek.start), "Nov 16, 2026");
assert.equal(weekly.formatDate(thisWeek.end), "Nov 22, 2026");
assert.equal(weekly.formatDate(weekly.getPreviousPayPeriod(thisWeek).start), "Nov 9, 2026");
assert.equal(weekly.canNavigateToPayPeriod(weekly.getNextPayPeriod(thisWeek), thisWeek), false);
assert.equal(weekly.canNavigateToPayPeriod(thisWeek, thisWeek), true);

// A company that switched from twice a month to every two weeks on Nov 16: the page
// shows the new two-week period and steps back into the old twice-a-month one.
const switched = pageFunctions(payPeriods.normalizePayTimeline([
    { pay_frequency: "semi_monthly", pay_period_anchor: null, effective_from: null },
    { pay_frequency: "biweekly", pay_period_anchor: "2026-11-16", effective_from: "2026-11-16" }
]));
const firstTwoWeeks = switched.getCurrentPayPeriod(new Date("2026-11-20T18:00:00.000Z"));
assert.equal(switched.formatDate(firstTwoWeeks.start), "Nov 16, 2026");
assert.equal(switched.formatDate(firstTwoWeeks.end), "Nov 29, 2026");
const lastHalfMonth = switched.getPreviousPayPeriod(firstTwoWeeks);
assert.equal(switched.formatDate(lastHalfMonth.start), "Nov 1, 2026");
assert.equal(switched.formatDate(lastHalfMonth.end), "Nov 15, 2026");

assert.match(
    source,
    /normalizePayTimeline\(/,
    "timecard.html must read the full schedule history"
);

console.log(
    "Timecard pay-period navigation tests passed."
);
