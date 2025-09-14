// storage.js
export function getReqId() {
    return sessionStorage.getItem('req_id') || null;
  }
  export function setReqId(rid) {
    if (rid) sessionStorage.setItem('req_id', rid);
  }
  export function clearReqId() {
    sessionStorage.removeItem('req_id');
  }
  export async function ensureReqId(API_BASE) {
    let rid = getReqId();
    if (!rid) {
      const res = await fetch(`${API_BASE}/req/new`, { method: 'POST' });
      const data = await res.json();
      rid = data?.req_id;
      if (rid) setReqId(rid);
    }
    return rid;
  }