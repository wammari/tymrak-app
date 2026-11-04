-- Forward-only: remove direct browser invocation of trigger helpers.
-- Existing triggers and function bodies are preserved. Rehearse before applying.
begin;
do $$
declare helper text;
begin
 foreach helper in array array['set_updated_at','prevent_approved_timecard_punch_changes','rls_auto_enable'] loop
  if to_regprocedure('public.'||helper||'()') is not null then
   execute format('revoke execute on function public.%I() from public,anon,authenticated',helper);
  end if;
 end loop;
end $$;
commit;
