# Roblox Asset Previewer

<div align="center">
  <a href="https://open-vsx.org/extension/bluezczatu/roblox-asset-previewer">
    <img src="https://img.shields.io/open-vsx/dt/bluezczatu/roblox-asset-previewer?label=Open%20VSX%20Installs&color=blue&style=flat-square" alt="Open VSX Installs">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=bluezczatu.roblox-asset-previewer">
    <img src="https://vsmarketplacebadges.dev/installs-short/bluezczatu.roblox-asset-previewer.svg?style=flat-square&color=blue&subject=VS%20Marketplace%20Installs" alt="VS Marketplace Installs">
  </a>
  <br><br>
  <img src="https://imageapi.nordalts.com/files/unknown/DD8YX7x8GP8WyGBv29UL26zAQnMhlLt1" alt="Roblox Asset Previewer Showcase" width="100%">
</div>

**The future of Roblox development in VS Code is here.** 
Taking the mystery out of asset IDs, the Roblox Asset Previewer provides instant visual previews, author details, and advanced asset management directly inline with your code. Develop faster, debug smarter, and say goodbye to endless browser tabs!

[**Install from the VS Code Marketplace**](https://marketplace.visualstudio.com/items?itemName=bluezczatu.roblox-asset-previewer)

---

## ✨ Features

- **Instant Previews on Hover** — Works perfectly in Lua, Luau, JSON, YAML, and any other file type! Just hover over any `rbxassetid://` value to see the magic.
- **Premium Native In-Editor Audio Player** — Want to hear that sound effect? Click the `[Listen]` button to open a sleek, native HTML5 audio player in a dedicated VS Code webview tab right next to your code. No more annoying external media players popping up on your PC!
- **Private Asset Support (Open Cloud)** — Experience seamless access to your private universe! By providing a Roblox Open Cloud API Key, you can securely preview, listen to, and download private assets that you own or have access to.
- **Max Resolution Downloads** — With an API Key configured, image downloads bypass heavily compressed thumbnail servers. Your images (T-Shirts, Decals, etc.) are fetched from the Raw Asset Delivery API at their native, uncompressed resolution (up to 1024x1024 px).
- **Smart & Reliable Downloads** — Downloading an asset now opens a native VS Code "Save As" dialog so you can choose your exact destination. Files are dynamically analyzed and saved with the correct extension based on CDN headers (e.g., `.png`, `.mp3`, `.ogg`, `.lua`, `.rbxm`), ensuring zero broken formats.
- **Rich Asset Details** — Automatically fetches Name, Type, Creator, Created date, Price, Sales, and Favorites.
- **Reliable Thumbnail Loading** — The previewer intelligently checks Roblox thumbnail generation states and automatically retries if the asset is still processing—no more blank file icons!
- **Smart Caching & Rate Limiting** — Images and data are cached to disk so repeated interactions are instantaneous. Built-in rate limiting ensures you never hit Roblox API limits.
- **Quick Links** — Jump straight to the authentic Roblox Creator Store page with a single click.

---

## 🚀 Usage

It’s seamless! Just hover over any `rbxassetid://` or standard Roblox ID inside your code:

```lua
-- Simply hover over the ID below!
local icon = "rbxassetid://119167014749013"
```
A rich tooltip will instantly appear with the preview, details, and quick actions!

---

## 🔐 How to set up an API Key (Private Assets)

To unlock the full potential of this extension (previewing private assets and fetching uncompressed, native-resolution images), you must generate an API Key from the Roblox Creator Hub.

1. Go to the [Roblox Creator Hub - Credentials](https://create.roblox.com/credentials) page.
2. Click the **Create API Key** button.
3. Give it a descriptive name (e.g., *VS Code Asset Previewer*).
4. Scroll down to **Access Permissions**, click **Select API System** and choose **Assets**.
5. Assign the following roles to the systems:
   - For `legacy-assets`: select **`legacy-asset:manage`**
   - For `assets`: select **`asset:read`**
6. Click **Save and Generate Key**.
7. Copy the generated string.
8. Open your VS Code Settings (`Ctrl` + `,` or `Cmd` + `,`), search for `Roblox Asset Previewer`, and paste the copied string into the **API Key** field.

You're all set! 🚀

---

## ⚙️ Settings

| Setting | Default | Description |
|---|---|---|
| `RobloxAssetPreviewer.imageSize` | `256` | Preview image size in pixels (128–512) |
| `RobloxAssetPreviewer.apiKey` | `""` | Roblox Open Cloud API Key for private asset access |
| `RobloxAssetPreviewer.oauthToken` | `""` | Roblox Open Cloud OAuth 2.0 Bearer Token |

---

**Questions, bugs, or suggestions?** Feel free to drop by our [GitHub Repository](https://github.com/bluezczatu/Roblox-Assets-Previewer) to create an issue and contribute to making this the ultimate Roblox extension for VS Code!