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
  return result.innerHTML.trim();
}

export function documentHTML(title, body) {
  return `<!doctype html>\n<html lang="de">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHTML(title)}</title>\n</head>\n<body>\n${sanitizeHTML(body)}\n</body>\n</html>\n`;
}

export function bodyHTML(html) {
  // Parsing in an inert template also handles complete HTML documents without loading resources.
  return sanitizeHTML(html);
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
