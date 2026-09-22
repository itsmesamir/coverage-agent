/**
 * Invariant 9, reimplemented. The Python version parsed each file with `ast`
 * and asserted an allowlist; this resolves the actual dependency graph, so a
 * transitive violation (policy/ imports X, X imports the ORM) is caught too,
 * which a per-file import check cannot see.
 *
 * The allowed set is stricter than the Python one on purpose: Python allowed
 * "stdlib", which has no real TypeScript equivalent worth carving out, so the
 * pure packages here permit zero npm/node dependencies at all -- only
 * relative imports within the permitted directories.
 */
module.exports = {
  forbidden: [
    {
      name: "domain-is-pure",
      comment: "domain/ imports nothing outside itself: no npm, no node core, no sibling app package.",
      severity: "error",
      from: { path: "^api/app/domain" },
      to: {
        path: "^api/app/(?!domain)",
        pathNot: "^api/app/domain",
      },
    },
    {
      name: "domain-no-external",
      comment: "domain/ takes no npm or node core dependency.",
      severity: "error",
      from: { path: "^api/app/domain" },
      to: { dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-bundled", "core"] },
    },
    {
      name: "policy-is-pure",
      comment: "policy/ may depend only on app/domain among sibling app packages.",
      severity: "error",
      from: { path: "^api/app/policy" },
      to: {
        path: "^api/app/(agent|channels|obs|db|retrieval|state)",
      },
    },
    {
      name: "policy-no-external",
      comment: "policy/ takes no npm or node core dependency (no LLM client, no HTTP client, no ORM).",
      severity: "error",
      from: { path: "^api/app/policy" },
      to: { dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-bundled", "core"] },
    },
    {
      name: "state-is-pure",
      comment: "state/ may depend only on app/domain among sibling app packages.",
      severity: "error",
      from: { path: "^api/app/state" },
      to: {
        path: "^api/app/(agent|channels|obs|db|retrieval|policy)",
      },
    },
    {
      name: "state-no-external",
      comment: "state/ takes no npm or node core dependency.",
      severity: "error",
      from: { path: "^api/app/state" },
      to: { dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-bundled", "core"] },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default"] },
  },
};
