import * as storage from './storage.js';
import { GitHub, ConflictError, validDocumentPath } from './github.js';
import { sanitizeHTML, documentHTML, bodyHTML, isEmptyHTML, mountHTML, assetPaths, escapeHTML, titleFromPath } from './html.js';
import { importImage, hydrateImages, releaseImageURLs } from './images.js';
import { REPOSITORY } from './config.js';
import { rememberToken, rememberedToken, forgetToken } from './auth.js';

const $ = id => document.getElementById(id);
const editor = $('editor');
const previousConfig = storage.readSettings();
let config = REPOSITORY;
let github = null;
let current;
let candidate = null;
let busy = false;
let checking = false;
let selection = null;
let lastCheck = null;
let persistence = Promise.resolve();
let writable = false;
let composing = false;
let uiEpoch = 0;
let localConnecting;
let restoringLogin;
let authEpoch = 0;
const initialPath = REPOSITORY.documentPath;

async function connectLocalGit() {
  if (github) return true;
  if (!writable || !navigator.onLine || !['localhost','127.0.0.1'].includes(location.hostname)) return false;
  if (localConnecting) return localConnecting;
  const epoch=uiEpoch;
  const loginEpoch=authEpoch;
  localConnecting=(async () => {
    try {
      const response=await fetch('/__git/session',{headers:{'X-WordPad-Local':'1'},cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(6000)});
      if (!response.ok) return false;
      const session=await response.json();
      if (!session.connected || Object.keys(REPOSITORY).some(key => session.repository?.[key]!==REPOSITORY[key])) return false;
      const client=GitHub.local(REPOSITORY);
      await client.validate();
      if (epoch!==uiEpoch || loginEpoch!==authEpoch || github) { client.disconnect(); return !!github; }
      github=client;
      $('connection-dialog').close(); $('info-dialog').close();
      refresh();
      await checkRemote();
      return true;
    } catch { return false; }
  })();
  try { return await localConnecting; } finally { localConnecting=undefined; }
}

async function restoreConnection() {
  if (!writable || !navigator.onLine || github || localStorage.getItem('wordpad-signed-out') === '1') return;
  if (restoringLogin) return restoringLogin;
  const epoch=authEpoch;
  restoringLogin=(async () => {
    if (await connectLocalGit()) return;
    let client;
    try {
      const token=await rememberedToken(REPOSITORY);
      if (!token || epoch!==authEpoch) return;
      client=new GitHub(REPOSITORY,token);
      await client.validate();
      if (epoch!==authEpoch || github) { client.disconnect(); return; }
      github=client;
      refresh();
      await checkRemote();
    } catch (error) {
      client?.disconnect();
      if (epoch!==authEpoch) return;
      if (error.status===401) {
        await forgetToken(REPOSITORY);
        message('Der gespeicherte GitHub-Zugang ist abgelaufen oder widerrufen. Bitte einmal neu verbinden.',true);
      } else if (error.name==='OperationError' || error.name==='DataError') {
        message('Gespeicherter Zugang nicht lesbar. Bitte unter i neu verbinden. Deine Entwürfe bleiben erhalten.',true);
      } else message(errorMessage(error),true);
    }
  })();
  try { await restoringLogin; } finally { restoringLogin=undefined; }
}

async function discardInvalidLogin(error, client) {
  if (error.status!==401 || !client || client!==github) return;
  client.disconnect(); github=null; authEpoch++; uiEpoch++;
  try { await forgetToken(REPOSITORY); }
  finally { refresh(); }
}

