const vscode = require('vscode');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Zaktualizowany RegEx wykrywający 3 formaty:
// 1. Content.fromUri("rbxassetid://12345")
// 2. Content.fromAssetId(12345)
// 3. rbxassetid://12345
const ASSET_ID_RE = /(?:Content\.fromUri\(\s*['"`]?rbxassetid:\/\/(\d+)['"`]?\s*\))|(?:Content\.fromAssetId\(\s*(\d+)\s*\))|(?:rbxassetid:\/\/(\d+))/gi;

const CACHE_DIR = path.join(os.tmpdir(), 'roblox-assets-cache-v2');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const ASSET_TYPES = {
  1: 'Image',
  2: 'TShirt',
  3: 'Audio',
  4: 'Mesh',
  5: 'Lua',
  8: 'Hat',
  9: 'Place',
  10: 'Model',
  11: 'Shirt',
  12: 'Pants',
  13: 'Decal',
  17: 'Head',
  18: 'Face',
  19: 'Gear',
  21: 'Badge',
  24: 'Animation',
  34: 'GamePass',
  38: 'Plugin',
  40: 'MeshPart',
  54: 'CSGMesh',
  62: 'Video',
  64: 'Sound',
  65: 'Script',
};

const ASSET_EXTENSIONS = {
  1: { ext: '.png', label: 'PNG Image' },
  2: { ext: '.png', label: 'PNG Image' },
  3: { ext: '.ogg', label: 'Audio' },
  4: { ext: '.mesh', label: 'Mesh' },
  5: { ext: '.lua', label: 'Lua Script' },
  8: { ext: '.rbxm', label: 'Roblox Model' },
  9: { ext: '.rbxl', label: 'Roblox Place' },
  10: { ext: '.rbxm', label: 'Roblox Model' },
  11: { ext: '.png', label: 'PNG Image' },
  12: { ext: '.png', label: 'PNG Image' },
  13: { ext: '.png', label: 'PNG Image' },
  17: { ext: '.rbxm', label: 'Roblox Model' },
  18: { ext: '.png', label: 'PNG Image' },
  19: { ext: '.rbxm', label: 'Roblox Model' },
  21: { ext: '.png', label: 'PNG Image' },
  24: { ext: '.rbxm', label: 'Roblox Model' },
  34: { ext: '.rbxm', label: 'Roblox Model' },
  38: { ext: '.rbxm', label: 'Roblox Model' },
  40: { ext: '.mesh', label: 'Mesh' },
  54: { ext: '.mesh', label: 'Mesh' },
  62: { ext: '.webm', label: 'Video' },
  64: { ext: '.ogg', label: 'Audio' },
  65: { ext: '.lua', label: 'Lua Script' },
};

const IMAGE_TYPES = new Set([1, 2, 11, 12, 13, 18, 21]);
const AUDIO_TYPES = new Set([3, 64]);

const TTL_MS = 5 * 60 * 1000;
const detailCache = new Map();

function cacheGet(id) {
  const entry = detailCache.get(id);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) {
    detailCache.delete(id);
    return null;
  }
  return entry.data;
}

function cacheSet(id, data) {
  detailCache.set(id, { data, ts: Date.now() });
}

const queue = [];
let lastFired = 0;

function scheduleRequest(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    drainQueue();
  });
}

function drainQueue() {
  if (!queue.length) return;
  const now = Date.now();
  const wait = Math.max(0, 300 - (now - lastFired));
  setTimeout(() => {
    if (!queue.length) return;
    const { fn, resolve, reject } = queue.shift();
    lastFired = Date.now();
    fn().then(resolve).catch(reject);
    drainQueue();
  }, wait);
}

