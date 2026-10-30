import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import production_backup as backup

class BackupTests(unittest.TestCase):
    def test_remote_target_guard_and_tls(self):
        good=f'postgresql://postgres.{backup.PROJECT}:encoded%40password@aws-1-ca-central-1.pooler.supabase.com:5432/postgres'
        self.assertIn('sslmode=verify-full',backup.checked_url(good))
        self.assertIn('encoded%40password',backup.checked_url(good))
        self.assertEqual(backup.checked_url(' \n'+good+'\r\n'),backup.checked_url(good))
        with self.assertRaises(backup.ConnectionConfigurationError):
            backup.checked_url(good.replace('@aws',' @aws'))
        for value in [good.replace(backup.PROJECT,'ctztwqcsizwkrqgpgrgg'),good.replace('.pooler.supabase.com','.pooler.supabase.com.evil.example'),good.replace('/postgres','/other'),good.replace('encoded%40password',''),good.replace(':5432',':6543')]:
            with self.assertRaises(ValueError):backup.checked_url(value)
        with self.assertRaises(ValueError):backup.local_url(good)
        self.assertEqual(backup.local_url('postgresql://postgres:fake@127.0.0.1:54322/postgres'),'postgresql://postgres:fake@127.0.0.1:54322/postgres')
        self.assertEqual(backup.local_admin_url('postgresql://postgres:fake@127.0.0.1:54322/postgres'),'postgresql://supabase_admin:fake@127.0.0.1:54322/postgres')
        with self.assertRaises(ValueError):backup.local_admin_url(good)

    def test_subprocess_failure_does_not_echo_private_output(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(backup,'PRIVATE',Path(folder)/'private'):
            output=io.StringIO()
            with contextlib.redirect_stdout(output),contextlib.redirect_stderr(output):
                with self.assertRaises(RuntimeError) as error:
                    backup.run([sys.executable,'-c',"print('fake_secret_for_test');raise SystemExit(1)"],'synthetic-failure')
            self.assertNotIn('fake_secret_for_test',str(error.exception)+output.getvalue())
            self.assertIn('fake_secret_for_test',(backup.PRIVATE/'synthetic-failure.log').read_text())

    def test_export_subprocess_requires_certificate_and_readonly(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(backup,'PRIVATE',Path(folder)/'private'):
            script="import os,json;print(json.dumps({k:os.environ.get(k) for k in ['PGSSLMODE','PGSSLROOTCERT','PGOPTIONS','TYMRAK_BACKUP_DATABASE_URL']}))"
            with patch.dict(os.environ,{'TYMRAK_BACKUP_DATABASE_URL':'synthetic-private-value'}):
                result=json.loads(backup.run([sys.executable,'-c',script],'tls-environment',readonly=True,capture=True))
            self.assertEqual(result['PGSSLMODE'],'verify-full')
            self.assertEqual(result['PGSSLROOTCERT'],str(backup.DATABASE_CA))
            self.assertIn('default_transaction_read_only=on',result['PGOPTIONS'])
            self.assertIsNone(result['TYMRAK_BACKUP_DATABASE_URL'])

    def test_security_inventory_uses_consistent_search_path(self):
        with patch.object(backup,'run',return_value='{}') as runner:
            self.assertEqual(backup.sql('synthetic-url','select 1','fixture'),{})
        args=runner.call_args.args[0]
        self.assertIn('--quiet',args)
        self.assertTrue(args[-1].startswith('SET search_path = public, pg_catalog;'))

    def test_authenticated_encryption_roundtrip_and_tamper_rejection(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);private=root/'private';export=private/'export';export.mkdir(parents=True);(root/'ops').mkdir()
            (export/'manifest.json').write_text(json.dumps({'restore_verified':False}))
            (export/'data.sql').write_text('synthetic fixture only')
            key=root/'fixture-key.pem';cert=root/'ops/backup-recipient.pem';encrypted=root/'backup.enc'
            subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-keyout',str(key),'-out',str(cert),'-days','1','-nodes','-subj','/CN=SyntheticFixture'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
            with patch.multiple(backup,PRIVATE=private,EXPORT=export,ROOT=root,ENCRYPTED=encrypted),contextlib.redirect_stdout(io.StringIO()):backup.encrypt()
            archive=root/'restored.tar.gz'
            command=['openssl','cms','-decrypt','-binary','-inform','DER','-in',str(encrypted),'-inkey',str(key),'-out',str(archive)]
            subprocess.run(command,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
            with tarfile.open(archive) as tar:self.assertEqual(tar.extractfile('export/data.sql').read(),b'synthetic fixture only')
            corrupted=bytearray(encrypted.read_bytes());corrupted[-1]^=1;encrypted.write_bytes(corrupted)
            self.assertNotEqual(subprocess.run(command,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode,0)

if __name__=='__main__':unittest.main()
