// api.js
const RUNPOD_DEFAULT = 'https://wishes-baker-subsidiaries-branches.trycloudflare.com';
const LOCAL_DEFAULT  = 'http://localhost:8888';

// Priority:
// 1) Vite env var (Vercel/locally: VITE_API_BASE)
// 2) CRA env var  (create-react-app: REACT_APP_API_BASE)
// 3) If on localhost -> LOCAL_DEFAULT else RUNPOD_DEFAULT
const fromVite   = typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE;
const fromCRA    = typeof process !== 'undefined' && process.env?.REACT_APP_API_BASE;
const isLocal    = typeof window !== 'undefined' && /^localhost$/i.test(window.location.hostname);

export const API_BASE = (fromVite || fromCRA || (isLocal ? LOCAL_DEFAULT : RUNPOD_DEFAULT)).replace(/\/+$/,'');
export const WS_BASE  = API_BASE.replace(/^http/i, 'ws');
