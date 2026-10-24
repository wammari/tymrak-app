# Cloudflare Free hosting candidate — 24 October 2026

The owner chose to keep hosting free. This candidate adds a staging-only Cloudflare
Worker; it does not deploy, change DNS, change production data, or subscribe to a plan.
It is stacked on company/workplace isolation PR #27, then #26 and #25.

## Implementation

- Existing API handlers retain Auth verification, company/workplace scope and punch RPCs.
  An adapter converts Fetch requests to their existing request/response interface.
- Only twelve explicitly listed public API paths are routed. Internal modules and `.js`
  API source paths return 404. JSON parsing is bounded to 128 KiB, including streamed
  bodies, with explicit malformed/unsupported/oversized errors. API responses use no-store.
- The static build copies seventeen named browser assets into `.cloudflare-assets`.
  It fails on missing files. The repository root, SQL, tests, API source, package files,
  backups and environment files are never used as the public assets directory.
- Node compatibility supplies Buffer and process.env from Worker bindings. The adapter
  never mutates global process.env with request values. A staging-only guard rejects
  production environment/project bindings before invoking any API handler.
- Staging SITE_URL supports the exact `tymrak-staging.<account>.workers.dev` shape only
  with CLOUDFLARE_RELEASE_ENV=staging, or the existing staging custom domain/Vercel origin.
  Production remains restricted to https://www.tymrak.com.
- Wrangler is pinned in devDependencies. `npm run check:cloudflare` is a local dry run,
  not a deployment command. Automatic Vercel deployment is disabled on this branch.

## Account and staging setup

No connected Cloudflare integration was found and no account was created. The owner
must sign in/create their Cloudflare account and retain the Workers Free plan. Do not
paste credentials or server keys into chat, source control, or public build variables.
Use the account's secure secret configuration and approved account authentication.

1. Review the candidate and run `npm ci`, `npm test`, `npm run check:cloudflare`,
   and `npm run test:cloudflare` (local runtime, fake credentials only).
2. In the owner's free Cloudflare account, create/link the staging Worker `tymrak-staging`.
   Do not connect main to automatic deployment. No custom domain or production routing yet.
3. Keep the checked-in staging project URL/ref and APP_ENV/CLOUDFLARE_RELEASE_ENV bindings.
   Configure SITE_URL as the assigned stable staging Worker HTTPS origin, plus the staging
   SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY through secure account settings.
   Never use the production Supabase key. Leave version preview URLs disabled.
4. Add only that staging origin's activation/recovery callbacks in staging Supabase Auth.
   Check sending-domain/custom SMTP configuration and external recipient delivery.
5. Deploy this reviewed branch to staging only. Check `/api/public-config` for staging
   origin/project and no secret. Confirm private source/SQL/env paths return 404 and
   anonymous protected API requests fail. Test login, invitation/activation, recovery,
   manager scopes, map and assigned-employee mobile inside/outside clock-in/out.
6. Measure Worker CPU and API requests under representative usage; local Node tests and
   a bundle build do not prove the free CPU budget or hosted behavior. Test incomplete
   network retries, overnight shifts and locked approvals on this host as well.

## Free limits and launch gates

Official Workers pricing/limits checked 24 October 2026: Free dynamic requests are
limited to 100,000/day with 10 ms CPU per request; static asset requests are free and
unlimited. Exceeding a free request/CPU limit can fail clock requests. Workers Paid
starts at US$5/month plus possible usage, but no upgrade is authorized. This is a hosting
estimate, not a promise that the whole application is free at any customer volume.
Supabase, email, domain renewals and OpenStreetMap usage retain separate limits.

Sources:
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- https://developers.cloudflare.com/workers/runtime-apis/nodejs/process/
- https://developers.cloudflare.com/workers/static-assets/binding/

There is deliberately no production Worker configuration or DNS route in this PR.
Only after hosted staging acceptance: prepare a separately reviewed canonical-domain
production configuration, backup/restore rehearsal, company/manager mapping, credential
rotation and retirement of old unscoped deployments, production SMTP verification,
then coordinated migration/deployment. Keep the current production deployment intact
until cutover is ready. Refer to COMPANY-ISOLATION-RELEASE.md for database release gates.

## Verification evidence

- 143 local Node tests passed, zero failures/skips, including eight new adapter/asset
  and environment-boundary tests with real API handler imports.
- Wrangler 4.152.0 dry-run build succeeded with all seventeen actual public assets;
  bundle 65.63 KiB, gzip 14.66 KiB. No deployment or database connection occurred.
- Cloudflare's actual local runtime served the home page, employee page and original
  branding; public config used staging without exposing secrets; anonymous punch API
  returned 401. Private API source, environment, package and migration paths returned
  404. These nine smoke checks used fake credentials and made no database calls.
- GitHub Actions runs the full suite, bundle dry run and local-runtime smoke checks.
- Hosted Cloudflare acceptance and free-tier CPU/load measurements remain pending.
