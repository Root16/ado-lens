# ADO Lens store assets

This folder contains graphics and notes shared by the Chrome Web Store and
Firefox Add-ons listings. It is not included in either extension package.

## Planned graphics

| Asset | File | Notes |
| --- | --- | --- |
| Store icon source | `source/ado-lens-logo.png` | Supplied ADO Lens artwork; create browser-specific icon sizes from this source when ready |
| README screenshot | `../img/ado-lens-stats-dashboard.png` | Add a real screenshot of the Stats tab and dashboard, with any private organization, repository, user, or PR details redacted |
| Chrome/Firefox screenshot | `screenshot-1280x800.png` | Optional store screenshot; use the same product view for both listings |
| Small promo tile | `promo-small-440x280.png` | Optional Chrome Web Store promotional graphic |
| Marquee | `promo-marquee-1400x560.png` | Optional Chrome Web Store marquee graphic |

The extension build scripts copy only files named by each browser manifest, so
store artwork remains available to both listings without being shipped inside
the extension ZIPs.

## Listing notes

- **Name:** ADO Lens
- **Category:** Developer Tools
- **Language:** English
- **Short description:** Adds a Stats tab to Azure DevOps pull requests with line changes, file and commit counts, review information, charts, and related PR metrics.
- **Privacy summary:** ADO Lens runs in the browser, uses the signed-in Azure DevOps session, stores no PR data, and sends no data to third-party services.

Before publishing, add a real screenshot to `img/ado-lens-stats-dashboard.png`
and create the required store icon sizes from the source artwork.
