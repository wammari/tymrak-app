import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const html=readFileSync(new URL("../employee.html",import.meta.url),"utf8");
test("employee punch buttons call protected API, not browser database inserts",()=>{
 assert.match(html,/fetch\("\/api\/employee-punch"/);
 assert.doesNotMatch(html,/\.from\("punches"\)\s*\.insert\(/);
 assert.match(html,/navigator\.geolocation\.getCurrentPosition/);
 assert.match(html,/expectedLastId:/);
 assert.match(html,/requestId:\s*crypto\.randomUUID\(\)/);
});
