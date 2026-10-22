# Session rows timecards — implementation checklist

Status: in progress. No production deployment or merge authorized.

- Employee timecard: list every completed or incomplete Clock In/Out session beneath its date, with session-specific location, worked duration, and daily totals.
- Manager timecard detail: display matching session rows; retain period approval and reopen semantics, daily and weekly overtime, and punch audit details.
- Diagnose the observed 00:00 total for 2026-10-21 even though punches are present. Do not infer actual worked hours from the first and last punch when there are gaps.
- Preserve break exclusions and missing-punch indicators, timezone and overnight-shift behavior, approved-timecard locking, and safe text rendering.
- Add regression tests for multiple shifts per day, breaks, unmatched punches, and overtime allocation; run full suite and stage smoke tests before any merge.

This branch starts from `setup/isolated-staging` and must not be merged directly into `main` before its staging configuration dependency is resolved.