function message(text, error = false) {
  $('notice').textContent = text;
  $('notice').hidden = !text;
  $('notice').classList.toggle('error', error);
  $('notice').title = text;
  $('notice-detail').textContent = text;
  $('notice-detail').hidden = !text;
  $('info-button').classList.toggle('has-error', error && !!text);
}
function errorMessage(error) {
  const network = error instanceof TypeError || ['TimeoutError','AbortError'].includes(error.name);
  return network ? 'Keine Verbindung zu GitHub. Dein Entwurf bleibt lokal; bitte später erneut versuchen.' : error.message;
}
function dirty() { return current && (current.html !== current.baseHtml || (!current.baseSha && !current.remoteDeleted)); }
function refresh() {
  if (!current) return;
  const state = candidate ? (dirty() ? 'conflict' : 'remote') : dirty() ? 'dirty' : 'clean';
  $('status').dataset.state = state;
  $('status-text').textContent = ({conflict:'Konflikt',remote:'Remote neuer',dirty:'ungespeichert',clean:'aktuell'})[state];
  $('document-title').textContent = current.title;
  document.title = `${current.title} · Git WordPad`;
  $('document-location').textContent = config ? `${config.owner} / ${config.repo} · ${config.branch} · ${current.path}` : 'Lokal auf diesem Gerät · noch nicht eingerichtet';
  $('connection-label').textContent = github ? config.repo : 'GitHub verbinden';
  $('connection-button').classList.toggle('connected', !!github);
  $('sync-status').textContent = !navigator.onLine ? 'Offline · lokal gesichert' : !github ? 'GitHub nicht verbunden' : lastCheck ? `Geprüft ${new Date(lastCheck).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})} · alle 60 s` : 'GitHub verbunden';
  $('connectivity').textContent = !navigator.onLine ? 'offline' : github ? (github.localAuth ? 'GitHub · Git' : 'GitHub') : 'lokal';
  $('status').title = $('sync-status').textContent;
  const words = editor.innerText.trim().split(/\s+/u).filter(Boolean).length;
  $('word-count').textContent = `${words} ${words===1?'Wort':'Wörter'}`;
  $('save-button').disabled = busy || !writable;
  $('save-button').querySelector('span').textContent = busy ? '…' : 'Save';
  const editable = String(writable && !busy);
  if (editor.contentEditable !== editable) editor.contentEditable = editable;
  for (const el of document.querySelectorAll('.toolbar button,.toolbar select,.toolbar input,#connection-button')) el.disabled = busy || !writable;
  $('info-button').disabled = busy;
}
function capture() {
  current.html = sanitizeHTML(editor.innerHTML);
  current.updatedAt = Date.now();
  return structuredClone(current);
}
function persist() {
  if (!current || !writable) return Promise.resolve();
  const draft = capture();
  $('draft-status').textContent = 'Lokal sichern …';
  try { storage.journal(draft); } catch { /* IndexedDB still provides the primary durable store. */ }
  const write = persistence.catch(() => {}).then(() => storage.putDraft(draft));
  persistence = write;
  write.then(() => {
    storage.clearJournal(draft.key, draft.updatedAt);
    if (current?.key === draft.key && current.updatedAt === draft.updatedAt) $('draft-status').textContent = 'Auf diesem Gerät gesichert';
  }).catch(() => {
    $('draft-status').textContent = 'Lokale Sicherung fehlgeschlagen';
    message('Der Browser konnte den Entwurf nicht sichern. Speicherplatz prüfen und diesen Tab geöffnet lassen.', true);
  });
  return write;
}
function changed() { if (!current || !writable || busy) return; persist().catch(() => {}); refresh(); }
function rememberSelection() {
  const selected = window.getSelection();
  if (selected.rangeCount && editor.contains(selected.anchorNode) && editor.contains(selected.focusNode)) selection = selected.getRangeAt(0).cloneRange();
}
function restoreSelection() {
  // selectionchange is asynchronous; a toolbar action may arrive before that event.
  if (document.activeElement === editor || !window.getSelection().isCollapsed) rememberSelection();
  editor.focus();
  const selected = window.getSelection();
  selected.removeAllRanges();
  if (selection && editor.contains(selection.commonAncestorContainer)) selected.addRange(selection);
  else { const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); selected.addRange(range); }
}
function command(name, value = null) {
  if (busy || !writable) return;
  restoreSelection();
  document.execCommand(name, false, value);
  rememberSelection();
  changed();
}
function newDraft(path, title = titleFromPath(path)) {
  return {key:storage.draftKey(config,path),scope:storage.scopeKey(config),path,title,html:'',baseHtml:'',baseSha:null,head:null,updatedAt:Date.now(),remoteDeleted:false};
}
async function displayDraft(draft) {
  current = draft;
  candidate = null;
  selection = null;
  uiEpoch++;
  releaseImageURLs();
  mountHTML(editor, current.html);
  refresh();
  localStorage.setItem(`wordpad-last:${current.scope}`, current.path);
  await hydrateImages(editor, github, current.head).catch(e => message(`Text geladen. ${errorMessage(e)}`,true));
}
async function setConflict(remote, popup = true) {
  const different = !candidate || candidate.sha !== remote.sha;
  candidate = remote;
  refresh();
  $('conflict-description').textContent = remote.sha ? 'Auf GitHub gibt es eine andere Version. Deine lokalen Änderungen bleiben gesichert.' : 'Das Dokument wurde auf GitHub gelöscht. Deine lokale Version bleibt gesichert.';
  if (different) {
    $('comparison').hidden = true;
    if (popup && !$('conflict-dialog').open) $('conflict-dialog').showModal();
  }
}
async function adoptRemote(remote, reason) {
  await storage.backup(capture(), reason);
  current.baseSha = remote.sha;
  current.baseHtml = bodyHTML(remote.html);
  current.html = current.baseHtml;
  current.head = remote.head;
  current.remoteDeleted = remote.sha === null;
  candidate = null;
  selection = null;
  $('conflict-dialog').close();
  mountHTML(editor, current.html);
  await persist();
  await hydrateImages(editor, github, remote.head).catch(e => message(`Text aktualisiert. ${errorMessage(e)}`,true));
  refresh();
}
async function checkRemote() {
  if (!github || !current || busy || checking || composing || !navigator.onLine) { refresh(); return; }
  checking = true;
  const epoch = uiEpoch;
  const client = github;
  try {
    const remote = await client.snapshot(current.path);
    if (busy || epoch !== uiEpoch || client !== github) return;
    lastCheck = Date.now();
    const empty = isEmptyHTML(current.html);
    // A blank restored draft can differ even when the last known remote SHA matches.
    if (remote.sha === current.baseSha && (composing || !empty || current.html === bodyHTML(remote.html))) { candidate = null; refresh(); return; }
    // Re-evaluate dirtiness AFTER awaiting the network: typing during polling must survive.
    if ((dirty() && !empty) || composing) await setConflict(remote);
    else {
      candidate = remote; refresh();
      busy = true; refresh();
      try { await adoptRemote(remote,'Automatisch aktualisiert'); message(remote.sha ? 'Die neuere GitHub-Version wurde geladen.' : 'Das Dokument wurde auf GitHub gelöscht. Der vorherige Stand ist unter Zwischenstände gesichert.'); }
      finally { busy = false; refresh(); }
    }
  } catch (error) {
    if (epoch === uiEpoch && client === github) {
      await discardInvalidLogin(error,client);
      message(errorMessage(error),true);
    }
  }
  finally { checking = false; refresh(); }
}
async function save() {
  if (busy || !writable) return;
  busy = true; refresh(); message('');
  try {
    await persist();
    if (!github) { message('Der Entwurf ist lokal gesichert. Verbinde GitHub, um einen Commit zu speichern.'); showConnection(); return; }
    if (!navigator.onLine) { message('Offline: Dein Entwurf ist lokal gesichert. Sobald du online bist, erneut Save wählen.'); return; }
    const remote = await github.snapshot(current.path);
    lastCheck = Date.now();
    if (isEmptyHTML(current.html)) {
      await adoptRemote(remote,'Leeren lokalen Stand ignoriert');
      message(remote.sha ? 'Die GitHub-Version wurde geladen. Der leere lokale Stand wurde ignoriert.' : 'Leere Dokumente werden nicht auf GitHub gespeichert.');
      return;
    }
    if (remote.sha !== current.baseSha) {
      if (!dirty()) { await adoptRemote(remote,'Vor Save aktualisiert'); message('Die neuere GitHub-Version wurde geladen.'); return; }
      await setConflict(remote); $('conflict-dialog').open || $('conflict-dialog').showModal(); return;
    }
    candidate = null;
    if (!dirty()) { message('Dieses Dokument ist bereits aktuell.'); return; }
    const html = documentHTML(current.title,current.html);
    if (new TextEncoder().encode(html).length > 1024*1024) throw new Error('Das Dokument darf höchstens 1 MB HTML enthalten. Bilder werden separat gespeichert.');
    await storage.backup(capture(),'Vor Save');
    await hydrateImages(editor, github, remote.head);
    const assets = [];
    for (const path of assetPaths(current.html)) {
      const asset = await storage.getAsset(path);
      if (!asset) throw new Error('Ein Bild ist noch nicht lokal verfügbar. Bitte online laden und erneut speichern.');
      assets.push({path:path.slice(3),blob:asset.blob});
    }
    const saved = await github.commit({path:current.path,title:current.title,html,expectedSha:current.baseSha,assets});
    current.baseSha = saved.sha; current.baseHtml = current.html; current.head = saved.head; current.remoteDeleted = false;
    candidate = null;
    await persist();
    message(`Auf GitHub gespeichert · Commit ${saved.head.slice(0,7)}`);
  } catch (error) {
    if (error instanceof ConflictError) await setConflict(error.snapshot);
    else { await discardInvalidLogin(error,github); message(errorMessage(error),true); }
  } finally { busy = false; refresh(); }
}
function showConnection() {
  $('info-dialog').close();
  for (const field of ['owner','repo','branch']) $(field).value = config?.[field] || ({owner:'Mars007007',repo:'',branch:'main'})[field];
  $('document-path').value = config?.documentPath || current.path;
  $('repository-settings').open = !config;
  $('connection-title').textContent = config ? 'GitHub verbinden' : 'Einmalige Einrichtung';
  $('token').value = ''; $('connection-error').textContent = '';
  $('connection-dialog').showModal();
}
async function showInfo() {
  $('info-dialog').showModal();
  $('recovery-list').replaceChildren();
  const backups = (await storage.allBackups()).filter(b => b.key === current.key).sort((a,b) => b.id-a.id);
  if (!backups.length) $('recovery-list').textContent = 'Noch keine Zwischenstände für dieses Dokument.';
  for (const version of backups) {
    const button = document.createElement('button');
    button.disabled = !writable;
    button.textContent = `${new Date(version.savedAt).toLocaleString('de-DE')} · ${version.reason}`;
    button.onclick = async () => {
      if (busy) return;
      busy = true; refresh();
      try {
        await storage.backup(capture(),'Vor Wiederherstellen');
        current.html = version.html;
        mountHTML(editor,current.html);
        selection = null;
        await persist();
        await hydrateImages(editor,github,current.head);
        $('info-dialog').close(); message('Zwischenstand als lokalen Entwurf wiederhergestellt.');
      } catch (error) { message(errorMessage(error),true); }
      finally { busy = false; refresh(); }
    };
    $('recovery-list').append(button);
  }
}

