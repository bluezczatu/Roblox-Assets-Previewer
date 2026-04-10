const vscode = require('vscode');
const https  = require('https');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const ASSET_ID_RE = /rbxassetid:\/\/(\d+)/gi;
const CACHE_DIR   = path.join(os.tmpdir(), 'roblox-asset-previewer');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const ASSET_TYPES = {
  1:'Image',2:'TShirt',3:'Audio',4:'Mesh',5:'Lua',8:'Hat',9:'Place',
  10:'Model',11:'Shirt',12:'Pants',13:'Decal',17:'Head',18:'Face',
  19:'Gear',21:'Badge',24:'Animation',34:'GamePass',38:'Plugin',
  40:'MeshPart',54:'CSGMesh',62:'Video',64:'Sound',65:'Script'
};

// ── Cache ────────────────────────────────────────────────────────────────────
const TTL_MS      = 5 * 60 * 1000; // 5 min
const detailCache = new Map();      // assetId → { data, ts }

function cacheGet(id) {
  const entry = detailCache.get(id);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) { detailCache.delete(id); return null; }
  return entry.data;
}
function cacheSet(id, data) { detailCache.set(id, { data, ts: Date.now() }); }

// ── Rate limiter ─────────────────────────────────────────────────────────────
// Max 1 new network round-trip per 300 ms
const queue   = [];
let lastFired = 0;

function scheduleRequest(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    drainQueue();
  });
}

function drainQueue() {
  if (!queue.length) return;
  const now  = Date.now();
  const wait = Math.max(0, 300 - (now - lastFired));
  setTimeout(() => {
    if (!queue.length) return;
    const { fn, resolve, reject } = queue.shift();
    lastFired = Date.now();
    fn().then(resolve).catch(reject);
    drainQueue();
  }, wait);
}

// ── HTTP helper ──────────────────────────────────────────────────────────────
function httpsGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    https.get(url, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode))
        return httpsGet(res.headers.location, redirects + 1).then(resolve).catch(reject);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function getJson(url) {
  const { status, body } = await httpsGet(url);
  if (status !== 200) return null;
  try { return JSON.parse(body.toString()); } catch { return null; }
}

// ── API calls ────────────────────────────────────────────────────────────────
async function getThumbnailUrl(assetId) {
  const json = await getJson(
    `https://thumbnails.roblox.com/v1/assets?assetIds=${assetId}&returnPolicy=PlaceHolder&size=420x420&format=Png&isCircular=false`
  );
  const url = json?.data?.[0]?.imageUrl;
  if (!url) throw new Error('No imageUrl from thumbnails API');
  return url;
}

async function fetchAllDetails(assetId) {
  const cached = cacheGet(assetId);
  if (cached) return cached;

  const [details, favJson] = await Promise.all([
    getJson(`https://economy.roblox.com/v2/assets/${assetId}/details`),
    getJson(`https://catalog.roblox.com/v1/favorites/assets/${assetId}/count`),
  ]);

  const result = {
    details,
    favourites: favJson?.count ?? null,
  };

  cacheSet(assetId, result);
  return result;
}

async function fetchImage(assetId) {
  const filePath = path.join(CACHE_DIR, `${assetId}.png`);
  if (fs.existsSync(filePath)) return filePath;

  const cdnUrl = await getThumbnailUrl(assetId);
  const { status, headers, body } = await httpsGet(cdnUrl);
  if (status !== 200) throw new Error(`CDN HTTP ${status}`);
  if (!(headers['content-type'] || '').startsWith('image/')) throw new Error('Not an image');
  fs.writeFileSync(filePath, body);
  return filePath;
}

// ── Hover ────────────────────────────────────────────────────────────────────
async function provideHover(document, position) {
  const line   = document.lineAt(position.line).text;
  const config = vscode.workspace.getConfiguration('rbxAssetPreview');
  const size   = Math.min(512, Math.max(128, config.get('imageSize', 256)));

  ASSET_ID_RE.lastIndex = 0;
  let match;

  while ((match = ASSET_ID_RE.exec(line)) !== null) {
    const start = match.index;
    const end   = match.index + match[0].length;
    if (position.character < start || position.character > end) continue;

    const assetId = match[1];
    const range   = new vscode.Range(position.line, start, position.line, end);

    const [imageResult, dataResult] = await Promise.allSettled([
      scheduleRequest(() => fetchImage(assetId)),
      scheduleRequest(() => fetchAllDetails(assetId)),
    ]);

    const d    = dataResult.status === 'fulfilled' ? dataResult.value?.details : null;
    const favs = dataResult.status === 'fulfilled' ? dataResult.value?.favourites : null;

    const lines = [];

    // ── Image ──
    if (imageResult.status === 'fulfilled') {
      const fileUri = vscode.Uri.file(imageResult.value).toString();
      lines.push(`![${assetId}](${fileUri}|width=${size})`);
    } else {
      lines.push(`⚠️ Image error: ${imageResult.reason?.message}`);
    }
    lines.push('');

    // ── Info ──
    const row = (label, value) => value != null ? `**${label}:** ${value}` : null;

    const type    = d?.AssetTypeId ? (ASSET_TYPES[d.AssetTypeId] || `Type ${d.AssetTypeId}`) : null;
    const creator = d?.Creator?.Name ?? null;
    const added   = d?.Created ? new Date(d.Created).toLocaleDateString('en-GB') : null;

    let price = null;
    if (d) {
      if (!d.IsForSale)           price = 'Not for sale';
      else if (d.PriceInRobux === 0) price = 'Free';
      else if (d.PriceInRobux)    price = `${d.PriceInRobux} R$`;
      if (d.IsLimitedUnique)      price = (price ? price + ' ' : '') + '🔴 Limited U';
      else if (d.IsLimited)       price = (price ? price + ' ' : '') + '🟡 Limited';
    }

    const sales = d?.Sales != null ? d.Sales.toLocaleString('en') : null;
    const favsStr = favs != null ? favs.toLocaleString('en') : null;

    const info = [
      row('Name',       d?.Name ?? assetId),
      row('Type',       type),
      row('Creator',    creator),
      row('Created',    added),
      row('Price',      price),
      row('Sales',      sales),
      row('Favorites',  favsStr),
    ].filter(Boolean);

    lines.push(info.join('  \n'));
    lines.push('');
    lines.push(`[Open on Roblox](https://www.roblox.com/catalog/${assetId}) · [Download via API](https://assetdelivery.roblox.com/v1/asset/?id=${assetId})`);

    const md = new vscode.MarkdownString(lines.join('\n\n'));
    md.isTrusted = true;
    return new vscode.Hover(md, range);
  }
}

function activate(context) {
  const provider = vscode.languages.registerHoverProvider(
    { scheme: 'file' },
    { provideHover }
  );
  context.subscriptions.push(provider);
}

function deactivate() {}
module.exports = { activate, deactivate };
