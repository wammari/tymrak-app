"""Private export/restore rehearsal. Never prints credentials, dumps or subprocess logs."""
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
from urllib.parse import urlsplit, urlunsplit, urlencode

PROJECT = 'tsosredghislnehfyypi'
CLI = ['npx', '--yes', 'supabase@2.122.0']
ROOT = Path(__file__).resolve().parents[1]
DATABASE_CA = ROOT / 'ops/supabase-production-ca.crt'
PRIVATE = Path(os.environ.get('RUNNER_TEMP', tempfile.gettempdir())) / 'tymrak-private-backup'
EXPORT = PRIVATE / 'export'
LOCAL = PRIVATE / 'restore-project'
ENCRYPTED = PRIVATE.parent / 'tymrak-production-backup.tar.gz.enc'
TABLES_SQL = """select jsonb_agg(jsonb_build_array(schemaname,tablename) order by schemaname,tablename)
from pg_tables where schemaname='public' or (schemaname='auth' and tablename in ('users','identities'))
or (schemaname='storage' and tablename in ('buckets','objects'))"""

class ConnectionConfigurationError(ValueError):
    pass

def checked_url(value):
    value = value.strip()
    if any(c.isspace() for c in value):
        raise ConnectionConfigurationError('Connection string contains whitespace')
    try:
        p = urlsplit(value)
        port = p.port
    except ValueError:
        raise ConnectionConfigurationError('Connection string cannot be parsed') from None
    direct = p.hostname == f'db.{PROJECT}.supabase.co' and p.username == 'postgres'
    pool = bool(p.hostname and p.hostname.endswith('.pooler.supabase.com')) and p.username == f'postgres.{PROJECT}'
    checks = [(p.scheme in ('postgres', 'postgresql'), 'URI scheme'),
              (direct or pool, 'production hostname or username'),
              (port in (None, 5432), 'session pooler port'),
              (p.path == '/postgres', 'database path'),
              (bool(p.password) and p.password != '[YOUR-PASSWORD]', 'password placeholder'),
              (not p.fragment, 'unencoded fragment character')]
    for valid, label in checks:
        if not valid:
            raise ConnectionConfigurationError('Check '+label)
    return urlunsplit((p.scheme, p.netloc, p.path, urlencode({'sslmode':'verify-full','sslrootcert':str(DATABASE_CA),'connect_timeout':'15'}), ''))

def local_url(value):
    p = urlsplit(value)
    if p.scheme not in ('postgres', 'postgresql') or p.hostname not in ('127.0.0.1','localhost') or p.path != '/postgres':
        raise ValueError('Restore requires a disposable local database')
    return value

def local_admin_url(value):
    p = urlsplit(local_url(value))
    if not p.password or '@' not in p.netloc:
        raise ValueError('Local restore credential missing')
    authority = 'supabase_admin:'+p.password+'@'+p.netloc.rsplit('@',1)[1]
    return urlunsplit((p.scheme,authority,p.path,p.query,p.fragment))

def run(args, name, readonly=False, capture=False, output_path=None):
    PRIVATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    env = os.environ.copy()
    # Only export processes receive the remote credential. Local services never do.
    env.pop('TYMRAK_BACKUP_DATABASE_URL', None)
    if readonly:
        env['PGOPTIONS'] = '-c default_transaction_read_only=on'
        env['PGSSLMODE'] = 'verify-full'
        env['PGSSLROOTCERT'] = str(DATABASE_CA)
    else:
        env.pop('PGOPTIONS', None)
    with (PRIVATE / (name+'.log')).open('ab') as log:
        if output_path:
            with output_path.open('wb') as output:
                result = subprocess.run(args, env=env, stdout=output, stderr=log, check=False, timeout=900)
        else:
            result = subprocess.run(args, env=env, stdout=subprocess.PIPE if capture else log, stderr=log, check=False, timeout=900)
    if result.returncode:
        raise RuntimeError(name+' failed; detailed output stays in the encrypted archive')
    return result.stdout.decode() if capture else None

