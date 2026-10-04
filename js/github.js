export class GitHubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export class ConflictError extends Error {
  constructor(snapshot) { super('Das Dokument wurde auf GitHub geändert.'); this.snapshot = snapshot; }
}
export function bytesToBase64(bytes) {
  let result = '';
  for (let i=0; i<bytes.length; i+=8192) result += String.fromCharCode(...bytes.subarray(i, i+8192));
  return btoa(result);
}
export function base64ToBytes(value) { return Uint8Array.from(atob(value.replace(/\s/g,'')), c => c.charCodeAt(0)); }
export function validateConfig(config) {
  if (!/^[a-z0-9-]+$/i.test(config.owner) || !/^[a-z0-9_.-]+$/i.test(config.repo) || ['.','..'].includes(config.repo)) throw new Error('Ungültiger Benutzer- oder Repository-Name.');
  if (!config.branch || /[\s~^:?*\[\\]|\.\.|@\{|\/\/|^\/|\/$|\.$|\.lock($|\/)/.test(config.branch)) throw new Error('Ungültiger Branch-Name.');
}
export function validDocumentPath(path) { return /^documents\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,120}\.html$/.test(path) && !path.includes('..'); }

export class GitHub {
  #token;
  static local(config) {
    const client=new GitHub(config,'local-credential-manager',async (url, options) => {
      const parsed=new URL(url);
      const expected=`/repos/${config.owner}/${config.repo}`;
      if (parsed.origin!=='https://api.github.com' || !(parsed.pathname===expected || parsed.pathname.startsWith(expected+'/'))) throw new Error('Ungültiges lokales GitHub-Ziel.');
      const headers={...options.headers,'X-WordPad-Local':'1'};
      delete headers.Authorization;
      return fetch(`/__git/github${parsed.pathname.slice(expected.length)}${parsed.search}`,{...options,headers});
    });
    client.localAuth=true;
    return client;
  }
  constructor(config, token, fetcher = (...args) => globalThis.fetch(...args)) {
    validateConfig(config);
    this.config = { ...config };
    this.#token = token;
    this.fetcher = fetcher;
    this.base = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
  }
  disconnect() { this.#token = ''; }
  async request(path, { method = 'GET', body, allow404 = false } = {}) {
    if (!this.#token) throw new Error('Bitte GitHub erneut verbinden.');
    const response = await this.fetcher(this.base + path, {
      method, cache: 'no-store', credentials: 'omit', redirect: 'error',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.#token}`, 'X-GitHub-Api-Version': '2026-03-10', ...(body ? {'Content-Type':'application/json'} : {}) },
      ...(body ? {body:JSON.stringify(body)} : {}), signal: AbortSignal.timeout(25000)
    });
    if (response.status === 404 && allow404) return null;
    if (!response.ok) {
      const messages = {401:'Token ungültig oder abgelaufen. Bitte erneut verbinden.',403:'Kein Zugriff: Token-Rechte, Branch-Regeln oder API-Limit prüfen.',404:'Repository oder Branch nicht gefunden. Zugriff und Schreibweise prüfen.',409:'Der Branch wurde gleichzeitig geändert oder ist noch leer.',422:'GitHub lehnt die Änderung ab. Branch-Regeln oder gleichzeitige Änderungen prüfen.',429:'GitHub-Anfragelimit erreicht. Bitte später erneut versuchen.'};
      throw new GitHubError(response.status, messages[response.status] || `GitHub ist nicht erreichbar (HTTP ${response.status}).`);
    }
    return response.json();
  }
  async validate() {
    const repo = await this.request('');
    if (!repo.private) throw new Error('Bitte ein privates Repository für deine Dokumente auswählen.');
    if (repo.permissions && !repo.permissions.push) throw new Error('Für dieses Repository fehlt Schreibzugriff.');
    await this.head();
    return repo;
  }
  async head() {
    const ref = await this.request(`/git/ref/heads/${this.config.branch.split('/').map(encodeURIComponent).join('/')}`);
    if (ref.ref !== `refs/heads/${this.config.branch}`) throw new Error('GitHub lieferte einen anderen Branch.');
    return ref.object.sha;
  }
  async contents(path, head, allow404 = false) {
    return this.request(`/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(head)}`, {allow404});
  }
  async snapshot(path) {
    if (!validDocumentPath(path)) throw new Error('Ungültiger Dokumentpfad.');
    const head = await this.head();
    const file = await this.contents(path, head, true);
    if (!file) return {sha:null, html:'', head};
    if (file.type !== 'file' || file.encoding !== 'base64' || file.size > 1024*1024) throw new Error('Das HTML-Dokument ist kein unterstütztes Textdokument (maximal 1 MB).');
    return { sha:file.sha, html:new TextDecoder().decode(base64ToBytes(file.content)), head };
  }
  async list() {
    const files = await this.contents('documents', await this.head(), true);
    if (!files) return [];
    if (!Array.isArray(files)) throw new Error('„documents“ muss ein Verzeichnis sein.');
    return files.filter(f => f.type === 'file' && validDocumentPath(f.path)).map(f => f.path);
  }
  async image(path, head) {
    if (!/^images\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(path)) throw new Error('Ungültiger Bildpfad.');
    const file = await this.contents(path, head);
    if (file.type !== 'file' || file.size > 5*1024*1024) throw new Error('Bild nicht unterstützt oder größer als 5 MB.');
    const data = file.encoding === 'base64' ? file : await this.request(`/git/blobs/${file.sha}`);
    return base64ToBytes(data.content);
  }
  async commit({ path, title, html, expectedSha, assets, onCheck }) {
    // One tree and one commit: HTML and images become visible together.
    // A non-fast-forward ref update is refused, then the SAME document is checked again.
    let entries;
    let docSha;
    for (let attempt = 0; attempt < 3; attempt++) {
      const remote = await this.snapshot(path);
      onCheck?.(remote);
      if (docSha && remote.sha === docSha) return remote; // Recover an acknowledged-late write.
      if (remote.sha !== expectedSha) throw new ConflictError(remote);
      if (!entries) {
        entries = [];
        for (const asset of assets) {
          const blob = await this.request('/git/blobs', {method:'POST',body:{content:bytesToBase64(new Uint8Array(await asset.blob.arrayBuffer())),encoding:'base64'}});
          entries.push({path:asset.path,mode:'100644',type:'blob',sha:blob.sha});
        }
        const blob = await this.request('/git/blobs', {method:'POST',body:{content:html,encoding:'utf-8'}});
        docSha = blob.sha;
        entries.push({path,mode:'100644',type:'blob',sha:docSha});
      }
      const parent = await this.request(`/git/commits/${remote.head}`);
      const tree = await this.request('/git/trees', {method:'POST',body:{base_tree:parent.tree.sha,tree:entries}});
      const cleanTitle = title.replace(/[\r\n]/g,' ').slice(0,100);
      const commit = await this.request('/git/commits', {method:'POST',body:{message:`${expectedSha ? 'Update' : 'Create'} ${cleanTitle}${assets.length ? ` (${assets.length} image${assets.length===1?'':'s'})` : ''}\n\nGit WordPad · ${path}`,tree:tree.sha,parents:[remote.head]}});
      try {
        await this.request(`/git/refs/heads/${this.config.branch.split('/').map(encodeURIComponent).join('/')}`, {method:'PATCH',body:{sha:commit.sha,force:false}});
        return {sha:docSha,html,head:commit.sha};
      } catch (error) {
        // Also handles a network failure after GitHub accepted the update.
        const latest = await this.snapshot(path);
        if (latest.sha === docSha) return latest;
        if (latest.sha !== expectedSha) throw new ConflictError(latest);
        if (!(error instanceof GitHubError) || ![409,422].includes(error.status) || attempt === 2) throw error;
      }
    }
    throw new Error('Der Branch ist gerade stark beschäftigt. Bitte erneut speichern.');
  }
}
