# ADO Lens

A tiny Chrome and Firefox extension that adds compact stats chips to the Azure DevOps PR tab row and a detailed bottom-right stats floater.

It shows:

- lines added and removed
- files and commits
- reviewer approvals
- check/status results
- comments, linked work items, and PR age

The extension has no background worker, third-party service, or analytics. It makes same-origin Azure DevOps REST requests with the session already active in the page. File contents are used in memory to calculate line changes and are never persisted. Large and binary files are skipped and marked as partial in the UI. Browser sync storage is used only for extension settings.

## Project layout

- `chrome/` — Chrome manifest and build script
- `firefox/` — Firefox manifest and build script
- `shared/` — shared runtime code, settings page, and tests

## Build packages

Run the browser-specific script from the repository root:

```powershell
.\chrome\build.ps1
.\firefox\build.ps1
```

The uploadable ZIP files are created in `chrome/dist/` and `firefox/dist/`. Each ZIP has `manifest.json` at its root. The Firefox package includes the required built-in data-collection declaration.

## Load unpacked

### Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Extract the Chrome ZIP from `chrome/dist/`.
4. Choose **Load unpacked** and select the extracted package folder.

### Firefox

1. Open `about:debugging`.
2. Select **This Firefox**.
3. Select **Load Temporary Add-on**.
4. Extract the Firefox ZIP from `firefox/dist/` and select its `manifest.json`.

Then open or reload an Azure DevOps pull request.

The key stats appear beside the PR navigation tabs and in the lower-right floater. Select either location for the full summary. Open **ADO Lens settings** from the browser toolbar icon to show or hide the floater; the setting syncs through the browser and does not hide the tab-row stats.

## Tests

```powershell
node .\shared\tests\lib.test.js
```
## Contributing

Pull requests and issue reports are welcome. They are reviewed by maintainers, but a response, merge, or fix is not guaranteed.

## AI disclosure

AI was used to write portions of the code in this project. All code is tested by the maintainers.