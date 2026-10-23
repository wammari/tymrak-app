// Match PostgREST's array Content-Range contract for mocked API responses.
export class PostgrestResponse extends Response {
  constructor(body, options) {
    super(body, options);
    try {
      const rows=JSON.parse(body);
      if(Array.isArray(rows)&&!this.headers.has('content-range'))
        this.headers.set('content-range', rows.length ? `0-${rows.length-1}/${rows.length}` : '*/0');
    } catch { /* Error bodies need not be JSON arrays. */ }
  }
}
