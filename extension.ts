declare const require: any;
declare const module: { exports: unknown };
declare const Buffer: any;

const vscode = require('vscode') as any;
const https = require('https') as any;
const fs = require('fs') as any;
const os = require('os') as any;
const path = require('path') as any;

type Nullable<T> = T | null;

interface AssetTypeInfo {
  ext: string;
  label: string;
}

interface CreatorInfo {
  Name?: string;
}

interface AssetDetails {
  AssetTypeId?: number;
  Name?: string;
  Creator?: CreatorInfo;
  Created?: string;
  IsForSale?: boolean;
  PriceInRobux?: number;
  IsLimitedUnique?: boolean;
  IsLimited?: boolean;
  Sales?: number;
}

interface AssetDetailsResult {
  details: Nullable<AssetDetails>;
  favourites: Nullable<number>;
}

interface CacheEntry<T> {
  data: T;
  ts: number;
}

interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

interface PendingRequest<T> {
  fn: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

const ASSET_ID_RE =
  /(?:Content\.fromUri\(\s*['"`]?rbxassetid:\/\/(\d+)['"`]?\s*\))|(?:Content\.fromAssetId\(\s*(\d+)\s*\))|(?:rbxassetid:\/\/(\d+))/gi;

const CACHE_DIR = path.join(os.tmpdir(), 'roblox-assets-cache-v2');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const ASSET_TYPES: Record<number, string> = {
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

const ASSET_EXTENSIONS: Record<number, AssetTypeInfo> = {
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

const IMAGE_TYPES = new Set<number>([1, 2, 11, 12, 13, 18, 21]);
const AUDIO_TYPES = new Set<number>([3, 64]);

const TTL_MS = 5 * 60 * 1000;
const detailCache = new Map<string, CacheEntry<AssetDetailsResult>>();

function cacheGet(id: string): Nullable<AssetDetailsResult> {
  const entry = detailCache.get(id);
  if (!entry) {
    return null;
  }

  if (Date.now() - entry.ts > TTL_MS) {
    detailCache.delete(id);
    return null;
  }

  return entry.data;
}

function cacheSet(id: string, data: AssetDetailsResult): void {
  detailCache.set(id, { data, ts: Date.now() });
}

const queue: Array<PendingRequest<unknown>> = [];
let lastFired = 0;

function scheduleRequest<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({
      fn,
      resolve: resolve as PendingRequest<unknown>['resolve'],
      reject,
    });
    drainQueue();
  });
}

function drainQueue(): void {
  if (!queue.length) {
    return;
  }

  const now = Date.now();
  const wait = Math.max(0, 300 - (now - lastFired));

  setTimeout(() => {
    if (!queue.length) {
      return;
    }

    const next = queue.shift();
    if (!next) {
      return;
    }

    lastFired = Date.now();
    next.fn().then(next.resolve).catch(next.reject);
    drainQueue();
  }, wait);
}

function httpsGet(
  url: string,
  options: Record<string, unknown> | number = {},
  redirects = 0
): Promise<HttpResponse> {
  if (typeof options === 'number') {
    redirects = options;
    options = {};
  }

  return new Promise<HttpResponse>((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('Too many redirects'));
      return;
    }

    https
      .get(url, options, (res: any) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          httpsGet(res.headers.location, options, redirects + 1).then(resolve).catch(reject);
          return;
        }

        const chunks: any[] = [];
        res.on('data', (chunk: any) => chunks.push(chunk));
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

async function getJson(url: string): Promise<any> {
  const { status, body } = await httpsGet(url);
  if (status !== 200) {
    return null;
  }

  try {
    return JSON.parse(body.toString());
  } catch {
    return null;
  }
}

async function getThumbnailUrl(assetId: string, retries = 3): Promise<string> {
  const json = await getJson(
    `https://thumbnails.roblox.com/v1/assets?assetIds=${assetId}&returnPolicy=Pending&size=420x420&format=Png&isCircular=false`
  );

  const item = json?.data?.[0];
  const state = item?.state;
  const url = item?.imageUrl;

  if (state === 'Blocked') {
    throw new Error('Asset is moderated');
  }

  if (state === 'Completed' && url) {
    return url;
  }

  if (retries > 0) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return getThumbnailUrl(assetId, retries - 1);
  }

  throw new Error(`Thumbnail not ready (state: ${state ?? 'unknown'})`);
}

async function fetchAllDetails(assetId: string): Promise<AssetDetailsResult> {
  const cached = cacheGet(assetId);
  if (cached) {
    return cached;
  }

  const [details, favJson] = await Promise.all([
    getJson(`https://economy.roblox.com/v2/assets/${assetId}/details`),
    getJson(`https://catalog.roblox.com/v1/favorites/assets/${assetId}/count`),
  ]);

  const result: AssetDetailsResult = { details, favourites: favJson?.count ?? null };
  cacheSet(assetId, result);
  return result;
}

async function fetchImage(assetId: string): Promise<string> {
  const filePath = path.join(CACHE_DIR, `${assetId}.png`);
  if (fs.existsSync(filePath)) {
    return filePath;
  }

  const cdnUrl = await getThumbnailUrl(assetId);
  const { status, headers, body } = await httpsGet(cdnUrl);
  if (status !== 200) {
    throw new Error(`CDN HTTP ${status}`);
  }

  if (!String(headers['content-type'] || '').startsWith('image/')) {
    throw new Error('Not an image');
  }

  fs.writeFileSync(filePath, body);
  return filePath;
}

async function fetchAssetFile(assetId: string, assetTypeId: Nullable<number>): Promise<string> {
  const baseFilePath = path.join(CACHE_DIR, assetId);
  const exts = ['.png', '.ogg', '.mp3', '.mesh', '.lua', '.rbxm', '.rbxl', '.webm', '.bin'];
  for (const ext of exts) {
    const candidate = baseFilePath + ext;
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const typeInfo =
    assetTypeId != null
      ? { ...(ASSET_EXTENSIONS[assetTypeId] ?? { ext: '.bin', label: 'File' }) }
      : { ext: '.bin', label: 'File' };
  const config = vscode.workspace.getConfiguration('RobloxAssetPreviewer');
  const apiKey = config.get('apiKey') as string | undefined;
  const oauthToken = config.get('oauthToken') as string | undefined;

  if (apiKey || oauthToken) {
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    } else if (oauthToken) {
      headers.Authorization = `Bearer ${oauthToken}`;
    }

    const { status, body } = await httpsGet(
      `https://apis.roblox.com/asset-delivery-api/v1/assetId/${assetId}`,
      { headers }
    );

    if (status === 401 || status === 403) {
      throw new Error('Authentication failed - API key or OAuth token invalid');
    }

    if (status !== 200) {
      throw new Error(`HTTP ${status} (Open Cloud)`);
    }

    let location: Nullable<string> = null;
    try {
      const json = JSON.parse(body.toString());
      location = json.location ?? null;
    } catch {
      throw new Error('Invalid JSON response from Asset Delivery API');
    }

    if (!location) {
      throw new Error('No location returned from Asset Delivery API');
    }

    const { status: assetStatus, headers: assetHeaders, body: assetBody } = await httpsGet(location);
    if (assetStatus !== 200) {
      throw new Error(`HTTP ${assetStatus} from CDN`);
    }

    const contentType = String(assetHeaders['content-type'] || '');
    if (contentType.includes('audio/mpeg')) {
      typeInfo.ext = '.mp3';
    } else if (contentType.includes('audio/ogg')) {
      typeInfo.ext = '.ogg';
    }

    const finalPath = baseFilePath + typeInfo.ext;
    fs.writeFileSync(finalPath, assetBody);
    return finalPath;
  }

  const { status, headers, body } = await httpsGet(
    `https://assetdelivery.roblox.com/v1/asset/?id=${assetId}`
  );
  if (status === 401) {
    throw new Error(
      'Asset requires authentication - please provide Open Cloud API key or OAuth token in VS Code settings'
    );
  }

  if (status !== 200) {
    throw new Error(`HTTP ${status}`);
  }

  const contentType = String(headers['content-type'] || '');
  if (contentType.includes('audio/mpeg')) {
    typeInfo.ext = '.mp3';
  } else if (contentType.includes('audio/ogg')) {
    typeInfo.ext = '.ogg';
  }

  const finalPath = baseFilePath + typeInfo.ext;
  fs.writeFileSync(finalPath, body);
  return finalPath;
}

async function downloadAsset(assetId: string, assetTypeId: Nullable<number>): Promise<void> {
  try {
    const typeInfo =
      assetTypeId != null
        ? (ASSET_EXTENSIONS[assetTypeId] ?? { ext: '.bin', label: 'File' })
        : { ext: '.bin', label: 'File' };
    const { ext, label } = typeInfo;

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), `${assetId}${ext}`)),
      filters: { [label]: [ext.replace('.', '')] },
    });
    if (!saveUri) {
      return;
    }

    const config = vscode.workspace.getConfiguration('RobloxAssetPreviewer');
    const hasAuth = Boolean(config.get('apiKey') || config.get('oauthToken'));

    if (assetTypeId != null && IMAGE_TYPES.has(assetTypeId) && !hasAuth) {
      const cachedPath = await fetchImage(assetId);
      fs.copyFileSync(cachedPath, saveUri.fsPath);
    } else {
      const localPath = await fetchAssetFile(assetId, assetTypeId);
      fs.copyFileSync(localPath, saveUri.fsPath);
    }

    vscode.window.showInformationMessage(`Saved: ${path.basename(saveUri.fsPath)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    vscode.window.showErrorMessage(`Download failed: ${message}`);
  }
}

let currentAudioPanel: any = null;

async function listenToAudio(assetId: string, assetTypeId: Nullable<number>): Promise<void> {
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
        localResourceRoots: [vscode.Uri.file(CACHE_DIR)],
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
    const message = err instanceof Error ? err.message : 'Unknown error';
    vscode.window.showErrorMessage(`Audio preview failed: ${message}`);
  }
}

async function provideHover(document: any, position: any): Promise<any> {
  const line = document.lineAt(position.line).text as string;
  const config = vscode.workspace.getConfiguration('RobloxAssetPreviewer');
  const configuredSize = Number(config.get('imageSize', 256));
  const size = Math.min(512, Math.max(128, configuredSize));

  ASSET_ID_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = ASSET_ID_RE.exec(line)) !== null) {
    const start = match.index;
    const end = match.index + match[0].length;
    if (position.character < start || position.character > end) {
      continue;
    }

    const assetId = match[1] || match[2] || match[3];
    const range = new vscode.Range(position.line, start, position.line, end);

    const [imageResult, dataResult] = await Promise.allSettled([
      scheduleRequest(() => fetchImage(assetId)),
      scheduleRequest(() => fetchAllDetails(assetId)),
    ]);

    const details =
      dataResult.status === 'fulfilled' ? (dataResult.value as AssetDetailsResult).details : null;
    const favourites =
      dataResult.status === 'fulfilled'
        ? (dataResult.value as AssetDetailsResult).favourites
        : null;

    const lines: string[] = [];
    const assetTypeId = details?.AssetTypeId ?? null;

    if (assetTypeId == null || !AUDIO_TYPES.has(assetTypeId)) {
      if (imageResult.status === 'fulfilled') {
        const fileUri = vscode.Uri.file(imageResult.value as string).toString();
        lines.push(`![${assetId}](${fileUri}|width=${size})`);
      } else {
        const reason =
          imageResult.reason instanceof Error ? imageResult.reason.message : 'unknown error';
        lines.push(`Warning: image unavailable (${reason})`);
      }
      lines.push('');
    }

    const row = (label: string, value: Nullable<string>): Nullable<string> =>
      value != null ? `**${label}:** ${value}` : null;

    const type = assetTypeId != null ? (ASSET_TYPES[assetTypeId] || `Type ${assetTypeId}`) : null;
    const ext = assetTypeId != null ? (ASSET_EXTENSIONS[assetTypeId]?.ext ?? '.bin') : null;
    const creator = details?.Creator?.Name ?? null;
    const added = details?.Created ? new Date(details.Created).toLocaleDateString('en-GB') : null;

    let price: Nullable<string> = null;
    if (details) {
      if (!details.IsForSale) {
        price = 'Not for sale';
      } else if (details.PriceInRobux === 0) {
        price = 'Free';
      } else if (details.PriceInRobux) {
        price = `${details.PriceInRobux} R$`;
      }

      if (details.IsLimitedUnique) {
        price = `${price ? `${price} ` : ''}Limited U`;
      } else if (details.IsLimited) {
        price = `${price ? `${price} ` : ''}Limited`;
      }
    }

    const sales = details?.Sales != null ? details.Sales.toLocaleString('en') : null;
    const favoritesText = favourites != null ? favourites.toLocaleString('en') : null;

    const info = [
      row('Name', details?.Name ?? assetId),
      row('Type', type ? `${type} (${assetTypeId})` : null),
      row('Extension', ext),
      row('Creator', creator),
      row('Created', added),
      row('Price', price),
      row('Sales', sales),
      row('Favorites', favoritesText),
    ].filter((value): value is string => Boolean(value));

    lines.push(info.join('  \n'));
    lines.push('');

    const actions = [`[Open on Roblox](https://create.roblox.com/store/asset/${assetId})`];
    const downloadCmd = `command:RobloxAssetPreviewer.download?${encodeURIComponent(
      JSON.stringify([assetId, assetTypeId])
    )}`;
    actions.push(`[Download ${ext ?? ''}](${downloadCmd})`);

    if (assetTypeId != null && AUDIO_TYPES.has(assetTypeId)) {
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

  return null;
}

function activate(context: any): void {
  const provider = vscode.languages.registerHoverProvider({ scheme: 'file' }, { provideHover });

  const downloadCmd = vscode.commands.registerCommand(
    'RobloxAssetPreviewer.download',
    (assetId: string, assetTypeId: Nullable<number>) => downloadAsset(assetId, assetTypeId)
  );

  const listenCmd = vscode.commands.registerCommand(
    'RobloxAssetPreviewer.listen',
    (assetId: string, assetTypeId: Nullable<number>) => listenToAudio(assetId, assetTypeId)
  );

  context.subscriptions.push(provider, downloadCmd, listenCmd);
}

function deactivate(): void {}

module.exports = { activate, deactivate };
