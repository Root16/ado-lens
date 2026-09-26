(function () {
  "use strict";

  const lib = globalThis.AdoLensLib;
  const HOST_ID = "ado-lens-root";
  const TAB_HOST_ID = "ado-lens-tabs";
  const MAX_FILE_BYTES = 1_000_000;
  const MAX_FILE_LINES = 20_000;
  const CONCURRENCY = 4;

  let activeUrl = "";
  let requestGeneration = 0;
  let view = null;
  let latestTabContent = null;
  let floatingStatsVisible = true;
  let dashboardOpen = false;
  let nativeTabBeforeStats = null;
  const hiddenPageChildren = new Map();

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function apiUrl(context, path, params = {}) {
    const url = new URL(`${context.apiRoot}/_apis/${path}`);
    url.searchParams.set("api-version", "7.1");
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async function getJson(context, path, params) {
    const response = await fetch(apiUrl(context, path, params), {
      credentials: "include",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`Azure DevOps returned ${response.status}`);
    return response.json();
  }

  async function optionalJson(context, path, params) {
    try {
      return await getJson(context, path, params);
    } catch {
      return { value: [], count: 0 };
    }
  }

  function unwrapList(response) {
    if (Array.isArray(response)) return response;
    if (Array.isArray(response?.value)) return response.value;
    return [];
  }

  function summarizeFileExtensions(changes) {
    const counts = new Map();
    for (const change of changes) {
      const extension = getFileExtension(change.item?.path || change.originalPath);
      counts.set(extension, (counts.get(extension) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([extension, count]) => ({ extension, count }))
      .sort((a, b) => b.count - a.count || a.extension.localeCompare(b.extension));
  }

  function getFileExtension(path) {
    const fileName = String(path || "").split(/[\\/]/).pop() || "";
    const dot = fileName.lastIndexOf(".");
    return dot > 0 && dot < fileName.length - 1
      ? `.${fileName.slice(dot + 1).toLowerCase()}`
      : "(none)";
  }

  async function getFileContent(context, repositoryId, path, commitId) {
    if (!path || !commitId) return "";
    const item = await getJson(context, `git/repositories/${encodeURIComponent(repositoryId)}/items`, {
      path,
      includeContent: true,
      resolveLfs: true,
      "versionDescriptor.version": commitId,
      "versionDescriptor.versionType": "commit"
    });
    if (item?.isBinary || typeof item?.content !== "string") return null;
    if (item.content.length > MAX_FILE_BYTES) return null;
    if (lib.splitLines(item.content).length > MAX_FILE_LINES) return null;
    return item.content;
  }

  async function mapPool(items, worker) {
    const results = new Array(items.length);
    let next = 0;
    async function run() {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run));
    return results;
  }

  async function calculateLoc(context, repositoryId, changes, baseCommit, sourceCommit, onProgress) {
    let processed = 0;
    const results = await mapPool(changes, async (change) => {
      const item = change.item || {};
      const type = String(change.changeType || "edit").toLowerCase();
      const isAdd = type.includes("add") && !type.includes("rename");
      const isDelete = type.includes("delete");
      const oldPath = change.originalPath || item.originalPath || item.path;
      const newPath = item.path;
      const extension = getFileExtension(newPath || oldPath);
      try {
        const [before, after] = await Promise.all([
          isAdd ? "" : getFileContent(context, repositoryId, oldPath, baseCommit),
          isDelete ? "" : getFileContent(context, repositoryId, newPath, sourceCommit)
        ]);
        if (before === null || after === null) return { skipped: true, extension };
        return { ...lib.countLineChanges(before, after), extension };
      } catch {
        return { skipped: true, extension };
      } finally {
        processed += 1;
        onProgress?.(processed, changes.length);
      }
    });

    return results.reduce((total, result) => {
      if (result.skipped) total.skipped += 1;
      else {
        total.additions += result.additions;
        total.deletions += result.deletions;
        const current = total.byExtension.get(result.extension) || 0;
        total.byExtension.set(result.extension, current + result.additions + result.deletions);
      }
      return total;
    }, { additions: 0, deletions: 0, skipped: 0, byExtension: new Map() });
  }

  async function loadStats(context, generation) {
    const repositoryPath = encodeURIComponent(context.repository);
    const pr = await getJson(context, `git/repositories/${repositoryPath}/pullRequests/${context.pullRequestId}`);
    if (generation !== requestGeneration) return null;

    const repositoryId = pr.repository?.id || context.repository;
    const prBase = `git/repositories/${encodeURIComponent(repositoryId)}/pullRequests/${context.pullRequestId}`;
    const sourceCommit = pr.lastMergeSourceCommit?.commitId;
    const targetCommit = pr.lastMergeTargetCommit?.commitId;

    const [commitsResponse, threadsResponse, workItemsResponse, statusesResponse, diff] = await Promise.all([
      optionalJson(context, `${prBase}/commits`, { "$top": 1000 }),
      optionalJson(context, `${prBase}/threads`),
      optionalJson(context, `${prBase}/workitems`),
      optionalJson(context, `${prBase}/statuses`),
      getJson(context, `git/repositories/${encodeURIComponent(repositoryId)}/diffs/commits`, {
        baseVersion: targetCommit,
        baseVersionType: "commit",
        targetVersion: sourceCommit,
        targetVersionType: "commit",
        diffCommonCommit: true,
        "$top": 2000
      })
    ]);
    if (generation !== requestGeneration) return null;

    const allChanges = unwrapList(diff?.changes || diff);
    const fileChanges = allChanges.filter((change) => !change.item?.isFolder && !String(change.item?.gitObjectType || "").toLowerCase().includes("tree"));
    const commonCommit = typeof diff?.commonCommit === "string"
      ? diff.commonCommit
      : diff?.commonCommit?.commitId || targetCommit;

    const loc = await calculateLoc(context, repositoryId, fileChanges, commonCommit, sourceCommit, (done, total) => {
      if (generation === requestGeneration) renderLoading(`Calculating LOC ${done}/${total}…`);
    });
    if (generation !== requestGeneration) return null;

    const commits = unwrapList(commitsResponse);
    const threads = unwrapList(threadsResponse);
    const comments = threads.reduce((count, thread) => count + (thread.comments || []).filter((comment) => {
      const type = String(comment.commentType || "").toLowerCase();
      return !comment.isDeleted && type !== "system";
    }).length, 0);
    const statuses = lib.summarizeStatuses(unwrapList(statusesResponse));
    const reviewers = lib.summarizeReviewers(pr.reviewers);

    return {
      title: pr.title,
      id: pr.pullRequestId,
      author: pr.createdBy?.displayName || "Unknown",
      sourceBranch: String(pr.sourceRefName || "").replace(/^refs\/heads\//, ""),
      targetBranch: String(pr.targetRefName || "").replace(/^refs\/heads\//, ""),
      created: pr.creationDate,
      status: pr.status,
      mergeStatus: pr.mergeStatus,
      additions: loc.additions,
      deletions: loc.deletions,
      skippedFiles: loc.skipped,
      files: fileChanges.length,
      fileLimitReached: diff?.allChangesIncluded === false,
      commits: commits.length,
      commitLimitReached: commits.length >= 1000,
      comments,
      workItems: unwrapList(workItemsResponse).length,
      reviewers,
      statuses,
      fileExtensions: summarizeFileExtensions(fileChanges),
      lineExtensions: [...loc.byExtension.entries()]
        .map(([extension, count]) => ({ extension, count }))
        .sort((a, b) => b.count - a.count || a.extension.localeCompare(b.extension))
    };
  }

  function ensureView() {
    let host = document.getElementById(HOST_ID);
    if (host) {
      host.style.display = dashboardOpen && floatingStatsVisible ? "block" : "none";
      return host.shadowRoot;
    }
    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all:initial;display:none;width:100%;box-sizing:border-box";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { color-scheme: light dark; }
        * { box-sizing: border-box; }
        .wrap { font: 13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#242424; }
        .chip { display:none; }
        .mark { display:grid; place-items:center; width:20px; height:20px; border-radius:6px; background:#0078d4; color:#fff; font-size:10px; font-weight:800; }
        .plus { color:#1a7f37; } .minus { color:#cf222e; }
        .panel { display:none; width:100%; border:1px solid #d6d6d6; border-radius:4px; background:#fff; box-shadow:0 2px 8px #0002; overflow:hidden; }
        .panel.open { display:block; }
        .toolbar { display:flex; justify-content:flex-end; padding:10px 12px 0; }
        .message { padding:18px; font-size:14px; }
        .grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; max-width:980px; padding:16px; }
        .stat { min-height:112px; padding:17px; border:1px solid #e1e1e1; border-radius:10px; background:#f5f5f5; display:flex; flex-direction:column; justify-content:center; }
        .value { font-size:22px; font-weight:700; font-variant-numeric:tabular-nums; }
        .label { margin-top:6px; color:#424242; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.055em; }
        .charts { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; margin:0 16px 16px; }
        .pie-card { min-height:270px; padding:18px; border:1px solid #e1e1e1; border-radius:10px; background:#f5f5f5; display:flex; flex-direction:column; align-items:center; justify-content:center; }
        .chart-title { align-self:flex-start; margin-bottom:18px; color:#424242; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.055em; }
        .pie-layout { display:flex; align-items:center; justify-content:center; gap:32px; width:100%; }
        .pie { width:190px; height:190px; flex:0 0 190px; border-radius:50%; box-shadow:inset 0 0 0 1px #0002; }
        .legend { display:grid; gap:10px; min-width:200px; }
        .legend-item { display:flex; align-items:center; gap:9px; color:#424242; font-size:13px; }
        .legend-swatch { width:12px; height:12px; flex:0 0 12px; border-radius:3px; }
        .empty-chart { color:#424242; font-size:14px; }
        .refresh { border:0; border-radius:4px; padding:5px 8px; background:transparent; color:#0969da; cursor:pointer; font:inherit; }
        .refresh:hover { background:#ddf4ff; }
        .error { max-width:280px; white-space:normal; }
        @media (prefers-color-scheme: dark) {
          .wrap { color:#f1f1f1; }
          .panel { background:#2d2d2d; color:#f1f1f1; border-color:#454545; box-shadow:0 2px 8px #0008; }
          .stat { background:#252525; border-color:#414141; }
          .pie-card { background:#252525; border-color:#414141; }
          .label,.chart-title { color:#d2d2d2; }
          .legend-item,.empty-chart { color:#c8c8c8; }
        }
      </style>
      <div class="wrap">
        <section class="panel" aria-label="Azure DevOps pull request stats"></section>
        <button class="chip" type="button" aria-expanded="false"><span class="mark">PR</span><span class="chip-text">Loading PR stats…</span></button>
      </div>`;
    const pageContent = findPrPageContent();
    if (pageContent) pageContent.prepend(host);
    else document.documentElement.appendChild(host);
    view = shadow;
    return shadow;
  }

  function findPrTabList() {
    const candidates = [...document.querySelectorAll('[role="tablist"], .bolt-tabbar-tabs')];
    let best = null;
    let bestScore = 0;
    for (const candidate of candidates) {
      const text = String(candidate.textContent || "").toLowerCase();
      const score = ["overview", "files", "updates", "commits"].filter((label) => text.includes(label)).length;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (!best || bestScore < 2) return null;
    return best.matches('[role="tablist"]') ? best : best.closest('[role="tablist"]') || best;
  }

  function findPrPageContent() {
    const tabList = findPrTabList();
    const tabBar = tabList?.closest(".repos-pr-details-page-tabbar") || tabList?.parentElement;
    const pageContent = tabBar?.nextElementSibling;
    return pageContent?.classList.contains("page-content") ? pageContent : null;
  }

  function showDashboard() {
    if (!floatingStatsVisible) return false;
    const pageContent = findPrPageContent();
    const host = document.getElementById(HOST_ID);
    if (!pageContent || !host) return false;

    for (const child of [...pageContent.children]) {
      if (child !== host && !hiddenPageChildren.has(child)) {
        hiddenPageChildren.set(child, child.style.display);
        child.style.display = "none";
      }
    }
    if (host.parentElement !== pageContent) pageContent.prepend(host);
    dashboardOpen = true;
    host.style.display = "block";
    host.shadowRoot.querySelector(".panel").classList.add("open");
    return true;
  }

  function hideDashboard(restoreNativeTab = true) {
    dashboardOpen = false;
    const host = document.getElementById(HOST_ID);
    host?.shadowRoot?.querySelector(".panel")?.classList.remove("open");
    if (host) host.style.display = "none";
    for (const [child, display] of hiddenPageChildren) child.style.display = display;
    hiddenPageChildren.clear();

    if (restoreNativeTab && nativeTabBeforeStats?.isConnected) {
      nativeTabBeforeStats.classList.add("selected");
      nativeTabBeforeStats.setAttribute("aria-selected", "true");
      nativeTabBeforeStats.setAttribute("tabindex", "0");
    }
    nativeTabBeforeStats = null;

    const statsTab = document.getElementById(TAB_HOST_ID);
    if (statsTab) {
      statsTab.classList.remove("selected");
      statsTab.setAttribute("aria-selected", "false");
      statsTab.setAttribute("tabindex", "-1");
    }
  }

  function selectStatsTab(tabList, statsTab) {
    nativeTabBeforeStats = [...tabList.querySelectorAll('[role="tab"]')]
      .find((tab) => tab !== statsTab && tab.getAttribute("aria-selected") === "true") || null;
    if (nativeTabBeforeStats) {
      nativeTabBeforeStats.classList.remove("selected");
      nativeTabBeforeStats.setAttribute("aria-selected", "false");
      nativeTabBeforeStats.setAttribute("tabindex", "-1");
    }
    const opened = showDashboard();
    statsTab.setAttribute("aria-selected", String(opened));
    statsTab.setAttribute("tabindex", opened ? "0" : "-1");
    statsTab.classList.toggle("selected", opened);
  }

  function ensureStatsTab() {
    const tabList = findPrTabList();
    if (!tabList) return null;

    let host = document.getElementById(TAB_HOST_ID);
    if (!host) {
      const nativeTab = tabList.querySelector('[role="tab"]');
      host = nativeTab ? nativeTab.cloneNode(true) : document.createElement("div");
      host.id = TAB_HOST_ID;
      host.classList.remove("selected");
      const tabText = host.querySelector(".bolt-tab-text");
      if (tabText) {
        tabText.textContent = "Stats";
        tabText.setAttribute("data-content", "Stats");
      } else {
        host.textContent = "Stats";
      }
      host.setAttribute("role", "tab");
      host.setAttribute("aria-selected", "false");
      host.setAttribute("aria-posinset", String(tabList.querySelectorAll('[role="tab"]').length + 1));
      host.setAttribute("aria-setsize", String(tabList.querySelectorAll('[role="tab"]').length + 1));
      host.setAttribute("tabindex", "-1");
      host.removeAttribute("href");
      host.removeAttribute("aria-controls");
      host.title = "Open pull-request stats";
      host.addEventListener("click", (event) => {
        event.preventDefault();
        if (!floatingStatsVisible) return;
        if (!dashboardOpen) selectStatsTab(tabList, host);
        else hideDashboard();
      });

      tabList.addEventListener("click", (event) => {
        const clickedTab = event.target.closest?.('[role="tab"]');
        if (clickedTab && clickedTab !== host) hideDashboard(false);
      });

      const tabObserver = new MutationObserver(() => {
        const nativeTabSelected = [...tabList.querySelectorAll('[role="tab"]')]
          .some((tab) => tab !== host && tab.getAttribute("aria-selected") === "true");
        if (dashboardOpen && nativeTabSelected) hideDashboard(false);
      });
      tabObserver.observe(tabList, { attributes: true, subtree: true, attributeFilter: ["aria-selected", "class"] });
    }

    if (host.parentElement !== tabList) {
      const nativeTabs = [...tabList.querySelectorAll('[role="tab"]')].filter((tab) => tab !== host);
      const lastNativeTab = nativeTabs.at(-1);
      if (lastNativeTab) lastNativeTab.after(host);
      else tabList.appendChild(host);
    }
    host.title = floatingStatsVisible
      ? "Open pull-request stats"
      : "Pull-request stats are disabled in extension settings";
    return host;
  }

  function setFloatingStatsVisible(visible, persist = false) {
    floatingStatsVisible = Boolean(visible);
    const host = document.getElementById(HOST_ID);
    if (host) host.style.display = dashboardOpen && floatingStatsVisible ? "block" : "none";
    const tabHost = document.getElementById(TAB_HOST_ID);
    const statsButton = tabHost;
    if (statsButton) {
      statsButton.title = floatingStatsVisible
        ? "Open pull-request stats"
        : "Pull-request stats are disabled in extension settings";
    }
    if (persist) chrome.storage.sync.set({ showFloatingStats: floatingStatsVisible });
  }

  function renderTabContent(content) {
    latestTabContent = content;
    ensureStatsTab();
  }

  function renderLoading(message) {
    const shadow = ensureView();
    shadow.querySelector(".chip-text").textContent = message;
    shadow.querySelector(".panel").innerHTML = `<div class="message">${escapeHtml(message)}</div>`;
  }

  function metric(value, label, className = "") {
    return `<div class="stat"><div class="value ${className}">${escapeHtml(value)}</div><div class="label">${escapeHtml(label)}</div></div>`;
  }

  function renderExtensionChart(entries) {
    const total = entries.reduce((sum, entry) => sum + entry.count, 0);
    if (!total) return '<div class="empty-chart">No modified files</div>';

    const visibleEntries = entries.slice(0, 7);
    const otherCount = entries.slice(7).reduce((sum, entry) => sum + entry.count, 0);
    if (otherCount) visibleEntries.push({ extension: "Other", count: otherCount });

    const colors = ["#0078d4", "#00b7c3", "#498205", "#ffb900", "#d83b01", "#8764b8", "#e3008c", "#7a7574"];
    let offset = 0;
    const segments = visibleEntries.map((entry, index) => {
      const percentage = entry.count / total * 100;
      const end = offset + percentage;
      const segment = `${colors[index]} ${offset.toFixed(2)}% ${end.toFixed(2)}%`;
      offset = end;
      return segment;
    });
    const legend = visibleEntries.map((entry, index) => {
      const percentage = entry.count / total * 100;
      return `<div class="legend-item"><span class="legend-swatch" style="background:${colors[index]}"></span><span>${escapeHtml(entry.extension)} · ${percentage.toFixed(1)}%</span></div>`;
    }).join("");
    return `<div class="pie-layout"><div class="pie" role="img" aria-label="Modified file extensions" style="background:conic-gradient(${segments.join(",")})"></div><div class="legend">${legend}</div></div>`;
  }

  function renderStats(stats) {
    const shadow = ensureView();
    const partial = stats.skippedFiles || stats.fileLimitReached;
    shadow.querySelector(".chip-text").innerHTML = `<span class="plus">+${stats.additions}</span> <span class="minus">−${stats.deletions}</span> · ${stats.commits}${stats.commitLimitReached ? "+" : ""} commits · ${stats.files}${stats.fileLimitReached ? "+" : ""} files${partial ? " *" : ""}`;
    const reviewText = stats.reviewers.total
      ? `${stats.reviewers.approved}/${stats.reviewers.total}`
      : "—";
    const ageDays = stats.created ? Math.max(0, Math.floor((Date.now() - new Date(stats.created).getTime()) / 86_400_000)) : "—";
    shadow.querySelector(".panel").innerHTML = `
      <div class="toolbar"><button class="refresh" type="button">Refresh</button></div>
      <div class="grid">
        ${metric(`+${stats.additions}`, "Added" + (partial ? "*" : ""), "plus")}
        ${metric(`−${stats.deletions}`, "Removed" + (partial ? "*" : ""), "minus")}
        ${metric(stats.files + (stats.fileLimitReached ? "+" : ""), "Files")}
        ${metric(stats.commits + (stats.commitLimitReached ? "+" : ""), "Commits")}
        ${metric(reviewText, "Approvals")}
        ${metric(stats.comments, "Comments")}
        ${metric(stats.workItems, "Work items")}
        ${metric(`${ageDays}d`, "Age")}
      </div>
      <div class="charts">
        <section class="pie-card" aria-label="Files by type">
          <div class="chart-title">Files by type</div>
          ${renderExtensionChart(stats.fileExtensions)}
        </section>
        <section class="pie-card" aria-label="Lines by type">
          <div class="chart-title">Lines by type</div>
          ${renderExtensionChart(stats.lineExtensions)}
        </section>
      </div>`;
    shadow.querySelector(".refresh").addEventListener("click", (event) => {
      event.stopPropagation();
      refresh(true);
    });
  }

  function renderError(error) {
    const shadow = ensureView();
    shadow.querySelector(".chip-text").innerHTML = `<span class="error">Stats unavailable</span>`;
    shadow.querySelector(".panel").innerHTML = `<div class="toolbar"><button class="refresh" type="button">Retry</button></div><div class="message">Couldn’t load PR stats: ${escapeHtml(error?.message || "Unknown Azure DevOps error")}. Reload the page or check your project access.</div>`;
    shadow.querySelector(".refresh").addEventListener("click", (event) => {
      event.stopPropagation();
      refresh(true);
    });
    ensureStatsTab();
  }

  async function refresh(force = false) {
    const context = lib.parsePrUrl(location.href);
    if (!context) {
      hideDashboard();
      document.getElementById(HOST_ID)?.remove();
      document.getElementById(TAB_HOST_ID)?.remove();
      view = null;
      latestTabContent = null;
      activeUrl = location.href;
      requestGeneration += 1;
      return;
    }
    if (!force && activeUrl === location.href && document.getElementById(HOST_ID)) {
      ensureStatsTab();
      return;
    }
    if (activeUrl && activeUrl !== location.href) hideDashboard();
    activeUrl = location.href;
    const generation = ++requestGeneration;
    renderLoading("Loading PR stats…");
    try {
      const stats = await loadStats(context, generation);
      if (stats && generation === requestGeneration) renderStats(stats);
    } catch (error) {
      if (generation === requestGeneration) renderError(error);
    }
  }

  async function initialize() {
    try {
      const stored = await chrome.storage.sync.get({ showFloatingStats: true });
      setFloatingStatsVisible(stored.showFloatingStats);
    } catch {
      setFloatingStatsVisible(true);
    }
    refresh();
    setInterval(() => refresh(), 1000);
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "sync" && changes.showFloatingStats) {
      setFloatingStatsVisible(changes.showFloatingStats.newValue);
    }
  });

  initialize();
})();
