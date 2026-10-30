-- Production security-advisor remediation candidate. REVIEW AND TEST ON RESTORED COPY FIRST.
-- These are trigger-only functions; normal clients must not have direct EXECUTE.
-- Revoking EXECUTE does not remove their installed trigger definitions.
REVOKE EXECUTE ON FUNCTION public.prevent_approved_timecard_punch_changes() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
-- Do not change unrelated RPC grants. Check advisors after deployment.