def sql(url, query, name, readonly=False):
    output = run(['psql','--no-psqlrc','--dbname',url,'--set','ON_ERROR_STOP=1','--tuples-only','--no-align','--command',query], name, readonly=readonly, capture=True)
    return json.loads(output.strip())

def quoted(value):
    return '"'+value.replace('"','""')+'"'

def inventory(url, readonly=False):
    tables = sql(url,TABLES_SQL,'inventory-tables',readonly) or []
    result = {}
    for schema, table in tables:
        relation = quoted(schema)+'.'+quoted(table)
        query = """set timezone='UTC';set datestyle='ISO, MDY';
select jsonb_build_object('count',count(*),'digest',md5(coalesce(string_agg(row_hash,'' order by row_hash),'')))
from (select md5(to_jsonb(t)::text) row_hash from %s t) s""" % relation
        # --quiet omits SET acknowledgements so stdout contains only the JSON value.
        output = run(['psql','--no-psqlrc','--quiet','--dbname',url,'--set','ON_ERROR_STOP=1','--tuples-only','--no-align','--command',query], 'inventory-data', readonly=readonly, capture=True)
        result[schema+'.'+table] = json.loads(output.strip())
    policy_query = """select coalesce(jsonb_agg(to_jsonb(p) order by tablename,policyname),'[]'::jsonb)
from (select tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public') p"""
    result['public_policies'] = sql(url,policy_query,'inventory-policies',readonly)
    security_query = """select jsonb_build_object(
      'tables',(select jsonb_agg(jsonb_build_object('name',c.relname,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
        'anon_read',has_table_privilege('anon',c.oid,'SELECT'),'anon_insert',has_table_privilege('anon',c.oid,'INSERT'),
        'employee_read',has_table_privilege('authenticated',c.oid,'SELECT'),'employee_insert',has_table_privilege('authenticated',c.oid,'INSERT')) order by c.relname)
        from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'),
      'routines',(select jsonb_agg(jsonb_build_object('name',p.oid::regprocedure::text,'definition_hash',md5(pg_get_functiondef(p.oid)),
        'anon_execute',has_function_privilege('anon',p.oid,'EXECUTE'),'employee_execute',has_function_privilege('authenticated',p.oid,'EXECUTE'),
        'service_execute',has_function_privilege('service_role',p.oid,'EXECUTE')) order by p.oid::regprocedure::text)
        from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind in ('f','p')),
      'constraints',(select jsonb_agg(jsonb_build_object('table',c.conrelid::regclass::text,'name',c.conname,'definition',pg_get_constraintdef(c.oid),'validated',c.convalidated) order by c.conrelid::regclass::text,c.conname)
        from pg_constraint c join pg_class t on t.oid=c.conrelid where t.relnamespace='public'::regnamespace),
      'triggers',(select jsonb_agg(pg_get_triggerdef(t.oid) order by c.relname,t.tgname)
        from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace='public'::regnamespace and not t.tgisinternal)
    )"""
    result['public_security'] = sql(url,security_query,'inventory-security',readonly)
    return result

def export():
    url = checked_url(os.environ.get('TYMRAK_BACKUP_DATABASE_URL',''))
    if PRIVATE.exists():
        raise ValueError('Use a fresh runner for each backup')
    PRIVATE.mkdir(mode=0o700, parents=True)
    EXPORT.mkdir(mode=0o700)
    before = inventory(url,True)
    for filename, flags in [('roles.sql',['--role-only']),('schema.sql',[]),('data.sql',['--data-only','--use-copy','--exclude','storage.buckets_vectors,storage.vector_indexes'])]:
        # Use the pinned CLI's supported dump script locally so libpq uses the
        # supplied CA and verify-full settings for every export connection.
        script = PRIVATE / (filename+'.sh')
        script.write_text(run(CLI+['db','dump','--db-url',url,'--dry-run']+flags,'prepare-'+filename,readonly=True,capture=True))
        script.chmod(0o600)
        run(['bash','--noprofile','--norc',str(script)],'export-'+filename,readonly=True,output_path=EXPORT/filename)
        if not (EXPORT/filename).stat().st_size:
            raise RuntimeError('Empty dump file')
    after = inventory(url,True)
    if before != after:
        raise RuntimeError('Source records changed during export; retry during a quiet window')
    manifest = {'project_ref':PROJECT,'source_inventory':before,'files':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in EXPORT.iterdir()},'restore_verified':False,'complete_export':True}
    (EXPORT/'manifest.json').write_text(json.dumps(manifest,indent=2))
    print('Private database export completed. No production writes were made.')

