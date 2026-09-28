# ADO Lens marketplace listing

## Name

```text
ADO Lens
```

## Short description / summary

```text
A compact pull-request summary for Azure DevOps.
```

## Full description

```text
ADO Lens adds a Stats tab to Azure DevOps pull requests, giving you a quick view of the changes and review activity in one place.

The dashboard shows:
- Lines added and removed
- Changed files and commits
- Reviewer approvals, comments, linked work items, and PR age
- Charts showing files and changed lines by file type

Open a pull request in Azure DevOps and select Stats to see its dashboard. You can show or hide the tab from ADO Lens settings in the browser toolbar.

ADO Lens uses your existing Azure DevOps session to read the current pull request. It calculates metrics in your browser and does not send PR data to a developer-operated server or analytics service. Only the show/hide setting is saved in browser sync storage. If Azure DevOps cannot supply a complete diff, some line counts may be marked partial.
```

## Privacy / data use wording

```text
ADO Lens reads the current Azure DevOps pull request through Azure DevOps requests using the user's existing signed-in session. It processes pull request details and diff data in the browser to display statistics. It does not persist pull request data or send it to a developer-operated server or analytics service. Browser sync storage holds only the user's show/hide setting for the Stats tab.
```

## Listing choices

| Field | Chrome Web Store | Firefox Add-ons |
| --- | --- | --- |
| Language | English | English (en-US) |
| Category | Developer Tools | Web Development |
| Icon | `icons/icon-128.png` | Manifest icons in the extension ZIP |
| Screenshot | `screenshot-1280x800.png` | `screenshot-1280x800.png` |
| License | MIT | MIT |

## Assets

| Asset | File |
| --- | --- |
| Original logo | `source/ado-lens-logo.png` |
| Exported browser icons | `icons/icon-{16,32,48,96,128}.png` |
| Store screenshot | `screenshot-1280x800.png` |
| Full dashboard screenshot | `../img/ado-lens-stats-dashboard.png` |
