(function (root) {
  "use strict";

  const api = root.AdoLensApi;

  function unwrapList(response) {
    if (Array.isArray(response)) return response;
    if (Array.isArray(response?.value)) return response.value;
    return [];
  }

  function getFileExtension(path) {
    const fileName = String(path || "").split(/[\\/]/).pop() || "";
    const dot = fileName.lastIndexOf(".");
    return dot > 0 && dot < fileName.length - 1
      ? `.${fileName.slice(dot + 1).toLowerCase()}`
      : "(none)";
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

  async function loadStats(context, isCurrent, onProgress) {
    const repositoryPath = encodeURIComponent(context.repository);
    const pr = await api.getJson(context, `git/repositories/${repositoryPath}/pullRequests/${context.pullRequestId}`);
    if (!isCurrent()) return null;

    const repositoryId = pr.repository?.id || context.repository;
    const prBase = `git/repositories/${encodeURIComponent(repositoryId)}/pullRequests/${context.pullRequestId}`;
    const sourceCommit = pr.lastMergeSourceCommit?.commitId;
    const targetCommit = pr.lastMergeTargetCommit?.commitId;

    const [commitsResponse, threadsResponse, workItemsResponse, statusesResponse, diff] = await Promise.all([
      api.optionalJson(context, `${prBase}/commits`, { "$top": 1000 }),
      api.optionalJson(context, `${prBase}/threads`),
      api.optionalJson(context, `${prBase}/workitems`),
      api.optionalJson(context, `${prBase}/statuses`),
      api.getJson(context, `git/repositories/${encodeURIComponent(repositoryId)}/diffs/commits`, {
        baseVersion: targetCommit,
        baseVersionType: "commit",
        targetVersion: sourceCommit,
        targetVersionType: "commit",
        diffCommonCommit: true,
        "$top": 2000
      })
    ]);
    if (!isCurrent()) return null;

    const allChanges = unwrapList(diff?.changes || diff);
    const fileChanges = allChanges.filter((change) => !change.item?.isFolder && !String(change.item?.gitObjectType || "").toLowerCase().includes("tree"));
    const commonCommit = typeof diff?.commonCommit === "string"
      ? diff.commonCommit
      : diff?.commonCommit?.commitId || targetCommit;
    const loc = await api.calculateLoc(context, repositoryId, fileChanges, commonCommit, sourceCommit, getFileExtension, onProgress);
    if (!isCurrent()) return null;

    const commits = unwrapList(commitsResponse);
    const threads = unwrapList(threadsResponse);
    const comments = threads.reduce((count, thread) => count + (thread.comments || []).filter((comment) => {
      const type = String(comment.commentType || "").toLowerCase();
      return !comment.isDeleted && type !== "system";
    }).length, 0);
    const statuses = root.AdoLensLib.summarizeStatuses(unwrapList(statusesResponse));
    const reviewers = root.AdoLensLib.summarizeReviewers(pr.reviewers);

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

  root.AdoLensStats = { getFileExtension, loadStats };
})(globalThis);
