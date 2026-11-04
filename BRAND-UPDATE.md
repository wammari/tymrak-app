# Brown and gold Tymrak theme

Uses the owner's New Logo.png brand board supplied on 26 October 2026. The committed `tymrak-brand-board.png` is byte-for-byte identical to that attachment (Git blob c148b2cbf0367f0585c11987bc2156220ff127ad). CSS frames the primary logo and excludes the board annotations; the image has not been regenerated, traced, recoloured or otherwise edited.

Primary colours: deep brown #351b0c, brown #663710, gold #bd811b, light gold #efbf63, warm cream #fbf8f3. Buttons use dark brown with white text, and gold is used for accents and focus indicators. Functional success/error states retain their meaning. A shared stylesheet covers portal selection, both login pages, activation, recovery/reset, employee clock, timecard, manager portal and workplace setup. Browser theme colour is brown.

The former desktop welcome image and invisible link hotspots are replaced with responsive HTML portal cards using the approved logo. Employee and manager destinations stay the same. Existing form IDs, script contents, auth rules and API/database logic are unchanged. Old assets remain available for compatibility but are no longer used for the welcome design.

Validation: 145 tests passed, staging Worker dry-run passed and nine local runtime smoke checks passed with fake credentials. Application script blocks were compared against the previous staging commit. Browser visual acceptance remains required on mobile and desktop before production. The exact supplied board is 2.22 MB; it is reused through the browser cache rather than embedding repeated image data. A separately supplied optimized production logo could reduce the initial download later without changing the brand.

Production launch remains separate: no production data, role, schema, credentials or DNS are changed by this visual update. No paid service is introduced.
