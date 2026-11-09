"""Apply release changes only to the already verified disposable local restore."""
import hashlib
import json
import re
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

def local_bootstrap_review(url, manifest):
    # Only an ephemeral copy may follow a newer verified restore's punch count.
    # Never rewrite the reviewed production SQL or infer production approval.
    backup.local_url(url)
    if manifest.get('project_ref') != backup.PROJECT or manifest.get('restore_verified') is not True:
        raise ValueError('A verified production restore manifest is required')
    count = manifest['source_inventory']['public.punches']['count']
    if type(count) is not int or count < 0:
        raise ValueError('Invalid verified snapshot punch count')
    source = (backup.ROOT/'ops/review-company-bootstrap.sql').read_text()
    sql, replacements = re.subn(r'(or \(select count\(\*\) from public\.punches\)<>)\d+( then)',
                                lambda match:match[1]+str(count)+match[2],source)
    if replacements != 1 or not sql.rstrip().lower().endswith('rollback;'):
        raise ValueError('Unrecognized rollback-only bootstrap review')
    path = backup.PRIVATE/'company-bootstrap-local-review.sql'
    path.write_text(sql)
    result = backup.run(['psql','--no-psqlrc','--quiet','--tuples-only','--no-align','--set','ON_ERROR_STOP=1','--dbname',url,
                         '--file',str(path)],'company-bootstrap-review',capture=True)
    return json.loads(result.strip())

def main():
    print('Rehearsal stage: verify restored inventory', flush=True)
    manifest = json.loads((backup.EXPORT/'manifest.json').read_text())
    if manifest.get('project_ref') != backup.PROJECT or not manifest.get('restore_verified'):
        raise ValueError('A verified local restore is required')
    url = connection()
    initial = backup.inventory(url)
    if initial != manifest['source_inventory']:
        raise ValueError('Local restore changed before rehearsal')
    print('Rehearsal stage: apply migrations to disposable database', flush=True)
    hashes = {}
    for filename in MIGRATIONS:
        path = backup.ROOT/'supabase/migrations'/filename
        hashes[filename] = hashlib.sha256(path.read_bytes()).hexdigest()
        # Use the ordinary local postgres role, matching hosted migration access.
        backup.run(['psql','--no-psqlrc','--quiet','--set','ON_ERROR_STOP=1','--dbname',url,'--file',str(path)],'migration-'+filename)
    print('Rehearsal stage: run synthetic access-control acceptance', flush=True)
    # Only the disposable local administrator provisions synthetic Auth fixtures.
    admin = backup.local_admin_url(url)
    # Bind legacy fixture counts to the verified production snapshot, not stale constants.
    expected_employees = manifest['source_inventory']['public.employees']['count']
    expected_users = manifest['source_inventory']['auth.users']['count']
    if type(expected_employees) is not int or expected_employees < 1 or expected_users != expected_employees:
        raise ValueError('Unreviewed employee/Auth inventory mismatch')
    acceptance_source = (backup.ROOT/'ops/rehearsal-acceptance.sql').read_text()
    acceptance_sql, replacements = re.subn(r'original_employees<>4', 'original_employees<>'+str(expected_employees), acceptance_source)
    if replacements != 1:
        raise ValueError('Unrecognized acceptance snapshot guard')
    acceptance_path = backup.PRIVATE/'rehearsal-acceptance-snapshot.sql'
    acceptance_path.write_text(acceptance_sql)
    result = backup.run(['psql','--no-psqlrc','--quiet','--tuples-only','--no-align','--set','ON_ERROR_STOP=1','--dbname',admin,
                         '--file',str(acceptance_path)],
                        'rehearsal-acceptance',capture=True)
    checks = json.loads(result.strip())
    if checks.get('all_checks_passed') is not True:
        raise RuntimeError('Rehearsal acceptance failed')
    # Review the real legacy company/admin mapping only in this loopback restore.
    # The SQL itself always rolls back; it must never become a hosted backfill.
    print('Rehearsal stage: review company bootstrap mapping', flush=True)
    company_review = local_bootstrap_review(admin,manifest)
    expected_review = {'company_count':1,'company_employee_count':expected_employees,'administrator_count':1,'quarantined_manager_count':0,'removed_test_manager_count':1,
                       'inactive_workplace_count':1,'employee_assignments':0,
                       'punches':manifest['source_inventory']['public.punches']['count'],'will_commit':False}
    if company_review != expected_review:
        raise RuntimeError('Company bootstrap review failed')
    print('Rehearsal stage: verify original records preserved', flush=True)
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
              'acceptance':checks,'company_bootstrap_review':company_review,
              'company_review_guard_source':'verified_disposable_restore_manifest',
              'company_bootstrap_source_sha256':hashlib.sha256((backup.ROOT/'ops/review-company-bootstrap.sql').read_bytes()).hexdigest(),
              'post_migration_inventory':after}
    (backup.EXPORT/'rehearsal-report.json').write_text(json.dumps(report,indent=2))
    print('Local migration rehearsal passed; legacy records preserved and synthetic fixtures rolled back.')

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Local release rehearsal failed ('+type(error).__name__+'). Private diagnostics retained; production unchanged.',file=sys.stderr)
        sys.exit(1)
