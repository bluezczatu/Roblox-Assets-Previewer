The Roblox Asset Previewer for VS Code takes the mystery out of asset IDs. Get instant visual previews, author details, and asset types displayed inline with your scripts. Develop faster, debug smarter.

## Features

- **Image preview on hover** — works in Lua, Luau, JSON, YAML, and any other file type
- **Asset details** — Name, Type, Creator, Created date, Price, Sales, and Favorites fetched automatically
- **Smart caching** — images are saved to disk, detail responses are cached for 5 minutes so repeated hovers are instant and won't spam Roblox
- **Built-in rate limiting** — requests are queued to keep you safe from hitting Roblox API limits
- **Quick links** — jump straight to the asset page on Roblox or download it via the delivery API

## Usage

Just hover over any `rbxassetid://` value in your script:

```lua
local icon = "rbxassetid://119167014749013"
```

A tooltip will appear with the asset preview and details.

## Settings

| Setting | Default | Description |
|---|---|---|
| `RobloxAssetPreviewer.imageSize` | `256` | Preview image size in pixels (128–512) |