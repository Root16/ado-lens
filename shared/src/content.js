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
      host.style.display = floatingStatsVisible ? "block" : "none";
      return host.shadowRoot;
    }
    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483647";
    host.style.display = floatingStatsVisible ? "block" : "none";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { color-scheme: light dark; }
        * { box-sizing: border-box; }
        .wrap { font: 12px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#202124; }
        .chip { display:flex; align-items:center; gap:8px; min-height:34px; border:1px solid #d0d7de; border-radius:18px; padding:7px 11px; background:#fff; color:#24292f; box-shadow:0 3px 14px #0002; cursor:pointer; font-weight:600; }
        .chip:hover { background:#f6f8fa; }
        .mark { display:grid; place-items:center; width:20px; height:20px; border-radius:6px; background:#0078d4; color:#fff; font-size:10px; font-weight:800; }
        .plus { color:#1a7f37; } .minus { color:#cf222e; }
        .panel { display:none; position:absolute; right:0; bottom:43px; width:330px; border:1px solid #d0d7de; border-radius:10px; background:#fff; box-shadow:0 8px 28px #0003; overflow:hidden; }
        .panel.open { display:block; }
        .head { padding:13px 14px 11px; border-bottom:1px solid #d8dee4; background:#f6f8fa; }
        .eyebrow { display:flex; justify-content:space-between; color:#57606a; font-size:11px; }
        .title { margin-top:4px; font-size:14px; font-weight:650; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .branch { margin-top:4px; color:#57606a; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .grid { display:grid; grid-template-columns:repeat(3,1fr); padding:8px; }
        .stat { min-height:58px; margin:2px; padding:8px; border-radius:7px; background:#f6f8fa; }
        .value { font-size:17px; font-weight:700; font-variant-numeric:tabular-nums; }
        .label { margin-top:2px; color:#57606a; font-size:10px; text-transform:uppercase; letter-spacing:.04em; }
        .foot { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:9px 12px; border-top:1px solid #d8dee4; color:#57606a; font-size:10px; }
        .refresh { border:0; border-radius:5px; padding:4px 7px; background:transparent; color:#0969da; cursor:pointer; font:inherit; }
        .refresh:hover { background:#ddf4ff; }
        .error { max-width:280px; white-space:normal; }
        @media (prefers-color-scheme: dark) {
          .wrap { color:#e6edf3; } .chip,.panel { background:#161b22; color:#e6edf3; border-color:#30363d; }
          .chip:hover,.head,.stat { background:#21262d; } .head,.foot { border-color:#30363d; }
          .eyebrow,.branch,.label,.foot { color:#8b949e; }
        }
      </style>
      <div class="wrap">
        <section class="panel" aria-label="Azure DevOps pull request stats"></section>
        <button class="chip" type="button" aria-expanded="false"><span class="mark">PR</span><span class="chip-text">Loading PR stats…</span></button>
      </div>`;
    document.documentElement.appendChild(host);
    shadow.querySelector(".chip").addEventListener("click", () => {
      const panel = shadow.querySelector(".panel");
      panel.classList.toggle("open");
      shadow.querySelector(".chip").setAttribute("aria-expanded", String(panel.classList.contains("open")));
    });
    view = shadow;
    return shadow;
  }

  function findPrTabBar() {
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
    return best.closest(".bolt-tabbar") || best.parentElement;
  }

  function ensureTabChips() {
    const tabBar = findPrTabBar();
    if (!tabBar) return null;

    let host = document.getElementById(TAB_HOST_ID);
    if (!host) {
      host = document.createElement("span");
      host.id = TAB_HOST_ID;
      host.style.cssText = "display:inline-flex;align-items:center;margin-left:auto;padding:0 12px;white-space:nowrap;align-self:stretch";
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `
        <style>
          * { box-sizing:border-box; }
          .row { display:inline-flex; align-items:center; gap:6px; margin:auto 0; color:inherit; font:11px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
          button { display:inline-flex; align-items:center; gap:5px; padding:0; border:0; background:transparent; color:inherit; cursor:pointer; font:inherit; }
          .chip { display:inline-flex; align-items:center; min-height:22px; padding:2px 7px; border:1px solid rgba(128,128,128,.28); border-radius:11px; background:rgba(128,128,128,.10); font-weight:600; font-variant-numeric:tabular-nums; }
          .plus { color:#1a7f37; background:rgba(46,160,67,.10); border-color:rgba(46,160,67,.25); }
          .minus { color:#cf222e; background:rgba(248,81,73,.10); border-color:rgba(248,81,73,.25); }
          button:hover .chip { border-color:rgba(9,105,218,.55); }
          @media (prefers-color-scheme: dark) { .plus { color:#3fb950; } .minus { color:#f85149; } }
        </style>
        <span class="row"><button class="stats" type="button" title="Open floating PR stats"></button></span>`;
      shadow.querySelector(".stats").addEventListener("click", () => {
        if (!floatingStatsVisible) return;
        const floater = ensureView();
        const panel = floater.querySelector(".panel");
        panel.classList.add("open");
        floater.querySelector(".chip").setAttribute("aria-expanded", "true");
      });
    }

    if (host.parentElement !== tabBar) tabBar.appendChild(host);
    if (latestTabContent !== null) host.shadowRoot.querySelector(".stats").innerHTML = latestTabContent;
    host.shadowRoot.querySelector(".stats").title = floatingStatsVisible
      ? "Open floating PR stats"
      : "Floating PR stats are disabled in extension settings";
    return host;
  }

  function setFloatingStatsVisible(visible, persist = false) {
    floatingStatsVisible = Boolean(visible);
    const host = document.getElementById(HOST_ID);
    if (host) host.style.display = floatingStatsVisible ? "block" : "none";
    const tabHost = document.getElementById(TAB_HOST_ID);
    const statsButton = tabHost?.shadowRoot?.querySelector(".stats");
    if (statsButton) {
      statsButton.title = floatingStatsVisible
        ? "Open floating PR stats"
        : "Floating PR stats are disabled in extension settings";
    }
    if (persist) chrome.storage.sync.set({ showFloatingStats: floatingStatsVisible });
  }

  function renderTabContent(content) {
    latestTabContent = content;
    ensureTabChips();
  }

  function renderLoading(message) {
    const shadow = ensureView();
    shadow.querySelector(".chip-text").textContent = message;
    renderTabContent(`<span class="chip">${escapeHtml(message)}</span>`);
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
      <div class="head">
        <div class="eyebrow"><span>PR #${escapeHtml(stats.id)} · ${escapeHtml(stats.status)}</span><span>${escapeHtml(stats.author)}</span></div>
        <div class="title" title="${escapeHtml(stats.title)}">${escapeHtml(stats.title)}</div>
        <div class="branch" title="${escapeHtml(`${stats.sourceBranch} → ${stats.targetBranch}`)}">${escapeHtml(stats.sourceBranch)} → ${escapeHtml(stats.targetBranch)}</div>
      </div>
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
      </div>
      <div class="foot"><span>${partial ? `* LOC excludes ${stats.skippedFiles} large/binary file(s).` : "LOC calculated locally; no data stored."}</span><button class="refresh" type="button">Refresh</button></div>`;
    shadow.querySelector(".refresh").addEventListener("click", (event) => {
      event.stopPropagation();
      refresh(true);
    });
    renderTabContent(`
      <span class="chip plus">+${escapeHtml(stats.additions)}${partial ? "*" : ""}</span>
      <span class="chip minus">−${escapeHtml(stats.deletions)}${partial ? "*" : ""}</span>
      <span class="chip">${escapeHtml(stats.files)}${stats.fileLimitReached ? "+" : ""} files</span>
      <span class="chip">${escapeHtml(stats.commits)}${stats.commitLimitReached ? "+" : ""} commits</span>`);
  }

  function renderError(error) {
    const shadow = ensureView();
    shadow.querySelector(".chip-text").innerHTML = `<span class="error">Stats unavailable</span>`;
    shadow.querySelector(".panel").innerHTML = `<div class="head"><div class="title">Couldn’t load PR stats</div><div class="branch">${escapeHtml(error?.message || "Unknown Azure DevOps error")}. Reload the page or check your project access.</div></div><div class="foot"><span>Uses your current Azure DevOps session.</span><button class="refresh" type="button">Retry</button></div>`;
    shadow.querySelector(".refresh").addEventListener("click", (event) => {
      event.stopPropagation();
      refresh(true);
    });
    renderTabContent('<span class="chip">Stats unavailable</span>');
  }

  async function refresh(force = false) {
    const context = lib.parsePrUrl(location.href);
    if (!context) {
      document.getElementById(HOST_ID)?.remove();
      document.getElementById(TAB_HOST_ID)?.remove();
      view = null;
      latestTabContent = null;
      activeUrl = location.href;
      requestGeneration += 1;
      return;
    }
    if (!force && activeUrl === location.href && document.getElementById(HOST_ID)) {
      ensureTabChips();
      return;
    }
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
