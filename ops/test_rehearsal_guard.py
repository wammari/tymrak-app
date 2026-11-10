import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import production_backup as backup
import rehearse_release as rehearsal

class RehearsalGuards(unittest.TestCase):
    def test_remote_bootstrap_review_is_rejected_before_any_command(self):
        with patch.object(backup,'run') as run:
            with self.assertRaises(ValueError):
                rehearsal.local_bootstrap_review('postgresql://postgres:synthetic@db.tsosredghislnehfyypi.supabase.co/postgres',{})
            run.assert_not_called()

    def test_local_review_uses_private_snapshot_copy_and_preserves_source_guard(self):
        source=(backup.ROOT/'ops/review-company-bootstrap.sql').read_text()
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder);(path/'ops').mkdir();(path/'ops/review-company-bootstrap.sql').write_text(source)
            private=path/'private';private.mkdir()
            with patch.object(backup,'ROOT',path),patch.object(backup,'PRIVATE',private),patch.object(backup,'run',return_value='{}') as run:
                rehearsal.local_bootstrap_review('postgresql://supabase_admin:synthetic@127.0.0.1:54322/postgres',{'project_ref':backup.PROJECT,'restore_verified':True,'source_inventory':{'public.punches':{'count':48},'public.employees':{'count':6},'auth.users':{'count':6}}})
                generated=(private/'company-bootstrap-local-review.sql').read_text()
                self.assertIn('public.punches)<>48 then',generated)
                self.assertIn('public.employees)<>6',generated)
                self.assertIn('auth.users)<>6',generated)
                self.assertTrue(generated.rstrip().endswith('rollback;'))
                self.assertEqual((path/'ops/review-company-bootstrap.sql').read_text(),source)
                self.assertEqual(run.call_args.args[0][-1],str(private/'company-bootstrap-local-review.sql'))

    def test_invalid_snapshot_counts_never_reach_a_command(self):
        for count in (-1,'48',True,None):
            with patch.object(backup,'run') as run:
                with self.assertRaises(ValueError):
                    rehearsal.local_bootstrap_review('postgresql://postgres:synthetic@localhost/postgres',{'project_ref':backup.PROJECT,'restore_verified':True,'source_inventory':{'public.punches':{'count':count}}})
                run.assert_not_called()

    def test_remote_status_url_is_rejected(self):
        remote='postgresql://postgres:synthetic@db.tsosredghislnehfyypi.supabase.co/postgres'
        with patch.object(backup,'run',return_value=json.dumps({'DB_URL':remote})):
            with self.assertRaises(ValueError):rehearsal.connection()

    def test_unverified_export_never_reaches_connection_or_migration(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder);(path/'manifest.json').write_text(json.dumps({'project_ref':backup.PROJECT,'restore_verified':False}))
            with patch.object(backup,'EXPORT',path),patch.object(rehearsal,'connection') as connection:
                with self.assertRaises(ValueError):rehearsal.main()
                connection.assert_not_called()

if __name__=='__main__':unittest.main()
