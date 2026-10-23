// Preserve the same request after a lost response, including across page reloads.
export function createPunchClient({request,storage,key,randomUUID}) {
  let pending=JSON.parse(storage.getItem(key)||'null');
  return {
    get pending(){return pending;},
    async record(punchType,expectedLastId) {
      if(!pending) {
        pending={punchType,expectedLastId,requestId:randomUUID()};
        storage.setItem(key,JSON.stringify(pending));
      }
      const response=await request('POST',pending);
      // A server 5xx can mean the write committed but the response was lost.
      if(response.ok || response.status<500) { storage.removeItem(key);pending=null; }
      if(!response.ok) {
        const error=new Error(response.body.error||'Unable to confirm punch');
        error.uncertain=response.status>=500;throw error;
      }
      return response.body;
    }
  };
}
