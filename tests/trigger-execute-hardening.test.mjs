import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

test('trigger permission hardening closes direct invocation while existing triggers still fire',async()=>{
 const db=new PGlite();
 try {
  await db.exec(`create role anon;create role authenticated;create role service_role;
   create table fixture(value int);
   create function public.set_updated_at() returns trigger language plpgsql as $$begin new.value:=new.value+1;return new;end$$;
   create function public.prevent_approved_timecard_punch_changes() returns trigger language plpgsql as $$begin return new;end$$;
   create function public.rls_auto_enable() returns event_trigger language plpgsql as $$begin return;end$$;
   create trigger fixture_increment before insert on fixture for each row execute function public.set_updated_at();
   grant execute on function public.set_updated_at(),public.prevent_approved_timecard_punch_changes(),public.rls_auto_enable() to anon,authenticated;`);
  await db.exec(fs.readFileSync(new URL('../supabase/migrations/202610290001_trigger_execute_hardening.sql',import.meta.url),'utf8'));
  const permissions=await db.query(`select has_function_privilege(r, p.oid,'execute') allowed from pg_proc p cross join (values('anon'),('authenticated')) roles(r) where p.pronamespace='public'::regnamespace and p.proname in ('set_updated_at','prevent_approved_timecard_punch_changes','rls_auto_enable')`);
  assert.equal(permissions.rows.length,6);
  assert.ok(permissions.rows.every(row=>!row.allowed));
  await db.exec('insert into fixture values(1)');
  assert.equal((await db.query('select value from fixture')).rows[0].value,2);
 } finally {await db.close();}
});
