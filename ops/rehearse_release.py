"""Apply release changes only to the already verified disposable local restore."""
import hashlib
import json
import sys
import production_backup as backup

MIGRATIONS = [
    '202610230001_atomic_employee_punches.sql',
    '20261023172638_manual_workplaces_geofenced_punches.sql',
    '20261023213945_company_isolation.sql',
    '20261023220346_manager_workplace_scope.sql',
    '202610290001_trigger_execute_hardening.sql',
]

def connection():
    status = json.loads(backup.run(backup.CLI+['status','--workdir',str(backup.LOCAL),'--output','json'],'rehearsal-status',capture=True))
    return backup.local_url(status['DB_URL'])

def main():
    manifest = json.loads((backup.EXPORT/'manifest.json').read_text())
    if manifest.get('project_ref') != backup.PROJECT or not manifest.get('restore_verified'):
        raise ValueError('A verified local restore is required')
    url = connection()
    initial = backup.inventory(url)
    if initial != manifest['source_inventory']:
        raise ValueError('Local restore changed before rehearsal')
    hashes = {}
    for filename in MIGRATIONS:
        path = backup.ROOT/'supabase/migrations'/filename
        hashes[filename] = hashlib.sha256(path.read_bytes()).hexdigest()
        # Use the ordinary local postgres role, matching hosted migration access.
        backup.run(['psql','--no-psqlrc','--quiet','--set','ON_ERROR_STOP=1','--dbname',url,'--file',str(path)],'migration-'+filename)
    # Only the disposable local administrator provisions synthetic Auth fixtures.
    admin = backup.local_admin_url(url)
    result = backup.run(['psql','--no-psqlrc','--quiet','--set','ON_ERROR_STOP=1','--dbname',admin,
                         '--file',str(backup.ROOT/'ops/rehearsal-acceptance.sql')],
                        'rehearsal-acceptance',capture=True)
    checks = json.loads(result.strip())
    if checks.get('all_checks_passed') is not True:
        raise RuntimeError('Rehearsal acceptance failed')
    after = backup.inventory(admin)
    # The fixture transaction rolls back. New company columns must remain
    # quarantined, and every original field/row must match its export hash.
    for relation, expected in manifest['source_inventory'].items():
        if not isinstance(expected,dict) or 'count' not in expected:
            continue
        schema, table = relation.split('.',1)
        expression = "to_jsonb(t)-'organization_id'" if relation in ('public.employees','public.user_roles') else 'to_jsonb(t)'
        query = """select jsonb_build_object('count',count(*),'digest',md5(coalesce(string_agg(row_hash,'' order by row_hash),'')))
        from (select md5(%s::text) row_hash from %s.%s t) s""" % (('('+expression+')'),backup.quoted(schema),backup.quoted(table))
        actual = backup.sql(admin,"SET timezone='UTC';SET datestyle='ISO, MDY';"+query,'rehearsal-preservation')
        if actual != expected:
            raise RuntimeError('Legacy records changed during rehearsal')
    report = {'project_ref':backup.PROJECT,'migration_sha256':hashes,'all_checks_passed':True,
              'legacy_records_preserved':True,'fixtures_rolled_back':True,
              'production_unchanged':True,'production_workplace_confirmation_required':True,
              'acceptance':checks,'post_migration_inventory':after}
    (backup.EXPORT/'rehearsal-report.json').write_text(json.dumps(report,indent=2))
    print('Local migration rehearsal passed; legacy records preserved and synthetic fixtures rolled back.')

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Local release rehearsal failed ('+type(error).__name__+'). Private diagnostics retained; production unchanged.',file=sys.stderr)
        sys.exit(1)
