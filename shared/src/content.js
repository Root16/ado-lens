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
      try {
        const [before, after] = await Promise.all([
          isAdd ? "" : getFileContent(context, repositoryId, oldPath, baseCommit),
          isDelete ? "" : getFileContent(context, repositoryId, newPath, sourceCommit)
        ]);
        if (before === null || after === null) return { skipped: true };
        return lib.countLineChanges(before, after);
      } catch {
        return { skipped: true };
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
      }
      return total;
    }, { additions: 0, deletions: 0, skipped: 0 });
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
      statuses
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
        .wrap { font: 12px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#242424; }
        .chip { display:none; }
        .mark { display:grid; place-items:center; width:20px; height:20px; border-radius:6px; background:#0078d4; color:#fff; font-size:10px; font-weight:800; }
        .plus { color:#1a7f37; } .minus { color:#cf222e; }
        .panel { display:none; width:100%; border:1px solid #d6d6d6; border-radius:4px; background:#fff; box-shadow:0 2px 8px #0002; overflow:hidden; }
        .panel.open { display:block; }
        .toolbar { display:flex; justify-content:flex-end; padding:8px 10px 0; }
        .message { padding:16px; }
        .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:7px; padding:10px; }
        .stat { min-height:68px; padding:11px; border:1px solid #e1e1e1; border-radius:7px; background:#f5f5f5; }
        .value { font-size:17px; font-weight:700; font-variant-numeric:tabular-nums; }
        .label { margin-top:2px; color:#57606a; font-size:10px; text-transform:uppercase; letter-spacing:.04em; }
        .refresh { border:0; border-radius:4px; padding:4px 7px; background:transparent; color:#0969da; cursor:pointer; font:inherit; }
        .refresh:hover { background:#ddf4ff; }
        .error { max-width:280px; white-space:normal; }
        @media (prefers-color-scheme: dark) {
          .wrap { color:#f1f1f1; }
          .panel { background:#2d2d2d; color:#f1f1f1; border-color:#454545; box-shadow:0 2px 8px #0008; }
          .stat { background:#252525; border-color:#414141; }
          .label { color:#b8b8b8; }
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
    if (!floatingStatsVisible) return;
    const pageContent = findPrPageContent();
    const host = document.getElementById(HOST_ID);
    if (!pageContent || !host) return;

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
  }

  function hideDashboard() {
    dashboardOpen = false;
    const host = document.getElementById(HOST_ID);
    host?.shadowRoot?.querySelector(".panel")?.classList.remove("open");
    if (host) host.style.display = "none";
    for (const [child, display] of hiddenPageChildren) child.style.display = display;
    hiddenPageChildren.clear();
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
        const isOpen = !dashboardOpen;
        if (isOpen) showDashboard();
        else hideDashboard();
        host.setAttribute("aria-selected", String(isOpen));
        host.classList.toggle("selected", isOpen);
      });
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

  function renderStats(stats) {
    const shadow = ensureView();
    const partial = stats.skippedFiles || stats.fileLimitReached;
    shadow.querySelector(".chip-text").innerHTML = `<span class="plus">+${stats.additions}</span> <span class="minus">−${stats.deletions}</span> · ${stats.commits}${stats.commitLimitReached ? "+" : ""} commits · ${stats.files}${stats.fileLimitReached ? "+" : ""} files${partial ? " *" : ""}`;
    const checksText = stats.statuses.total
      ? `${stats.statuses.succeeded}✓ ${stats.statuses.pending}… ${stats.statuses.failed}✕`
      : "—";
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
        ${metric(checksText, "Checks")}
        ${metric(stats.comments, "Comments")}
        ${metric(stats.workItems, "Work items")}
        ${metric(`${ageDays}d`, "Age")}
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
