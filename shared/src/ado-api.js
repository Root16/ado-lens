(function (root) {
  "use strict";

  const MAX_FILE_BYTES = 1_000_000;
  const MAX_FILE_LINES = 20_000;
  const CONCURRENCY = 4;

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

  async function postJson(context, path, body) {
    const response = await fetch(apiUrl(context, path), {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body)
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
    if (root.AdoLensLib.splitLines(item.content).length > MAX_FILE_LINES) return null;
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

  async function calculateLocFromContents(context, repositoryId, changes, baseCommit, sourceCommit, getExtension, onProgress) {
    let processed = 0;
    const results = await mapPool(changes, async (change) => {
      const item = change.item || {};
      const type = String(change.changeType || "edit").toLowerCase();
      const isAdd = type.includes("add") && !type.includes("rename");
      const isDelete = type.includes("delete");
      const oldPath = change.originalPath || item.originalPath || item.path;
      const newPath = item.path;
      const extension = getExtension(newPath || oldPath);
      try {
        const [before, after] = await Promise.all([
          isAdd ? "" : getFileContent(context, repositoryId, oldPath, baseCommit),
          isDelete ? "" : getFileContent(context, repositoryId, newPath, sourceCommit)
        ]);
        if (before === null || after === null) return { skipped: true, extension };
        return { ...root.AdoLensLib.countLineChanges(before, after), extension };
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
        total.byExtension.set(result.extension, (total.byExtension.get(result.extension) || 0) + result.additions + result.deletions);
      }
      return total;
    }, { additions: 0, deletions: 0, skipped: 0, byExtension: new Map() });
  }

  async function calculateLoc(context, repositoryId, changes, baseCommit, sourceCommit, getExtension, onProgress) {
    try {
      const response = await postJson(context, `git/repositories/${encodeURIComponent(repositoryId)}/diffs/files`, {
        baseVersionCommit: baseCommit,
        targetVersionCommit: sourceCommit,
        fileDiffParams: changes.map((change) => ({
          path: change.item?.path,
          originalPath: change.originalPath || change.item?.originalPath || change.item?.path
        }))
      });
      const fileDiffs = Array.isArray(response?.fileDiffs)
        ? response.fileDiffs
        : Array.isArray(response) ? response : [];
      if (!fileDiffs.length && changes.length) throw new Error("Azure DevOps returned no file diffs");

      const byPath = new Map(fileDiffs.map((fileDiff) => [fileDiff.path, fileDiff]));
      return changes.reduce((total, change, index) => {
        const path = change.item?.path || change.originalPath || "";
        const fileDiff = byPath.get(path) || fileDiffs[index];
        if (!fileDiff) {
          total.skipped += 1;
          onProgress?.(index + 1, changes.length);
          return total;
        }
        const additions = (fileDiff.lineDiffBlocks || []).reduce((sum, block) => sum + (Number(block.modifiedLinesCount) || 0), 0);
        const deletions = (fileDiff.lineDiffBlocks || []).reduce((sum, block) => sum + (Number(block.originalLinesCount) || 0), 0);
        total.additions += additions;
        total.deletions += deletions;
        const extension = getExtension(path);
        total.byExtension.set(extension, (total.byExtension.get(extension) || 0) + additions + deletions);
        onProgress?.(index + 1, changes.length);
        return total;
      }, { additions: 0, deletions: 0, skipped: 0, byExtension: new Map() });
    } catch {
      return calculateLocFromContents(context, repositoryId, changes, baseCommit, sourceCommit, getExtension, onProgress);
    }
  }

  root.AdoLensApi = { getJson, optionalJson, calculateLoc };
})(globalThis);
