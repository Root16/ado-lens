# ADO Lens store assets

This folder contains graphics and notes shared by the Chrome Web Store and
Firefox Add-ons listings. The build scripts include only `icons/` in the
extension packages; the full-size source artwork stays here.

## Graphics

| Asset | File | Notes |
| --- | --- | --- |
| Icon source | `source/ado-lens-logo.png` | Supplied ADO Lens artwork |
| Browser and store icons | `icons/icon-{16,32,48,96,128}.png` | Square transparent PNGs used by the Chrome and Firefox manifests; `icon-128.png` is the Chrome Web Store icon |
| README screenshot | `../img/ado-lens-stats-dashboard.png` | Add a real screenshot of the Stats tab and dashboard, with any private organization, repository, user, or PR details redacted |
| Chrome/Firefox screenshot | `screenshot-1280x800.png` or `screenshot-640x400.png` | At least one screenshot is required for Chrome; 1280 × 800 is preferred. Firefox recommends 1280 × 800 but accepts other sizes. |
| Small promo tile | `promo-small-440x280.png` | Optional Chrome Web Store promotional graphic |
| Marquee | `promo-marquee-1400x560.png` | Optional Chrome Web Store marquee graphic |

To regenerate the icons after changing the source artwork, install Pillow and
run `python store-assets/generate-icons.py` from the repository root. The
128 px image gives the mark 16 px of transparent space on each side for the
Chrome Web Store. Build scripts include the exported icons in both ZIPs.

## Listing notes

- **Name:** ADO Lens
- **Category:** Developer Tools
- **Language:** English
- **Short description:** Adds a Stats tab to Azure DevOps pull requests with line changes, file and commit counts, review information, charts, and related PR metrics.
- **Privacy summary:** ADO Lens runs in the browser, uses the signed-in Azure DevOps session, stores no PR data, and sends no data to third-party services.

Before publishing, add a real screenshot to `img/ado-lens-stats-dashboard.png`.
