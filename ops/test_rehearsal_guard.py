import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import production_backup as backup
import rehearse_release as rehearsal

class RehearsalGuards(unittest.TestCase):
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
