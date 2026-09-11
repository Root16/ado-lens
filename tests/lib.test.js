"use strict";

const assert = require("node:assert/strict");
const { parsePrUrl, splitLines, countLineChanges, summarizeReviewers, summarizeStatuses } = require("../src/lib.js");

assert.deepEqual(parsePrUrl("https://dev.azure.com/acme/My%20Project/_git/web/pullrequest/42"), {
  origin: "https://dev.azure.com",
  organization: "acme",
  project: "My Project",
  repository: "web",
  pullRequestId: 42,
  apiRoot: "https://dev.azure.com/acme/My%20Project"
});

assert.deepEqual(parsePrUrl("https://acme.visualstudio.com/Project/_git/repo/pullrequest/7?_a=files"), {
  origin: "https://acme.visualstudio.com",
  organization: "acme",
  project: "Project",
  repository: "repo",
  pullRequestId: 7,
  apiRoot: "https://acme.visualstudio.com/Project"
});

assert.equal(parsePrUrl("https://dev.azure.com/acme/Project/_git/repo"), null);
assert.deepEqual(splitLines("a\r\nb\r\n"), ["a", "b"]);
assert.deepEqual(countLineChanges("a\nb\nc\n", "a\nx\nc\nd\n"), { additions: 2, deletions: 1 });
assert.deepEqual(countLineChanges("", "a\nb\n"), { additions: 2, deletions: 0 });
assert.deepEqual(countLineChanges("a\nb\n", ""), { additions: 0, deletions: 2 });
assert.deepEqual(countLineChanges("a\nb\nc", "c\na\nb"), { additions: 1, deletions: 1 });
assert.deepEqual(summarizeReviewers([{ vote: 10 }, { vote: 5 }, { vote: 0 }, { vote: -10 }, { vote: 10, isContainer: true }]), {
  total: 4, approved: 2, waiting: 1, rejected: 1
});
assert.deepEqual(summarizeStatuses([{ state: "succeeded" }, { state: "pending" }, { state: "failed" }]), {
  total: 3, succeeded: 1, pending: 1, failed: 1
});

console.log("All tests passed.");
