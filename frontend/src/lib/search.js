/**
 * Collection search. Extracted from the sidebar so the matching rules are
 * testable on their own — the previous UI searched only the request name and URL
 * while its placeholder promised the method too.
 */

/** All whitespace-separated terms must appear somewhere in the fields (AND). */
export function matchesQuery(query, ...fields) {
  const terms = String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return true;
  const haystack = fields
    .filter((field) => field != null && field !== "")
    .map((field) => String(field).toLowerCase())
    .join(" ");
  return terms.every((term) => haystack.includes(term));
}

function filterNode(node, query) {
  if (node.type === "request") {
    const request = node.request || {};
    return matchesQuery(query, node.name, request.url, request.method) ? { ...node } : null;
  }
  const items = (node.items || []).map((child) => filterNode(child, query)).filter(Boolean);
  if (!items.length) return null;
  return { ...node, items };
}

/** Folders and collections survive only when they still contain a match. */
export function filterCollections(collections, query) {
  if (!String(query || "").trim()) return collections;
  return (collections || []).map((collection) => filterNode(collection, query)).filter(Boolean);
}

/** Count every request below a node, used for the tree count badges. */
export function countRequests(node) {
  if (node.type === "request") return 1;
  return (node.items || []).reduce((total, child) => total + countRequests(child), 0);
}