def restore():
    LOCAL.mkdir(mode=0o700,parents=True)
    run(CLI+['init','--workdir',str(LOCAL),'--yes'],'local-init')
    config = LOCAL/'supabase/config.toml'
    text, replacements = re.subn(r'(?m)^major_version = [0-9]+$', 'major_version = 17', config.read_text())
    if replacements != 1:
        raise RuntimeError('Local database major version could not be pinned')
    config.write_text(text)
    run(CLI+['start','--workdir',str(LOCAL)],'local-start')
    status = json.loads(run(CLI+['status','--workdir',str(LOCAL),'--output','json'],'local-status',capture=True))
    url = local_admin_url(status['DB_URL'])
    # Only a validated loopback URL can reach this restore call.
    run(['psql','--no-psqlrc','--single-transaction','--set','ON_ERROR_STOP=1','--dbname',url,
         '--file',str(EXPORT/'roles.sql'),'--file',str(EXPORT/'schema.sql'),
         '--command','SET session_replication_role = replica','--file',str(EXPORT/'data.sql')],'local-restore')
    manifest = json.loads((EXPORT/'manifest.json').read_text())
    restored = inventory(url)
    if restored != manifest['source_inventory']:
        raise RuntimeError('Restored records or public RLS policies do not match the source')
    manifest['restore_verified'] = True
    (EXPORT/'manifest.json').write_text(json.dumps(manifest,indent=2))
    print('Disposable local restore matches application records, Auth users/identities, Storage metadata and public RLS policies.')

def encrypt():
    if not PRIVATE.exists():
        raise RuntimeError('No private diagnostics to retain')
    EXPORT.mkdir(mode=0o700,exist_ok=True)
    if not (EXPORT/'manifest.json').exists():
        (EXPORT/'manifest.json').write_text(json.dumps({'project_ref':PROJECT,'complete_export':False,'restore_verified':False}))
    archive = PRIVATE/'backup.tar.gz'
    with tarfile.open(archive,'w:gz') as tar:
        tar.add(EXPORT,arcname='export')
        for log in PRIVATE.glob('*.log'):
            tar.add(log,arcname='private-diagnostics/'+log.name)
    run(['openssl','cms','-encrypt','-binary','-aes-256-gcm','-in',str(archive),'-out',str(ENCRYPTED),'-outform','DER',str(ROOT/'ops/backup-recipient.pem')],'encrypt')
    if ENCRYPTED.stat().st_size > 10*1024*1024:
        ENCRYPTED.unlink()
        raise RuntimeError('Backup exceeds the 10 MiB pilot retention limit')
    print('Backup encrypted with the recovery certificate; only ciphertext will be uploaded.')

def cleanup():
    if LOCAL.exists():
        try:run(CLI+['stop','--workdir',str(LOCAL),'--no-backup'],'local-stop')
        except Exception:pass
    shutil.rmtree(PRIVATE,ignore_errors=True)

if __name__=='__main__':
    try:
        commands={'export':export,'restore':restore,'encrypt':encrypt,'cleanup':cleanup}
        commands[sys.argv[1]]()
    except ConnectionConfigurationError as error:
        # Only fixed labels from checked_url are safe to print, never URL fields.
        print(str(error),file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        # Exception messages may contain credentials/row data; never echo them.
        print('Backup operation did not complete ('+type(error).__name__+'). No production migration was run.',file=sys.stderr)
        sys.exit(1)
