// Construct a fresh allowlisted DOM. Never insert repository/clipboard HTML directly.
const tags = new Set(['P', 'DIV', 'BR', 'STRONG', 'EM', 'U', 'S', 'SPAN', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'BLOCKQUOTE']);
const discard = new Set(['HEAD','TITLE','SCRIPT','STYLE','IFRAME','OBJECT','EMBED','SVG','MATH','LINK','META','BASE','TEMPLATE','NOSCRIPT','INPUT','BUTTON','TEXTAREA','SELECT','VIDEO','AUDIO','SOURCE']);
export const assetPattern = /^\.\.\/images\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/;
export const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function sanitizeHTML(html) {
  const source = document.createElement('template');
  source.innerHTML = String(html);
  const result = document.createElement('div');
  function walk(node, parent) {
    if (node.nodeType === 3) { parent.append(document.createTextNode(node.textContent)); return; }
    if (node.nodeType !== 1 || discard.has(node.tagName)) return;
    if (node.tagName === 'IMG') {
      const path = node.getAttribute('data-asset') || node.getAttribute('src') || '';
      if (assetPattern.test(path)) {
        const img = document.createElement('img');
        img.setAttribute('src', path);
        img.setAttribute('alt', (node.getAttribute('alt') || 'Bild').slice(0, 200));
        parent.append(img);
      }
      return;
    }
    // Preserve a block container when it contains paragraphs/lists. Turning that
    // container into a paragraph would produce invalid nested <p> elements.
    const mapped = node.tagName === 'DIV' && node.querySelector('p,div,h1,h2,h3,ul,ol,blockquote')
      ? 'DIV' : ({B:'STRONG', I:'EM', DIV:'P', FONT:'SPAN'})[node.tagName] || node.tagName;
    if (!tags.has(mapped)) { for (const child of node.childNodes) walk(child, parent); return; }
    const el = document.createElement(mapped.toLowerCase());
    const color = node.style.color || (node.tagName === 'FONT' ? node.getAttribute('color') : '');
    if (color && /^(#[a-f\d]{3,8}|rgba?\([\d.,%\s]+\)|[a-z]{1,20})$/i.test(color) && CSS.supports('color', color)) el.style.color = color;
    let size = node.style.fontSize;
    if (!size && node.tagName === 'FONT') size = ({1:'12px',2:'14px',3:'16px',4:'18px',5:'24px',6:'32px',7:'48px'})[node.getAttribute('size')];
    if (size && /^(\d+(\.\d+)?)(px|pt)$/.test(size) && parseFloat(size) >= 8 && parseFloat(size) <= 96) el.style.fontSize = size;
    if (['bold','700','800','900'].includes(node.style.fontWeight)) el.style.fontWeight = 'bold';
    if (node.style.fontStyle === 'italic') el.style.fontStyle = 'italic';
    if (node.style.textDecorationLine.includes('underline')) el.style.textDecoration = 'underline';
    for (const child of node.childNodes) walk(child, el);
    parent.append(el);
  }
  for (const node of source.content.childNodes) walk(node, result);
  // Native indent may emit <ul><li>Parent</li><ul>...</ul></ul>.
  // Store proper list ownership so nesting survives reload and clipboard round trips.
  for (const list of result.querySelectorAll('ul > ul,ul > ol,ol > ul,ol > ol')) {
    let owner = list.previousElementSibling;
    if (owner?.tagName !== 'LI') {
      owner = document.createElement('li'); list.before(owner);
    }
    owner.append(list);
  }
  return result.innerHTML.trim();
}

// Recognize a complete pasted outline, including Android's plain-text clipboard.
// Other text is left untouched; this is not a Markdown document editor.
export function plainTextListHTML(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n').filter(line => line.trim());
  const items = lines.map(line => line.match(/^([ \t]*)([-+*•◦▪]|\d+[.)])[ \t]+(.*)$/u));
  if (!items.length || items.some(item => !item)) return '';
  const root = document.createElement('div');
  const stack = [];
  for (const [, space, marker, content] of items) {
    const indent = space.replace(/\t/g, '    ').length;
    const type = /^\d/.test(marker) ? 'ol' : 'ul';
    while (stack.length && indent < stack.at(-1).indent) stack.pop();
    if (!stack.length || indent > stack.at(-1).indent || type !== stack.at(-1).type) {
      if (stack.length && indent === stack.at(-1).indent) stack.pop();
      const parent = stack.length ? stack.at(-1).last : root;
      const list = document.createElement(type); parent.append(list);
      stack.push({indent, type, list, last:null});
    }
    const item = document.createElement('li'); item.textContent = content;
    stack.at(-1).list.append(item); stack.at(-1).last = item;
  }
  return root.innerHTML;
}

export function clipboardListText(html, fallback) {
  const template = document.createElement('template'); template.innerHTML = html;
  // Complete list fragments can round-trip even through a plain-text-only clipboard.
  const roots = [...template.content.childNodes].filter(node => node.nodeType !== 3 || node.textContent.trim());
  if (!roots.length || roots.some(node => !['UL','OL'].includes(node.nodeName))) return fallback;
  function lines(list, depth) {
    return [...list.children].flatMap((item, index) => {
      const label = item.cloneNode(true);
      for (const nested of label.querySelectorAll('ul,ol')) nested.remove();
      const prefix = list.tagName === 'OL' ? `${index+1}.` : '-';
      return [`${'  '.repeat(depth)}${prefix} ${label.textContent.trim().replace(/\s+/g,' ')}`,
        ...[...item.querySelectorAll('ul,ol')].filter(nested => nested.parentElement.closest('ul,ol') === list).flatMap(nested => lines(nested,depth+1))];
    });
  }
  return roots.flatMap(list => lines(list,0)).join('\n');
}

export function documentHTML(title, body) {
  return `<!doctype html>\n<html lang="de">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHTML(title)}</title>\n</head>\n<body>\n${sanitizeHTML(body)}\n</body>\n</html>\n`;
}

export function bodyHTML(html) {
  // Parsing in an inert template also handles complete HTML documents without loading resources.
  return sanitizeHTML(html);
}

export function isEmptyHTML(html) {
  const template = document.createElement('template');
  template.innerHTML = sanitizeHTML(html);
  // Editors leave empty paragraphs, <br>, NBSP and invisible caret characters.
  // An image is content even when the document contains no text.
  return !template.content.querySelector('img') &&
    !template.content.textContent.replace(/[\s\u200B-\u200D\u2060\uFEFF]/gu, '');
}

export function assetPaths(body) {
  const template = document.createElement('template');
  template.innerHTML = sanitizeHTML(body);
  return [...new Set([...template.content.querySelectorAll('img')].map(img => img.getAttribute('src')))];
}

export function mountHTML(element, html) {
  const template = document.createElement('template');
  template.innerHTML = sanitizeHTML(html);
  for (const img of template.content.querySelectorAll('img')) {
    img.dataset.asset = img.getAttribute('src');
    img.removeAttribute('src'); // Private images must never be requested from the public Pages origin.
  }
  element.replaceChildren(template.content);
}

export function titleFromPath(path) {
  return path.replace(/^documents\//, '').replace(/\.html$/, '').replace(/-/g, ' ');
}

export function slug(title) {
  const value = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0,70);
  return value || 'dokument';
}
