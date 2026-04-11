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

// Asset type → file extension + filter label for save dialog
const ASSET_EXTENSIONS = {
  1:  { ext: '.png',  label: 'PNG Image' },
  2:  { ext: '.png',  label: 'PNG Image' },   // TShirt
  3:  { ext: '.ogg',  label: 'Audio' },
  4:  { ext: '.mesh', label: 'Mesh' },
  5:  { ext: '.lua',  label: 'Lua Script' },
  8:  { ext: '.rbxm', label: 'Roblox Model' }, // Hat
  9:  { ext: '.rbxl', label: 'Roblox Place' },
  10: { ext: '.rbxm', label: 'Roblox Model' },
  11: { ext: '.png',  label: 'PNG Image' },   // Shirt
  12: { ext: '.png',  label: 'PNG Image' },   // Pants
  13: { ext: '.png',  label: 'PNG Image' },   // Decal
  17: { ext: '.rbxm', label: 'Roblox Model' }, // Head
  18: { ext: '.png',  label: 'PNG Image' },   // Face
  19: { ext: '.rbxm', label: 'Roblox Model' }, // Gear
  21: { ext: '.png',  label: 'PNG Image' },   // Badge
  24: { ext: '.rbxm', label: 'Roblox Model' }, // Animation
  34: { ext: '.rbxm', label: 'Roblox Model' }, // GamePass
  38: { ext: '.rbxm', label: 'Roblox Model' }, // Plugin
  40: { ext: '.mesh', label: 'Mesh' },
  54: { ext: '.mesh', label: 'Mesh' },
  62: { ext: '.webm', label: 'Video' },
  64: { ext: '.ogg',  label: 'Audio' },
  65: { ext: '.lua',  label: 'Lua Script' },
};

// ── Cache ─────────────────────────────────────────────────────────────────────
const TTL_MS      = 5 * 60 * 1000;
const detailCache = new Map();

function cacheGet(id) {
  const entry = detailCache.get(id);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) { detailCache.delete(id); return null; }
  return entry.data;
}
function cacheSet(id, data) { detailCache.set(id, { data, ts: Date.now() }); }

// ── Rate limiter ──────────────────────────────────────────────────────────────
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

// ── HTTP helper ───────────────────────────────────────────────────────────────
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

// ── API calls ─────────────────────────────────────────────────────────────────
async function getThumbnailUrl(assetId, retries = 3) {
  const json = await getJson(
    `https://thumbnails.roblox.com/v1/assets?assetIds=${assetId}&returnPolicy=Pending&size=420x420&format=Png&isCircular=false`
  );

  const item  = json?.data?.[0];
  const state = item?.state;
  const url   = item?.imageUrl;

  if (state === 'Blocked') throw new Error('Asset is moderated');
  if (state === 'Completed' && url) return url;

  // Pending — miniatura jest generowana, retry
  if (retries > 0) {
    await new Promise(r => setTimeout(r, 1500));
    return getThumbnailUrl(assetId, retries - 1);
  }

  throw new Error(`Thumbnail not ready (state: ${state ?? 'unknown'})`);
}

async function fetchAllDetails(assetId) {
  const cached = cacheGet(assetId);
  if (cached) return cached;

  const [details, favJson] = await Promise.all([
    getJson(`https://economy.roblox.com/v2/assets/${assetId}/details`),
    getJson(`https://catalog.roblox.com/v1/favorites/assets/${assetId}/count`),
  ]);

  const result = { details, favourites: favJson?.count ?? null };
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

// ── Download command ──────────────────────────────────────────────────────────
async function downloadAsset(assetId, assetTypeId) {
  try {
    const typeInfo = ASSET_EXTENSIONS[assetTypeId] ?? { ext: '.bin', label: 'File' };
    const { ext, label } = typeInfo;

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), `${assetId}${ext}`)),
      filters: { [label]: [ext.replace('.', '')] },
    });
    if (!saveUri) return;

    const IMAGE_TYPES = new Set([1, 2, 11, 12, 13, 18, 21]);
    if (IMAGE_TYPES.has(assetTypeId)) {
      // Use cached thumbnail — assetdelivery requires auth for images
      const cachedPath = await fetchImage(assetId);
      fs.copyFileSync(cachedPath, saveUri.fsPath);
    } else {
      const { status, body } = await httpsGet(
        `https://assetdelivery.roblox.com/v1/asset/?id=${assetId}`
      );
      if (status === 401) throw new Error('Asset requires authentication — cannot download');
      if (status !== 200) throw new Error(`HTTP ${status}`);
      fs.writeFileSync(saveUri.fsPath, body);
    }

    vscode.window.showInformationMessage(`Saved: ${path.basename(saveUri.fsPath)}`);
  } catch (err) {
    vscode.window.showErrorMessage(`Download failed: ${err.message}`);
  }
}

// ── Hover ─────────────────────────────────────────────────────────────────────
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

    // Image
    if (imageResult.status === 'fulfilled') {
      const fileUri = vscode.Uri.file(imageResult.value).toString();
      lines.push(`![${assetId}](${fileUri}|width=${size})`);
    } else {
      lines.push(`⚠️ Image error: ${imageResult.reason?.message}`);
    }
    lines.push('');

    // Info
    const row = (label, value) => value != null ? `**${label}:** ${value}` : null;

    const assetTypeId = d?.AssetTypeId ?? null;
    const type        = assetTypeId ? (ASSET_TYPES[assetTypeId] || `Type ${assetTypeId}`) : null;
    const ext         = assetTypeId ? (ASSET_EXTENSIONS[assetTypeId]?.ext ?? '.bin') : null;
    const creator     = d?.Creator?.Name ?? null;
    const added       = d?.Created ? new Date(d.Created).toLocaleDateString('en-GB') : null;

    let price = null;
    if (d) {
      if (!d.IsForSale)              price = 'Not for sale';
      else if (d.PriceInRobux === 0) price = 'Free';
      else if (d.PriceInRobux)       price = `${d.PriceInRobux} R$`;
      if (d.IsLimitedUnique)         price = (price ? price + ' ' : '') + '🔴 Limited U';
      else if (d.IsLimited)          price = (price ? price + ' ' : '') + '🟡 Limited';
    }

    const sales   = d?.Sales != null ? d.Sales.toLocaleString('en') : null;
    const favsStr = favs != null ? favs.toLocaleString('en') : null;

    const info = [
      row('Name',      d?.Name ?? assetId),
      row('Type',      type ? `${type} (${assetTypeId})` : null),
      row('Extension', ext),
      row('Creator',   creator),
      row('Created',   added),
      row('Price',     price),
      row('Sales',     sales),
      row('Favorites', favsStr),
    ].filter(Boolean);

    lines.push(info.join('  \n'));
    lines.push('');

    const downloadCmd = `command:rbxAssetPreview.download?${encodeURIComponent(JSON.stringify([assetId, assetTypeId]))}`;
    lines.push(`[Open on Roblox](https://create.roblox.com/store/asset/${assetId}) · [Download ${ext ?? ''}](${downloadCmd})`);

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

  const downloadCmd = vscode.commands.registerCommand(
    'rbxAssetPreview.download',
    (assetId, assetTypeId) => downloadAsset(assetId, assetTypeId)
  );

  context.subscriptions.push(provider, downloadCmd);
}

function deactivate() {}
module.exports = { activate, deactivate };