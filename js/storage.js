const DB_NAME = 'git-wordpad-v1';
let database;
export async function db() {
  if (database) return database;
  database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const d = request.result;
      d.createObjectStore('drafts', { keyPath: 'key' });
      d.createObjectStore('assets', { keyPath: 'key' });
      d.createObjectStore('backups', { keyPath: 'id', autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}
async function transaction(store, mode, action) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const request = action(tx.objectStore(store));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Lokale Sicherung abgebrochen.'));
  });
}
export const getDraft = key => transaction('drafts', 'readonly', s => s.get(key));
export const putDraft = draft => transaction('drafts', 'readwrite', s => s.put(draft));
export const allDrafts = () => transaction('drafts', 'readonly', s => s.getAll());
export const getAsset = key => transaction('assets', 'readonly', s => s.get(key));
export const putAsset = (key, blob) => transaction('assets', 'readwrite', s => s.put({ key, blob }));
export const allBackups = () => transaction('backups', 'readonly', s => s.getAll());
export async function backup(draft, reason) {
  await transaction('backups', 'readwrite', s => s.add({ ...draft, reason, savedAt: Date.now() }));
  const previous = (await allBackups()).filter(b => b.key === draft.key).sort((a,b) => b.id - a.id);
  for (const entry of previous.slice(10)) await transaction('backups', 'readwrite', s => s.delete(entry.id));
}
export function readSettings() {
  try { return JSON.parse(localStorage.getItem('wordpad-settings') || 'null'); } catch { return null; }
}
export function writeSettings(settings) { localStorage.setItem('wordpad-settings', JSON.stringify(settings)); }
export function journal(draft) { localStorage.setItem('wordpad-journal', JSON.stringify(draft)); }
export function readJournal() {
  try { return JSON.parse(localStorage.getItem('wordpad-journal') || 'null'); } catch { return null; }
}
export function clearJournal(key, updatedAt) {
  const entry = readJournal();
  if (entry?.key === key && entry.updatedAt === updatedAt) localStorage.removeItem('wordpad-journal');
}
export const scopeKey = config => config ? `${config.owner.toLowerCase()}/${config.repo.toLowerCase()}@${config.branch}` : 'local';
export const draftKey = (config, path) => `${scopeKey(config)}:${path}`;
