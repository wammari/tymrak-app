// PostgREST caps arrays per request. Never calculate payroll from the first
// truncated page. Ask for an exact count and use stable ordering across pages.
export async function databaseRows(url, headers, fetchPage = fetch) {
  const target = new URL(url);
  if (!target.searchParams.has('order')) target.searchParams.set('order', 'id.asc');
  const rows = [];
  let expectedTotal;
  for (let page = 0; page < 200; page++) {
    target.searchParams.set('offset', String(rows.length));
    target.searchParams.set('limit', '500');
    const response = await fetchPage(target.toString(), {
      headers: {...headers, Prefer: [headers.Prefer, 'count=exact'].filter(Boolean).join(',')}
    });
    if (!response.ok) {
      const error = new Error('Database page request failed');
      error.response = response;
      throw error;
    }
    const values = await response.json();
    if (!Array.isArray(values)) throw new Error('Invalid database page');
    const range = response.headers.get('content-range');
    const total = range && /\/(\d+)$/.exec(range);
    if (!total) throw new Error('Database did not confirm the complete result count');
    const count = Number(total[1]);
    if (!Number.isSafeInteger(count) || count > 100000) throw new Error('Database result exceeds the supported reporting size');
    if (expectedTotal !== undefined && expectedTotal !== count) throw new Error('Data changed while loading; please retry');
    expectedTotal = count;
    rows.push(...values);
    if (rows.length === count) return rows;
    if (!values.length || rows.length > count) throw new Error('Incomplete database result');
  }
  throw new Error('Database result exceeds the supported reporting size');
}