// UI binding. execCommand is isolated here to retain the native browser undo stack.
document.addEventListener('selectionchange', () => {
  rememberSelection();
  if (!editor.contains(window.getSelection().anchorNode)) return;
  for (const name of ['bold','italic','underline']) document.querySelector(`[data-command="${name}"]`).setAttribute('aria-pressed',String(document.queryCommandState(name)));
});
for (const button of document.querySelectorAll('[data-command]')) {
  button.addEventListener('pointerdown', event => event.preventDefault());
  button.onclick = () => command(button.dataset.command);
}
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => $(button.dataset.close).close();
editor.addEventListener('input', changed);
editor.addEventListener('compositionstart', () => { composing = true; });
editor.addEventListener('compositionend', () => { composing = false; changed(); });
$('font-size').onchange = () => {
  // Preserve native undo and formatting at a collapsed caret. CSS and serialization
  // use the same seven sizes, without DOM changes outside the undo transaction.
  document.execCommand('styleWithCSS',false,false);
  command('fontSize',String(['12','14','16','18','24','32','48'].indexOf($('font-size').value)+1));
};
$('text-color').oninput = () => command('foreColor',$('text-color').value);
$('save-button').onclick = () => save().catch(e => message(errorMessage(e),true));
$('connection-button').onclick = async () => {
  if (github) { showConnection(); return; }
  localStorage.removeItem('wordpad-signed-out');
  if (!await connectLocalGit()) showConnection();
};
$('info-button').onclick = () => showInfo().catch(e => message(errorMessage(e),true));
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (!document.querySelector('dialog[open]')) save().catch(e => message(errorMessage(e),true)); }
});
$('connection-dialog').addEventListener('close', () => { $('token').value = ''; });
$('connection-form').onsubmit = async event => {
  event.preventDefault();
  const next = REPOSITORY;
  const token = $('token').value.trim();
  const remember = $('remember-login').checked;
  authEpoch++;
  $('token').value = '';
  const submit = event.submitter; submit.disabled = true;
  for (const el of $('connection-form').querySelectorAll('input,button')) el.disabled = true;
  let client;
  busy = true; refresh();
  try {
    if (!validDocumentPath(next.documentPath)) {
      $('repository-settings').open = true;
      throw new Error('Bitte documents/dateiname.html verwenden, ohne Leerzeichen oder weitere Unterordner.');
    }
    client = new GitHub(next,token);
    await client.validate();
    if (remember) {
      try { await rememberToken(token,next); }
      catch { throw new Error('Der Browser konnte den Zugang nicht dauerhaft speichern. Speicherplatz prüfen oder „Angemeldet bleiben“ abwählen.'); }
    } else await forgetToken(next);
    localStorage.removeItem('wordpad-signed-out');
    await persist();
    const old = structuredClone(current);
    storage.writeSettings(next);
    github?.disconnect();
    config = next; github = client; uiEpoch++;
    const key = storage.draftKey(config,next.documentPath);
    const existing = await storage.getDraft(key);
    const nextDraft = existing || (old.scope === 'local' ? {...old,key,path:next.documentPath,title:titleFromPath(next.documentPath),scope:storage.scopeKey(config),baseSha:null,baseHtml:'',head:null} : newDraft(next.documentPath));
    await displayDraft(nextDraft);
    await persist();
    $('connection-dialog').close(); message(remember ? 'Verbunden. Dieses Gerät bleibt auch nach einem Neustart angemeldet.' : 'GitHub für diese Sitzung verbunden.');
    navigator.storage?.persist?.().catch(() => {});
  } catch (error) { if (client !== github) client?.disconnect(); $('connection-error').textContent = errorMessage(error); }
  finally { busy = false; for (const el of $('connection-form').querySelectorAll('input,button')) el.disabled = false; refresh(); }
  await checkRemote();
};
$('disconnect-button').onclick = async () => {
  if (busy) return;
  authEpoch++; uiEpoch++;
  localStorage.setItem('wordpad-signed-out','1');
  github?.disconnect(); github = null; candidate = null; $('token').value='';
  busy=true; refresh();
  try {
    await forgetToken(REPOSITORY);
    $('connection-dialog').close();
    message('Abgemeldet und gespeicherten Zugang entfernt. Deine lokalen Entwürfe bleiben erhalten.');
  } catch { message('Abgemeldet, aber der gespeicherte Zugang konnte nicht entfernt werden. Bitte erneut versuchen.',true); }
  finally { busy=false; refresh(); }
};
$('reload-button').onclick = async () => {
  if (!candidate || busy) return;
  busy = true; refresh();
  try { await adoptRemote(candidate,'Vor Neu laden'); $('conflict-dialog').close(); message('GitHub-Version geladen. Dein vorheriger Entwurf liegt unter Zwischenstände.'); }
  catch (error) { message(errorMessage(error),true); }
  finally { busy = false; refresh(); }
};
$('keep-button').onclick = async () => {
  if (!candidate || busy) return;
  busy = true; refresh();
  try {
    await storage.backup(capture(),'Vor Konfliktauflösung');
    current.baseSha = candidate.sha; current.baseHtml = bodyHTML(candidate.html); current.head = candidate.head; current.remoteDeleted = false;
    candidate = null;
    await persist();
    $('conflict-dialog').close(); message('Lokale Version behalten. Mit Save als neuen Commit speichern; GitHub wird vorher erneut geprüft.');
  } catch (error) { message(errorMessage(error),true); }
  finally { busy = false; refresh(); }
};
$('compare-button').onclick = async () => {
  if (!candidate) return;
  mountHTML($('compare-local'),current.html); mountHTML($('compare-remote'),bodyHTML(candidate.html));
  $('comparison').hidden = false;
  await Promise.all([hydrateImages($('compare-local'),github,current.head),hydrateImages($('compare-remote'),github,candidate.head)]).catch(e => message(errorMessage(e),true));
};

