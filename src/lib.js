(function (root, factory) {
  const api = factory();
  root.AdoLensLib = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function parsePrUrl(input) {
    let url;
    try {
      url = new URL(input);
    } catch {
      return null;
    }

    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const gitIndex = parts.findIndex((part) => part.toLowerCase() === "_git");
    const prIndex = parts.findIndex((part) => part.toLowerCase() === "pullrequest");
    if (gitIndex < 0 || prIndex !== gitIndex + 2 || !/^\d+$/.test(parts[prIndex + 1] || "")) {
      return null;
    }

    const host = url.hostname.toLowerCase();
    let organization;
    let project;
    if (host === "dev.azure.com") {
      if (gitIndex < 2) return null;
      organization = parts[0];
      project = parts[1];
    } else if (host.endsWith(".visualstudio.com")) {
      if (gitIndex < 1) return null;
      organization = host.slice(0, -".visualstudio.com".length);
      project = parts[0];
    } else {
      return null;
    }

    const apiRoot = host === "dev.azure.com"
      ? `${url.origin}/${encodeURIComponent(organization)}/${encodeURIComponent(project)}`
      : `${url.origin}/${encodeURIComponent(project)}`;

    return {
      origin: url.origin,
      organization,
      project,
      repository: parts[gitIndex + 1],
      pullRequestId: Number(parts[prIndex + 1]),
      apiRoot
    };
  }

  function splitLines(text) {
    if (!text) return [];
    const normalized = text.replace(/\r\n?/g, "\n");
    const withoutFinalNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
    return withoutFinalNewline === "" ? [] : withoutFinalNewline.split("\n");
  }

  function countLineChanges(beforeText, afterText) {
    let before = splitLines(beforeText);
    let after = splitLines(afterText);

    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
    let beforeEnd = before.length;
    let afterEnd = after.length;
    while (beforeEnd > prefix && afterEnd > prefix && before[beforeEnd - 1] === after[afterEnd - 1]) {
      beforeEnd -= 1;
      afterEnd -= 1;
    }
    before = before.slice(prefix, beforeEnd);
    after = after.slice(prefix, afterEnd);

    const n = before.length;
    const m = after.length;
    if (n === 0) return { additions: m, deletions: 0 };
    if (m === 0) return { additions: 0, deletions: n };

    const beforeValues = new Set(before);
    if (!after.some((line) => beforeValues.has(line))) {
      return { additions: m, deletions: n };
    }

    const max = n + m;
    const offset = max + 1;
    const frontier = new Int32Array(max * 2 + 3);
    frontier.fill(-1);
    frontier[offset + 1] = 0;

    for (let distance = 0; distance <= max; distance += 1) {
      for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
        const index = offset + diagonal;
        let x;
        if (diagonal === -distance || (diagonal !== distance && frontier[index - 1] < frontier[index + 1])) {
          x = frontier[index + 1];
        } else {
          x = frontier[index - 1] + 1;
        }
        let y = x - diagonal;
        while (x < n && y < m && before[x] === after[y]) {
          x += 1;
          y += 1;
        }
        frontier[index] = x;
        if (x >= n && y >= m) {
          return {
            additions: (distance + m - n) / 2,
            deletions: (distance + n - m) / 2
          };
        }
      }
    }

    return { additions: m, deletions: n };
  }

  function summarizeReviewers(reviewers) {
    const votes = (reviewers || []).filter((reviewer) => !reviewer.isContainer).map((reviewer) => reviewer.vote || 0);
    return {
      total: votes.length,
      approved: votes.filter((vote) => vote >= 5).length,
      waiting: votes.filter((vote) => vote === 0).length,
      rejected: votes.filter((vote) => vote < 0).length
    };
  }

  function summarizeStatuses(statuses) {
    const states = (statuses || []).map((status) => String(status.state || "").toLowerCase());
    return {
      total: states.length,
      succeeded: states.filter((state) => state === "succeeded").length,
      pending: states.filter((state) => ["pending", "notset", "notapplicable"].includes(state)).length,
      failed: states.filter((state) => ["failed", "error"].includes(state)).length
    };
  }

  return { parsePrUrl, splitLines, countLineChanges, summarizeReviewers, summarizeStatuses };
});
