# Private production backup

The owner authorized release preparation while preserving production records. This workflow exports only the pinned TYMRAK production project and restores only to a loopback database in the disposable GitHub runner. It runs no application migration and never sends invitations. It is not scheduled.

## Owner setup

1. Download and keep the private `Tymrak_Backup_Recovery_Key.pem` supplied separately. It is not committed to GitHub. The checked-in `backup-recipient.pem` is the matching public encryption certificate. Without the private key the retained backup cannot be decrypted.
2. In Supabase **TYMRAK**, click **Connect**, select **Session pooler**, and obtain the complete PostgreSQL connection string with the correct, percent-encoded database password. This is the database password, not an API key. Keep it out of chat, issues and source files.
3. In GitHub repository **Settings → Secrets and variables → Actions → New repository secret**, create `TYMRAK_BACKUP_DATABASE_URL` with that connection string. Use the production project `tsosredghislnehfyypi`; the script rejects staging and unrelated hosts.
4. Rerun the backup workflow on `ops/production-backup`, or request a new backup marker commit on that branch. A missing secret produces an explicit **Backup NOT RUN** summary. A green skipped job is not backup evidence. `workflow_dispatch` is usable only after GitHub registers the workflow on the default branch; branch pushes are the supported trigger before that, so no main merge is required.

## What is retained

The pinned Supabase CLI exports roles, application schema and data (including Auth data). Auth/Storage managed schema customizations, Vault encryption keys, role passwords, Storage object files, hosted settings, SMTP, API keys and DNS are not guaranteed by these files and must be reviewed separately. The current production snapshot had no Storage objects; this must be rechecked before cutover. These dumps are not a full service-level disaster recovery package by themselves.

The checked-in `supabase-production-ca.crt` is the public Supabase Root 2021 CA downloaded by the owner from production Database settings. Export connections require `verify-full`, this certificate and a read-only transaction default. The pinned CLI produces its supported dump scripts; PostgreSQL 17 client tools execute them on the runner so the supplied certificate is used explicitly. The runner installs those tools from PostgreSQL's signed official package repository when missing.

The source is inventoried before and after export, including deterministic record hashes for public tables, Auth users/identities and Storage metadata, plus public RLS policies, function definitions/execute grants, table read/insert grants, constraints and triggers. A changed inventory rejects the export. This complements pg_dump's data snapshot; it does not promise zero writes by other users during the job.

A fresh local Supabase stack receives the export using the documented roles/schema/data sequence. Record hashes and policies must match before `restore_verified` becomes true in the private manifest. The local restore may expose version differences or managed-schema conflicts; those are failures to investigate, not permission to edit production or silently skip records.

The disposable restore uses the local `supabase_admin` account because restoring role parameter grants requires administrator privileges. Its connection is constructed only after rejecting all non-loopback hosts. No hosted role or permission is changed by that local restore.

If export fails, the encrypted artifact contains a manifest with complete_export false and private diagnostics; it is not a usable backup. Only an AES-256-GCM CMS encrypted archive is retained as an Actions artifact, for one day, with a 10 MiB maximum. The private manifest and diagnostic logs are inside that archive. Plaintext dumps, credentials, logs, local restore data and the private decryption key are never uploaded to GitHub. The server-side database connection is a repository secret and is supplied only to the read-only export step. Actions masking is defense in depth; the script never prints subprocess output or raw exceptions. The job uses a standard Linux runner in this public repository and adds no paid service or plan upgrade. Keep artifact storage within the account's existing free allowance; download the encrypted copy before expiry.

## Decrypt locally

Run with OpenSSL 3 or newer and the matching private recovery key:

```sh
openssl cms -decrypt -binary -inform DER \
  -in tymrak-production-backup.tar.gz.enc \
  -inkey Tymrak_Backup_Recovery_Key.pem \
  -out tymrak-production-backup.tar.gz.tmp && \
mv tymrak-production-backup.tar.gz.tmp tymrak-production-backup.tar.gz
```

Do not use a partial output after a failed authentication/decrypt operation. Keep both the private key and decrypted files private. Check `export/manifest.json` for `restore_verified: true`; an encrypted backup artifact alone does not mean restore verification passed. The application/company migration, SMTP acceptance and production deployment remain separate gates.

References: https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore and https://docs.github.com/en/billing/concepts/product-billing/github-actions .
