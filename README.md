# ADO Lens

A tiny Chrome extension that adds compact stats chips to the Azure DevOps PR tab row and a detailed bottom-right stats floater.

It shows:

- lines added and removed
- files and commits
- reviewer approvals
- check/status results
- comments, linked work items, and PR age

The extension has no background worker, third-party service, or analytics. It makes same-origin Azure DevOps REST requests with the session already active in the page. File contents are used in memory to calculate line changes and are never persisted. Large and binary files are skipped and marked as partial in the UI. Chrome sync storage is used only for extension settings.

## Load unpacked

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this folder.
4. Open or reload an Azure DevOps pull request.

The key stats appear beside the PR navigation tabs and in the lower-right floater. Select either location for the full summary. Open **ADO Lens settings** from the Chrome toolbar icon to show or hide the floater; the setting syncs through Chrome and does not hide the tab-row stats.