function httpsGet(url, options = {}, redirects = 0) {
  if (typeof options === 'number') {
    redirects = options;
    options = {};
  }
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    https
      .get(url, options, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          return httpsGet(res.headers.location, options, redirects + 1).then(resolve).catch(reject);
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        );
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

async function getJson(url) {
  const { status, body } = await httpsGet(url);
  if (status !== 200) return null;
  try {
    return JSON.parse(body.toString());
  } catch {
    return null;
  }
}

async function getThumbnailUrl(assetId, retries = 3) {
  const json = await getJson(
    `https://thumbnails.roblox.com/v1/assets?assetIds=${assetId}&returnPolicy=Pending&size=420x420&format=Png&isCircular=false`
  );

  const item = json?.data?.[0];
  const state = item?.state;
  const url = item?.imageUrl;

  if (state === 'Blocked') throw new Error('Asset is moderated');
  if (state === 'Completed' && url) return url;

  if (retries > 0) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
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

async function fetchAssetFile(assetId, assetTypeId) {
  const baseFilePath = path.join(CACHE_DIR, assetId.toString());
  const exts = ['.png', '.ogg', '.mp3', '.mesh', '.lua', '.rbxm', '.rbxl', '.webm', '.bin'];
  for (const x of exts) {
    if (fs.existsSync(baseFilePath + x)) return baseFilePath + x;
  }

  const typeInfo = ASSET_EXTENSIONS[assetTypeId] ? { ...ASSET_EXTENSIONS[assetTypeId] } : { ext: '.bin', label: 'File' };

  const config = vscode.workspace.getConfiguration('RobloxAssetPreviewer');
  const apiKey = config.get('apiKey');
  const oauthToken = config.get('oauthToken');

  if (apiKey || oauthToken) {
    const headers = {};
    if (apiKey) headers['x-api-key'] = apiKey;
    else if (oauthToken) headers['Authorization'] = `Bearer ${oauthToken}`;

    const { status, body } = await httpsGet(
      `https://apis.roblox.com/asset-delivery-api/v1/assetId/${assetId}`,
      { headers }
    );

    if (status === 401 || status === 403) throw new Error('Authentication failed - API key or OAuth token invalid');
    if (status !== 200) throw new Error(`HTTP ${status} (Open Cloud)`);

    let location;
    try {
      const json = JSON.parse(body.toString());
      location = json.location;
    } catch {
      throw new Error('Invalid JSON response from Asset Delivery API');
    }

    if (!location) throw new Error('No location returned from Asset Delivery API');

    const { status: assetStatus, headers: assetHeaders, body: assetBody } = await httpsGet(location);
    if (assetStatus !== 200) throw new Error(`HTTP ${assetStatus} from CDN`);
    
    const contentType = assetHeaders['content-type'] || '';
    if (contentType.includes('audio/mpeg')) typeInfo.ext = '.mp3';
    else if (contentType.includes('audio/ogg')) typeInfo.ext = '.ogg';

    const finalPath = baseFilePath + typeInfo.ext;
    fs.writeFileSync(finalPath, assetBody);
    return finalPath;
  }

  const { status, headers, body } = await httpsGet(
    `https://assetdelivery.roblox.com/v1/asset/?id=${assetId}`
  );
  if (status === 401) throw new Error('Asset requires authentication - please provide Open Cloud API key or OAuth token in VS Code settings');
  if (status !== 200) throw new Error(`HTTP ${status}`);

  const contentType = headers['content-type'] || '';
  if (contentType.includes('audio/mpeg')) typeInfo.ext = '.mp3';
  else if (contentType.includes('audio/ogg')) typeInfo.ext = '.ogg';

  const finalPath = baseFilePath + typeInfo.ext;
  fs.writeFileSync(finalPath, body);
  return finalPath;
}

async function downloadAsset(assetId, assetTypeId) {
  try {
    const typeInfo = ASSET_EXTENSIONS[assetTypeId] ?? { ext: '.bin', label: 'File' };
    const { ext, label } = typeInfo;

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), `${assetId}${ext}`)),
      filters: { [label]: [ext.replace('.', '')] },
    });
    if (!saveUri) return;

    const config = vscode.workspace.getConfiguration('RobloxAssetPreviewer');
    const hasAuth = config.get('apiKey') || config.get('oauthToken');

    if (IMAGE_TYPES.has(assetTypeId) && !hasAuth) {
      const cachedPath = await fetchImage(assetId);
      fs.copyFileSync(cachedPath, saveUri.fsPath);
    } else {
      const localPath = await fetchAssetFile(assetId, assetTypeId);
      fs.copyFileSync(localPath, saveUri.fsPath);
    }

    vscode.window.showInformationMessage(`Saved: ${path.basename(saveUri.fsPath)}`);
  } catch (err) {
    vscode.window.showErrorMessage(`Download failed: ${err.message}`);
  }
}

let currentAudioPanel = null;