async function insertImages(files) {
  if (busy || !writable) return;
  const epoch = uiEpoch;
  rememberSelection();
  busy = true; refresh();
  try {
    const paths = [];
    for (const file of files) paths.push({path:await importImage(file),name:file.name||'Bild'});
    if (epoch !== uiEpoch) return;
    busy = false; refresh();
    command('insertHTML',paths.map(({path,name}) => `<img data-asset="${path}" alt="${escapeHTML(name)}"><br>`).join(''));
    await hydrateImages(editor,github,current.head);
    await persist();
  } finally { busy = false; refresh(); }
}
$('image-button').onpointerdown = e => e.preventDefault();
$('image-button').onclick = () => { rememberSelection(); $('image-input').click(); };
$('image-input').onchange = async () => { try { await insertImages([...$('image-input').files]); } catch (error) { message(errorMessage(error),true); } finally { $('image-input').value=''; } };
async function insertClipboard(html, text) {
  if (html) {
    const safe = sanitizeHTML(html);
    const template = document.createElement('template'); template.innerHTML = safe;
    // Clipboard images cannot claim arbitrary private image paths. Use paste-image or Image insert.
    for (const img of template.content.querySelectorAll('img')) img.remove();
    command('insertHTML',template.innerHTML);
  } else command('insertText',text);
}
editor.addEventListener('paste', event => {
  event.preventDefault();
  const files = [...(event.clipboardData?.files || [])];
  if (files.length) insertImages(files).catch(e => message(errorMessage(e),true));
  else insertClipboard(event.clipboardData?.getData('text/html')||'',event.clipboardData?.getData('text/plain')||'').catch(e => message(errorMessage(e),true));
});
editor.addEventListener('dragover', event => event.preventDefault());
editor.addEventListener('drop', event => {
  event.preventDefault();
  const files = [...event.dataTransfer.files];
  if (files.length) insertImages(files).catch(e => message(errorMessage(e),true));
  else message('Text bitte mit Einfügen übernehmen. Bilder können hier abgelegt werden.');
});
$('copy-button').onpointerdown = event => event.preventDefault();
$('copy-button').onclick = async () => {
  restoreSelection();
  try {
    const selected = window.getSelection();
    if (!selected.toString()) { message('Zum Kopieren zuerst Text markieren.'); return; }
    const container = document.createElement('div'); container.append(selected.getRangeAt(0).cloneContents());
    if (navigator.clipboard?.write && window.ClipboardItem) await navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob([selected.toString()],{type:'text/plain'}),'text/html':new Blob([sanitizeHTML(container.innerHTML)],{type:'text/html'})})]);
    else if (!document.execCommand('copy')) throw new Error('Bitte Strg+C oder das Kopieren-Menü deines Geräts verwenden.');
    message('Auswahl kopiert.');
  } catch { message('Bitte Strg+C oder das Kopieren-Menü deines Geräts verwenden.'); }
};
$('paste-button').onpointerdown = event => event.preventDefault();
$('paste-button').onclick = async () => {
  try {
    if (navigator.clipboard?.read) {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find(t => ['image/png','image/jpeg','image/webp','image/gif'].includes(t));
        if (imageType) await insertImages([await item.getType(imageType)]);
        else await insertClipboard(item.types.includes('text/html') ? await (await item.getType('text/html')).text() : '',item.types.includes('text/plain') ? await (await item.getType('text/plain')).text() : '');
      }
    } else await insertClipboard('',await navigator.clipboard.readText());
  } catch { message('Bitte Strg+V oder langes Antippen → Einfügen verwenden. Dein Browser erlaubt hier keinen direkten Clipboard-Zugriff.'); }
};

