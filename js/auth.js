// Convenience storage for a trusted browser profile, NOT a hardware-backed vault.
// Same-origin script can use the persisted key to decrypt the token. Non-extractable
// prevents exportKey(), not use of the key or theft from a compromised application.
const DB_NAME = 'git-wordpad-auth-v1';
const id = config => `${location.origin}/${config.owner.toLowerCase()}/${config.repo.toLowerCase()}@${config.branch}`;
async function transaction(mode, action) {
  const database = await new Promise((resolve,reject) => {
    const request=indexedDB.open(DB_NAME,1);
    request.onupgradeneeded=()=>request.result.createObjectStore('credentials',{keyPath:'id'});
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
  try {
    return await new Promise((resolve,reject) => {
      const tx=database.transaction('credentials',mode);
      const request=action(tx.objectStore('credentials'));
      tx.oncomplete=()=>resolve(request.result);
      tx.onerror=()=>reject(tx.error);
      tx.onabort=()=>reject(tx.error || new Error('Zugang konnte nicht gespeichert werden.'));
    });
  } finally { database.close(); }
}
export async function rememberToken(token, config) {
  if (!token) throw new Error('Ein Token ist erforderlich.');
  const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const scope=id(config);
  const plaintext=new TextEncoder().encode(token);
  try {
    const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(scope)},key,plaintext);
    await transaction('readwrite',store=>store.put({id:scope,version:1,key,iv,ciphertext}));
  } finally { plaintext.fill(0); }
}
export async function rememberedToken(config) {
  const scope=id(config);
  const entry=await transaction('readonly',store=>store.get(scope));
  if (!entry) return null;
  if (entry.version!==1 || entry.key?.extractable!==false) throw new Error('Gespeicherter Zugang ist nicht lesbar. Bitte erneut verbinden.');
  const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:entry.iv,additionalData:new TextEncoder().encode(scope)},entry.key,entry.ciphertext);
  try { return new TextDecoder().decode(plaintext); }
  finally { new Uint8Array(plaintext).fill(0); }
}
export const forgetToken = config => transaction('readwrite',store=>store.delete(id(config)));
