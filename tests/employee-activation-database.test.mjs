import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration=fs.readFileSync(new URL("../supabase/migrations/202610080001_atomic_employee_activation.sql",import.meta.url),"utf8");
const authId="11111111-1111-4111-8111-111111111111";
let db;
test.before(async()=>{
  db=new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create table public.employees (
      id bigint primary key, auth_user_id uuid, invitation_status text,
      activated_at timestamptz, is_active boolean, email text
    );
    insert into public.employees values
      (1, '${authId}', 'Invitation Sent', null, false, 'employee@example.com');
  `);
  const before=await db.query("select * from public.employees");
  await db.exec(migration);
  assert.deepEqual((await db.query("select * from public.employees")).rows,before.rows,
    "applying the migration must not modify existing employee records");
});
test.after(async()=>{await db.close();});
async function reset(rows) {
  await db.exec("truncate public.employees");
  for(const r of rows) {
    await db.query("insert into public.employees values ($1,$2,$3,$4,$5,$6)",
      [r.id,r.authId??authId,r.status??"Invitation Sent",r.at??null,r.active??true,r.email??"employee@example.com"]);
  }
}
async function snapshot(){return (await db.query("select * from public.employees order by id")).rows;}
async function complete() {
  return (await db.query("select public.complete_employee_activation($1::uuid) as result",[authId])).rows[0].result;
}
test("database activation updates exactly one employee and preserves identity and employment",async()=>{
  await reset([{id:1,active:false},{id:2,authId:"22222222-2222-4222-8222-222222222222"}]);
  const before=await snapshot();
  assert.deepEqual(await complete(),{outcome:"activated"});
  const after=await snapshot();
  assert.equal(after[0].invitation_status,"Account Activated"); assert.ok(after[0].activated_at);
  assert.deepEqual({...after[0],invitation_status:before[0].invitation_status,activated_at:null},before[0]);
  assert.deepEqual(after[1],before[1]);
  const timestamp=after[0].activated_at;
  assert.deepEqual(await complete(),{outcome:"already_activated"});
  assert.equal((await snapshot())[0].activated_at.getTime(),timestamp.getTime());
});
test("existing activated accounts and legacy activation evidence are unchanged",async()=>{
  for(const row of [
    {id:1,status:"Account Activated",at:"2026-09-01T12:00:00Z"},
    {id:1,status:"Account Activated"},
    {id:1,status:"Invitation Sent",at:"2026-09-01T12:00:00Z"}
  ]) {
    await reset([row]); const before=await snapshot();
    assert.deepEqual(await complete(),{outcome:"already_activated"});
    assert.deepEqual(await snapshot(),before);
  }
});
test("missing and duplicate mappings do not modify any employee",async()=>{
  for(const [rows,outcome] of [
    [[{id:1,authId:"22222222-2222-4222-8222-222222222222"}],"missing"],
    [[{id:1},{id:2,status:"Account Activated",at:"2026-09-01T12:00:00Z"}],"duplicate"]
  ]) {
    await reset(rows); const before=await snapshot();
    assert.deepEqual(await complete(),{outcome});
    assert.deepEqual(await snapshot(),before);
  }
});
test("transaction failure rolls back activation and subsequent retry succeeds",async()=>{
  await reset([{id:1}]);
  await db.exec(`create function public.fail_activation_test() returns trigger language plpgsql as $$
    begin raise exception 'simulated database failure'; end; $$;
    create trigger fail_activation before update on public.employees
    for each row execute function public.fail_activation_test();`);
  const before=await snapshot();
  await assert.rejects(complete(),/simulated database failure/);
  assert.deepEqual(await snapshot(),before);
  await db.exec("drop trigger fail_activation on public.employees; drop function public.fail_activation_test()");
  assert.deepEqual(await complete(),{outcome:"activated"});
});
test("browser roles cannot invoke the privileged activation transaction",async()=>{
  for(const role of ["anon","authenticated"]) {
    await db.exec(`set role ${role}`);
    try { await assert.rejects(complete(),/permission denied/); }
    finally { await db.exec("reset role"); }
  }
  await reset([{id:1}]);
  await db.exec("set role service_role");
  try { assert.deepEqual(await complete(),{outcome:"activated"}); }
  finally { await db.exec("reset role"); }
});