async function listenToAudio(assetId, assetTypeId) {
  try {
    const localPath = await fetchAssetFile(assetId, assetTypeId);
    
    if (currentAudioPanel) {
      currentAudioPanel.dispose();
    }

    currentAudioPanel = vscode.window.createWebviewPanel(
      'rbxAudioPreview',
      `Audio: ${assetId}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(CACHE_DIR)]
      }
    );

    currentAudioPanel.onDidDispose(() => {
      currentAudioPanel = null;
    });

    const webviewUri = currentAudioPanel.webview.asWebviewUri(vscode.Uri.file(localPath));

    currentAudioPanel.webview.html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src ${currentAudioPanel.webview.cspSource}; style-src 'unsafe-inline';">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Audio Preview</title>
        <style>
          body { 
            display: flex; 
            justify-content: center; 
            align-items: center; 
            height: 100vh; 
            margin: 0; 
            background-color: var(--vscode-editor-background); 
            color: var(--vscode-editor-foreground); 
            flex-direction: column; 
            font-family: var(--vscode-font-family); 
          }
          audio { 
            outline: none; 
            margin-top: 20px; 
            width: 80%;
            max-width: 400px;
          }
        </style>
      </head>
      <body>
        <h3>Roblox Asset: ${assetId}</h3>
        <audio controls autoplay src="${webviewUri}"></audio>
      </body>
      </html>
    `;
  } catch (err) {
    vscode.window.showErrorMessage(`Audio preview failed: ${err.message}`);
  }
}

async function provideHover(document, position) {
  const line = document.lineAt(position.line).text;
  const config = vscode.workspace.getConfiguration('RobloxAssetPreviewer');
  const size = Math.min(512, Math.max(128, config.get('imageSize', 256)));

  ASSET_ID_RE.lastIndex = 0;
  let match;

  while ((match = ASSET_ID_RE.exec(line)) !== null) {
    const start = match.index;
    const end = match.index + match[0].length;
    if (position.character < start || position.character > end) continue;

    // Poprawione zbieranie AssetID ze wszystkich 3 grup RegExa
    const assetId = match[1] || match[2] || match[3];
    const range = new vscode.Range(position.line, start, position.line, end);

    const [imageResult, dataResult] = await Promise.allSettled([
      scheduleRequest(() => fetchImage(assetId)),
      scheduleRequest(() => fetchAllDetails(assetId)),
    ]);

    const details = dataResult.status === 'fulfilled' ? dataResult.value?.details : null;
    const favourites = dataResult.status === 'fulfilled' ? dataResult.value?.favourites : null;

    const lines = [];

    const assetTypeId = details?.AssetTypeId ?? null;

    if (!assetTypeId || !AUDIO_TYPES.has(assetTypeId)) {
      if (imageResult.status === 'fulfilled') {
        const fileUri = vscode.Uri.file(imageResult.value).toString();
        lines.push(`![${assetId}](${fileUri}|width=${size})`);
      } else {
        lines.push(`Warning: image unavailable (${imageResult.reason?.message ?? 'unknown error'})`);
      }
      lines.push('');
    }

    const row = (label, value) => (value != null ? `**${label}:** ${value}` : null);
    const type = assetTypeId ? ASSET_TYPES[assetTypeId] || `Type ${assetTypeId}` : null;
    const ext = assetTypeId ? ASSET_EXTENSIONS[assetTypeId]?.ext ?? '.bin' : null;
    const creator = details?.Creator?.Name ?? null;
    const added = details?.Created ? new Date(details.Created).toLocaleDateString('en-GB') : null;

    let price = null;
    if (details) {
      if (!details.IsForSale) price = 'Not for sale';
      else if (details.PriceInRobux === 0) price = 'Free';
      else if (details.PriceInRobux) price = `${details.PriceInRobux} R$`;

      if (details.IsLimitedUnique) price = `${price ? `${price} ` : ''}Limited U`;
      else if (details.IsLimited) price = `${price ? `${price} ` : ''}Limited`;
    }

    const sales = details?.Sales != null ? details.Sales.toLocaleString('en') : null;
    const favsStr = favourites != null ? favourites.toLocaleString('en') : null;

    const info = [
      row('Name', details?.Name ?? assetId),
      row('Type', type ? `${type} (${assetTypeId})` : null),
      row('Extension', ext),
      row('Creator', creator),
      row('Created', added),
      row('Price', price),
      row('Sales', sales),
      row('Favorites', favsStr),
    ].filter(Boolean);

    lines.push(info.join('  \n'));
    lines.push('');

    const actions = [`[Open on Roblox](https://create.roblox.com/store/asset/${assetId})`];
    const downloadCmd = `command:RobloxAssetPreviewer.download?${encodeURIComponent(
      JSON.stringify([assetId, assetTypeId])
    )}`;
    actions.push(`[Download ${ext ?? ''}](${downloadCmd})`);

    if (AUDIO_TYPES.has(assetTypeId)) {
      const listenCmd = `command:RobloxAssetPreviewer.listen?${encodeURIComponent(
        JSON.stringify([assetId, assetTypeId])
      )}`;
      actions.push(`[Listen](${listenCmd})`);
    }

    lines.push(actions.join(' · '));

    const md = new vscode.MarkdownString(lines.join('\n\n'));
    md.isTrusted = true;
    return new vscode.Hover(md, range);
  }
}

function activate(context) {
  const provider = vscode.languages.registerHoverProvider({ scheme: 'file' }, { provideHover });

  const downloadCmd = vscode.commands.registerCommand('RobloxAssetPreviewer.download', (assetId, assetTypeId) =>
    downloadAsset(assetId, assetTypeId)
  );

  const listenCmd = vscode.commands.registerCommand('RobloxAssetPreviewer.listen', (assetId, assetTypeId) =>
    listenToAudio(assetId, assetTypeId)
  );

  context.subscriptions.push(provider, downloadCmd, listenCmd);
}

function deactivate() {}

module.exports = { activate, deactivate };