function syncConnection() { if (github) return checkRemote(); return restoreConnection().catch(()=>{}); }
window.addEventListener('online', () => { refresh(); syncConnection(); });
window.addEventListener('offline', refresh);
document.addEventListener('visibilitychange', () => { if (document.hidden) persist().catch(()=>{}); else syncConnection(); });
window.addEventListener('pagehide', () => { if (current && writable) { try { storage.journal(capture()); } catch {} } });
window.addEventListener('beforeunload', event => { if (writable && current && $('draft-status').textContent !== 'Auf diesem Gerät gesichert') { event.preventDefault(); event.returnValue=''; } });
let installPrompt;
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('install').hidden = false; });
$('install').onclick = async () => { await installPrompt?.prompt(); installPrompt = null; $('install').hidden = true; };
window.addEventListener('appinstalled', () => { $('install').hidden = true; });

async function start() {
  if (!navigator.locks) throw new Error('Bitte einen aktuellen Browser über HTTPS oder localhost verwenden.');
  // A second tab must not silently overwrite the first tab's offline draft.
  await new Promise((resolve,reject) => {
    navigator.locks.request('git-wordpad-editor',{ifAvailable:true},async lock => {
      writable = !!lock; resolve();
      if (lock) await new Promise(() => {});
    }).catch(reject);
  });
  await storage.db();
  const journal = storage.readJournal();
  if (writable && journal?.key) {
    const saved = await storage.getDraft(journal.key);
    if (!saved || journal.updatedAt >= saved.updatedAt) await storage.putDraft(journal);
    storage.clearJournal(journal.key,journal.updatedAt);
  }
  const path = initialPath;
  let draft=await storage.getDraft(storage.draftKey(config,path));
  if (!draft && writable) {
    // Migrate the previously open draft without deleting or silently uploading it.
    const oldScope=storage.scopeKey(previousConfig);
    const oldPath=previousConfig?.documentPath || localStorage.getItem(`wordpad-last:${oldScope}`) || 'documents/mein-erstes-dokument.html';
    const old=await storage.getDraft(storage.draftKey(previousConfig,oldPath));
    if (old) draft={...newDraft(path),html:old.html};
  }
  await displayDraft(draft || newDraft(path));
  if (writable) storage.writeSettings(config);
  if (writable) await persist();
  else message('WordPad ist bereits in einem anderen Tab geöffnet. Zum Bearbeiten diesen anderen Tab schließen und hier neu laden.',true);
  setInterval(syncConnection,60000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => message('Offline-App konnte nicht installiert werden. HTTPS oder localhost verwenden.',true));
  refresh();
  if (writable) restoreConnection().catch(() => {});
}
start().catch(error => { writable = false; refresh(); message(`Start fehlgeschlagen: ${errorMessage(error)}`,true); });
