import { getAsset, putAsset } from './storage.js';
import { assetPattern } from './html.js';
const extensions = {'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'};
export async function digest(bytes) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2,'0')).join(''); }
export function detectType(bytes) {
  if (bytes[0]===0x89 && bytes[1]===0x50 && bytes[2]===0x4e && bytes[3]===0x47) return 'image/png';
  if (bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff) return 'image/jpeg';
  const prefix = new TextDecoder().decode(bytes.subarray(0,12));
  if (prefix.startsWith('GIF87a') || prefix.startsWith('GIF89a')) return 'image/gif';
  if (prefix.startsWith('RIFF') && prefix.endsWith('WEBP')) return 'image/webp';
  throw new Error('Bitte PNG, JPEG, WebP oder GIF verwenden. SVG und andere Formate sind nicht erlaubt.');
}
export async function importImage(blob) {
  if (blob.size > 5*1024*1024) throw new Error('Bilder dürfen höchstens 5 MB groß sein.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const type = detectType(bytes);
  const verified = new Blob([bytes],{type});
  // Decode before storing: reject corrupt files and extreme image dimensions.
  let bitmap;
  try { bitmap = await createImageBitmap(verified); }
  catch { throw new Error('Dieses Bild kann nicht gelesen werden. Bitte eine gültige Bilddatei wählen.'); }
  const pixels = bitmap.width * bitmap.height;
  bitmap.close();
  if (pixels > 40000000) throw new Error('Bitte ein Bild mit maximal 40 Megapixeln verwenden.');
  const path = `../images/${await digest(bytes)}.${extensions[type]}`;
  await putAsset(path, verified);
  return path;
}
const urls = new Map();
export async function hydrateImages(element, github, head) {
  for (const img of element.querySelectorAll('img[data-asset]')) {
    const path = img.dataset.asset;
    if (!assetPattern.test(path)) continue;
    let asset = await getAsset(path);
    if (!asset && github && head) {
      const bytes = await github.image(path.slice(3), head);
      const type = detectType(bytes);
      const hash = await digest(bytes);
      if (path !== `../images/${hash}.${extensions[type]}`) throw new Error('Ein Bild stimmt nicht mit seinem Dateinamen überein.');
      const blob = new Blob([bytes],{type});
      await putAsset(path, blob);
      asset = {blob};
    }
    if (asset && img.isConnected) {
      if (!urls.has(path)) urls.set(path, URL.createObjectURL(asset.blob));
      img.src = urls.get(path);
    }
  }
}
export function releaseImageURLs() { for (const url of urls.values()) URL.revokeObjectURL(url); urls.clear(); }
