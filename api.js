// =============================================================================
// api.js — VNDB Kana API layer
//
// All network requests to VNDB live here. Nothing in this file touches the
// DOM; it only returns data or throws errors.
//
// Official docs: https://api.vndb.org/kana
// Rate limit: 200 requests per 5 minutes.
// =============================================================================


// ── Base URL ──────────────────────────────────────────────────────────────────
// If VNDB blocks direct browser requests in your environment (CORS), swap this
// for a proxy, e.g. "https://api.vndbproxy.org/kana"
const API_BASE = "https://api.vndb.org/kana";


// ── Core fetch wrapper ────────────────────────────────────────────────────────
/**
 * Send a POST query to a VNDB Kana endpoint and return the parsed JSON.
 *
 * @param {string} path   - e.g. "/vn", "/tag", "/staff"
 * @param {object} body   - the query object (filters, fields, sort, etc.)
 * @returns {Promise<object>} parsed response: { results, more, count? }
 * @throws {Error} with a human-readable message on HTTP errors
 */
async function vndbPost(path, body) {
  const response = await fetch(API_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    // Map the most common HTTP error codes to friendly messages
    const msg =
      response.status === 429 ? "Rate limit hit — wait a few seconds and try again." :
      response.status === 400 ? "The query was rejected (try fewer tags or lower theme depth)." :
                                "VNDB returned " + response.status + ".";
    throw new Error(msg);
  }

  return response.json();
}


// ── VN search (typeahead) ─────────────────────────────────────────────────────
/**
 * Search VNs by title string. Used to power the seed-title autocomplete.
 *
 * Fields fetched: id, title, released, image (for thumbnail), votecount.
 * Results are sorted by vote count so well-known VNs appear first.
 *
 * @param {string} query - partial or full title
 * @param {number} [limit=8] - max results to return
 */
async function searchVNsByTitle(query, limit = 8) {
  return vndbPost("/vn", {
    filters: ["search", "=", query],
    fields: "id, title, released, image.url, votecount",
    sort: "votecount",
    reverse: true,
    results: limit,
  });
}


// ── VN detail (seed) ──────────────────────────────────────────────────────────
/**
 * Fetch full detail for a single VN by its VNDB id (e.g. "v17").
 * Used after the user picks a seed title from the autocomplete.
 *
 * Fields fetched:
 *   - Basic info: id, title, alttitle, released, rating
 *   - Cover image + its flagging scores (sexual / violence) for blur logic
 *   - tags: id, name, rating (0–3), spoiler level (0–2), category
 *   - staff: id, name, role (scenario / art / music / etc.)
 *
 * @param {string} vnId - e.g. "v17"
 */
async function fetchVNDetail(vnId) {
  const { results } = await vndbPost("/vn", {
    filters: ["id", "=", vnId],
    fields: [
      "id", "title", "alttitle", "released", "rating",
      "image.url", "image.sexual", "image.violence",
      // tags — we need rating and spoiler level for filtering/weighting
      "tags.id", "tags.name", "tags.rating", "tags.spoiler", "tags.category",
      // staff — we need role so we can weight by importance
      "staff.id", "staff.name", "staff.role",
    ].join(", "),
  });

  // The API always returns an array; we only asked for one VN
  return results[0];
}


// ── Similar VN candidates ─────────────────────────────────────────────────────
/**
 * Fetch a page of candidate VNs that share tags or staff with the seed.
 *
 * VNDB caps at 100 results per request. Use the `page` param (1-based) to
 * paginate. The response includes a `more` boolean — true means another page
 * exists and "Load more" should be shown to the user.
 *
 * The tag filter format is: ["tag", "=", [tagId, maxSpoiler, minLevel]]
 *   - maxSpoiler: 0 = non-spoiler only, 2 = include all spoiler levels
 *   - minLevel:   minimum average vote strength (0–3)
 *
 * @param {string[]} tagIds   - seed tag IDs to match against (up to 12)
 * @param {string[]} staffIds - seed staff IDs to match against (up to 8)
 * @param {number}   [page=1] - 1-based page number
 * @returns {Promise<{ results: object[], more: boolean }>}
 */
async function fetchCandidates(tagIds, staffIds, page = 1) {
  // minLevel 1.0 keeps candidates meaningful; lower = more results but noisier
  const tagFilters   = tagIds.map(id  => ["tag",   "=", [id, 2, 1.0]]);
  const staffFilters = staffIds.map(id => ["staff", "=", ["id", "=", id]]);
  const orPredicate  = ["or", ...tagFilters, ...staffFilters];

  // Return the full response object so callers can read both `results` and `more`
  return vndbPost("/vn", {
    filters: orPredicate,
    fields: [
      "id", "title", "alttitle", "released", "rating",
      "image.url", "image.sexual", "image.violence",
      // We need tags + staff again to score the candidates locally
      "tags.id", "tags.rating", "tags.category",
      "staff.id", "staff.role",
    ].join(", "),
    sort: "votecount",  // surface well-known VNs so their tags are well-voted
    reverse: true,
    results: 100,       // VNDB's per-request maximum
    page,               // 1-based; increment for subsequent pages
  });
}


// ── Tag search (typeahead) ────────────────────────────────────────────────────
/**
 * Search VNDB tags by name. Used to power the tag-mode autocomplete.
 *
 * Results are sorted by vn_count so popular / broad tags appear first.
 *
 * @param {string} query   - partial tag name
 * @param {number} [limit=10]
 */
async function searchTags(query, limit = 10) {
  return vndbPost("/tag", {
    filters: ["search", "=", query],
    fields: "id, name, category, vn_count",
    sort: "vn_count",
    reverse: true,
    results: limit,
  });
}


// ── Tag-mode VN search ────────────────────────────────────────────────────────
/**
 * Fetch VNs that match a set of user-chosen tags directly (tag mode).
 *
 * Unlike the VN-mode flow, there is no second local-scoring step here —
 * VNDB's filter IS the query. We do a light re-rank locally by coverage
 * (how many of the chosen tags the VN actually has) and tag strength.
 *
 * @param {object[]} tags      - array of { id, name } chosen by the user
 * @param {string}   matchMode - "and" (all tags required) or "or" (any tag)
 * @param {number}   minLevel  - minimum tag strength (0–3)
 */
async function fetchVNsByTags(tags, matchMode, minLevel, page = 1) {
  // Build one predicate per chosen tag
  const predicates = tags.map(t => ["tag", "=", [t.id, 2, minLevel]]);

  // If only one tag, use it directly (VNDB doesn't accept ["and", single])
  const filters =
    predicates.length === 1 ? predicates[0]
                            : [matchMode, ...predicates];

  // Return the full response so callers can read both `results` and `more`
  return vndbPost("/vn", {
    filters,
    fields: [
      "id", "title", "alttitle", "released", "rating",
      "image.url", "image.sexual", "image.violence",
      "tags.id", "tags.rating",
    ].join(", "),
    sort: "rating",
    reverse: true,
    results: 100,       // VNDB's per-request maximum
    page,               // 1-based; increment for subsequent pages
  });
}
