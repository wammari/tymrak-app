# Workplace address search

Managers enter an address including city and country, click **Find address**, choose a matching result and verify the building on the map. The chosen result fills latitude/longitude (including the sign) and moves the pin. A lookup does not save anything; existing **Save workplace and assignments** remains the only write action. Dragging the pin and manual coordinates still work.

Search uses Photon's public demo endpoint https://photon.komoot.io/api/ with OpenStreetMap data. No key, billing account, paid fallback or runtime dependency is added. The browser sends only the entered address, never Tymrak credentials or employee lists. The UI discloses the provider and shows attribution. Searches are explicit, limited to five results, cached in memory (20 queries), spaced two seconds apart per page, and time out after 12 seconds. Results use text nodes and invalid coordinates are discarded. Editing the address or switching workplaces invalidates pending results.

Provider policy: https://github.com/komoot/photon#demo-server permits reasonable usage but may throttle or ban extensive use and provides no uptime guarantee. This is an optional convenience for low-volume manager setup, not a dependency for employee clocking. Reassess provider capacity before scaling onboarding. Missing addresses can be located manually using the map; do not assume that a search result is a verified workplace boundary.

Prepared on a separate branch from the Cloudflare staging candidate; not merged or deployed. Before promoting, test an exact known address, ambiguous and missing addresses, selecting a result, switching workplaces while searching, dragging the result pin, and saving/reloading assignments on mobile. Production data and schema are unchanged.

Validation: 145 automated tests pass, Cloudflare dry-run succeeds, and nine local Worker runtime checks pass with fake credentials. A public Hamilton city query returned valid GeoJSON and the provider permits browser cross-origin requests. Hosted UI acceptance remains pending.
