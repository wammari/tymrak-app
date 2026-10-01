import assert from "node:assert/strict";
import fs from "node:fs";

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
    "getCurrentPayPeriod",
    "getPayPeriod",
    "getPreviousPayPeriod",
    "getNextPayPeriod",
    "canNavigateToPayPeriod",
    "selectOvertimeRuleForPeriod",
    "formatDate",
    "getDatePartsInEmployeeTimeZone",
    "createDateInEmployeeTimeZone",
    "formatDuration",
    "calculateGreaterDailyOrWeeklyOvertime",
    "calculateDay"
];

const functions =
    Function(`
        let employeeTimeZone = "America/Edmonton";
        let currentPayPeriod = null;
        ${functionNames.map(extractFunction).join("\n")}
        return {
            ${functionNames.join(",")}
        };
    `)();

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

const shift =
    functions.calculateDay([
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
    ]);

const [calculatedShift] =
    functions.calculateGreaterDailyOrWeeklyOvertime(
        [{
            dateKey: "2026-09-28",
            workedMilliseconds:
                shift.workedMilliseconds
        }],
        {
            daily_threshold_hours: 8,
            weekly_threshold_hours: 44,
            week_start_day: 0
        }
    );

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

console.log(
    "Timecard pay-period navigation tests passed."
);
