// @module util/groupPath — pure helpers for slash-delimited group path logic.
// Group names use '/' as path separator: 'Work', 'Work/Backend', 'Work/Backend/API'.
// MAX_DEPTH = 3 (root can hold depth-1 groups; sub-groups go to depth 2 and 3).
// depth 4+ is rejected at command entry points.

const MAX_DEPTH = 3;

/** Number of path segments: '' → 0, 'a' → 1, 'a/b' → 2 */
function pathDepth(groupName) {
  if (!groupName) return 0;
  return groupName.split('/').length;
}

/** Parent path: 'a/b/c' → 'a/b', 'a' → null */
function getParentPath(groupName) {
  if (!groupName) return null;
  const idx = groupName.lastIndexOf('/');
  if (idx < 0) return null;
  return groupName.substring(0, idx);
}

/** Leaf segment: 'a/b/c' → 'c', 'a' → 'a' */
function getLeafName(groupName) {
  if (!groupName) return groupName;
  const idx = groupName.lastIndexOf('/');
  if (idx < 0) return groupName;
  return groupName.substring(idx + 1);
}

/**
 * All descendants of parentPath in groups object (strict sub-paths, any depth).
 * getDescendants({'a':[],'a/b':[],'a/b/c':[],'x':[]}, 'a') → ['a/b','a/b/c']
 */
function getDescendants(groups, parentPath) {
  const prefix = parentPath + '/';
  return Object.keys(groups).filter(k => k.startsWith(prefix));
}

/**
 * Whether adding a sub-group under parentPath is allowed.
 * parentPath at depth 1 → child at depth 2 → OK.
 * parentPath at depth 2 → child at depth 3 → OK.
 * parentPath at depth 3 → child would be depth 4 → NOT allowed.
 */
function isAddAllowed(parentPath) {
  return pathDepth(parentPath) < MAX_DEPTH;
}

module.exports = { MAX_DEPTH, pathDepth, getParentPath, getLeafName, getDescendants, isAddAllowed };
