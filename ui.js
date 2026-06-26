// =============================================================================
// ui.js — DOM interactions, event wiring, and rendering
//
// This file is the "glue" layer. It reads from the DOM (user inputs), calls
// api.js and scoring.js, and writes results back to the DOM.
//
// STRUCTURE
// ─────────
//  1. Mode toggle (VN mode / Tag mode tabs)
//  2. VN Mode
//     a. Seed title autocomplete
//     b. Seed detail display
//     c. Options (sliders, checkboxes)
//     d. "Find similar" button handler
//  3. Tag Mode
//     a. Tag autocomplete
//     b. Chosen-tag chip rendering
//     c. Match-mode toggle (AND / OR)
//     d. "Find VNs" button handler
//  4. Shared rendering helpers (status, error, result cards)
// =============================================================================


// =============================================================================
// 1. MODE TOGGLE
// =============================================================================

document.querySelectorAll(".modes button").forEach(btn => {
  btn.onclick = () => {
    // Update aria-selected on all mode buttons
    document.querySelectorAll(".modes button").forEach(b =>
      b.setAttribute("aria-selected", b === btn)
    );

    const mode = btn.dataset.mode;
    document.getElementById("panel-vn").hidden    = mode !== "vn";
    document.getElementById("panel-tags").hidden  = mode !== "tags";

    // Clear any lingering results when switching modes
    clearOutput();
  };
});

// ── Sort bar wiring ───────────────────────────────────────────────────────────
// Clicking a sort button re-renders the current result set without any new
// API calls. Both modes keep their full ranked arrays in memory so we always
// have the data we need to re-sort instantly.
document.querySelectorAll("#sortMode button").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll("#sortMode button").forEach(b =>
      b.setAttribute("aria-pressed", b === btn)
    );
    currentSort = btn.dataset.v;
    redrawCurrentResults();
  };
});

/**
 * Re-render whichever mode's results are on screen with the new sort order.
 * Called when a sort button is clicked.
 */
function redrawCurrentResults() {
  const vnMode = !document.getElementById("panel-vn").hidden;

  if (vnMode && vnAllRanked.length) {
    const doBlur      = document.getElementById("blur").checked;
    const tagNameOf   = Object.fromEntries((seedVN.tags  || []).map(t => [t.id, t.name]));
    const staffNameOf = Object.fromEntries((seedVN.staff || []).map(s => [s.id, s.name]));
    const cardData = sortResults(vnAllRanked.slice(0, vnShownCount)).map(x => ({
      vn:    x.vn,
      score: x.score,
      why: [
        ...x.matchedStaffIds.slice(0, 2).map(id => ({ type: "staff", label: staffNameOf[id] || "shared staff" })),
        ...x.matchedTags.slice(0, 4).map(id     => ({ type: "tag",   label: tagNameOf[id]   || "shared theme" })),
      ],
    }));
    renderCards(cardData, doBlur, false);

  } else if (!vnMode && tagAllRanked.length) {
    const doBlur   = tagSearchParams?.doBlur ?? false;
    const cardData = sortResults(tagAllRanked.slice(0, tagShownCount)).map(x => ({
      vn:    x.vn,
      score: x.coverage,
      why:   x.matchedTagNames.slice(0, 5).map(name => ({ type: "tag", label: name })),
    }));
    renderCards(cardData, doBlur, true);
  }
}


// =============================================================================
// 2. VN MODE
// =============================================================================

// The currently selected seed VN object (null until the user picks one)
let seedVN = null;

// Tag IDs the user has manually excluded from the current seed's search.
// Reset every time a new seed is chosen.
let excludedTags = new Set();

// ── Sort state ───────────────────────────────────────────────────────────────
// 'score'  — default: affinity/coverage descending
// 'newest' — released date descending (TBA/unknown last)
// 'oldest' — released date ascending  (TBA/unknown last)
// Sorting is purely client-side; no extra API calls are made.
let currentSort = 'score';

// ── VN mode pagination state ──────────────────────────────────────────────────
// All scored results accumulated across pages (so ranking stays globally correct)
let vnAllRanked   = [];
// How many of those results are currently shown on screen
let vnShownCount  = 0;
// The next page number to fetch from VNDB (1-based)
let vnNextPage    = 1;
// Whether VNDB reported more pages available
let vnHasMore     = false;
// Current search params — saved so "Load more" can reuse them
let vnSearchParams = null;
// IDs already seen across pages (prevents duplicates if VNDB overlaps pages)
let vnSeenIds      = new Set();
// How many results to show per page of display
const VN_PAGE_SIZE = 24;

// ── 2a. Seed title autocomplete ───────────────────────────────────────────────

const vnInput  = document.getElementById("vnq");
const vnDropEl = document.getElementById("vndrop");

// Wrap the search in a debounce so we don't fire an API call on every keystroke
const debouncedVNSearch = debounce(async query => {
  if (query.trim().length < 2) { vnDropEl.hidden = true; return; }

  try {
    const { results } = await searchVNsByTitle(query);
    if (!results.length) { vnDropEl.hidden = true; return; }

    vnDropEl.innerHTML = results.map(vn => `
      <div class="row" data-id="${vn.id}">
        <img src="${vn.image?.url || ''}" alt=""
             onerror="this.style.visibility='hidden'">
        <div>
          <div class="t">${esc(vn.title)}</div>
          <div class="m">${year(vn.released)}</div>
        </div>
      </div>`).join("");

    vnDropEl.hidden = false;

    // Clicking a dropdown row selects that VN as the seed
    vnDropEl.querySelectorAll(".row").forEach(row =>
      row.onclick = () => selectSeed(row.dataset.id)
    );
  } catch (_) {
    // Silently ignore typeahead errors (user is still typing)
  }
}, 300);

vnInput.oninput = e => debouncedVNSearch(e.target.value);

// Close the dropdown when the user clicks outside of it
document.addEventListener("click", e => {
  if (!vnInput.parentElement.contains(e.target)) vnDropEl.hidden = true;
});


// ── 2b. Select a seed VN ─────────────────────────────────────────────────────

/**
 * Called when the user picks a VN from the autocomplete dropdown.
 * Fetches full detail (tags + staff) and renders the seed preview.
 */
async function selectSeed(vnId) {
  vnDropEl.hidden = true;
  vnInput.value   = "";
  setStatus("Loading title…", true);

  try {
    seedVN = await fetchVNDetail(vnId);
    excludedTags  = new Set();  // fresh exclusions for the new seed
    resetVNPagination();        // clear any leftover pagination state
    renderSeedPreview();
    clearOutput();

    // Enable the search button now that we have a seed
    const goBtn = document.getElementById("goVN");
    goBtn.disabled = false;
    goBtn.textContent = "Find similar visual novels";

    setStatus("", false);
  } catch (e) {
    setStatus("", false);
    showError(e.message);
  }
}

/**
 * Render the seed VN's cover, title, and summary stats into #seedbox.
 * Called after selectSeed() and whenever the blur checkbox changes.
 */
function renderSeedPreview() {
  if (!seedVN) return;

  const shouldBlur = document.getElementById("blur").checked && isFlagged(seedVN.image);

  document.getElementById("seedbox").innerHTML = `
    <div class="seed">
      <img src="${seedVN.image?.url || ''}" alt=""
           style="${shouldBlur ? 'filter:blur(14px)' : ''}">
      <div>
        <div class="name">${esc(seedVN.title)}</div>
        ${seedVN.alttitle ? `<div class="alt">${esc(seedVN.alttitle)}</div>` : ""}
        <div class="meta">
          ${year(seedVN.released)} ·
          ${seedVN.rating ? formatRating(seedVN.rating) + " rating" : "unrated"} ·
          ${(seedVN.tags  || []).length} tags ·
          ${(seedVN.staff || []).length} staff credits
        </div>
      </div>
    </div>
    <!-- Tag toggles are injected here by renderSeedTags() -->
    <div class="seed-tags" id="seedTags"></div>`;

  renderSeedTags();
}

/**
 * Render the seed's tags as clickable chips and reflect their current state.
 *
 * Three visual states:
 *   - active  (full colour) : within the current theme-depth window → used in search
 *   - dim                    : passes filters but ranked below the depth cutoff
 *   - off (struck through)   : manually excluded by the user
 *
 * Clicking any chip toggles its excluded state and re-renders. Excluding an
 * active tag promotes the next-strongest tag into the active window, which is
 * how the user broadens the search.
 *
 * Called by renderSeedPreview() and whenever depth / ero / spoiler change.
 */
function renderSeedTags() {
  const el = document.getElementById("seedTags");
  if (!seedVN || !el) return;

  const incEro     = document.getElementById("incEro").checked;
  const incSpoiler = document.getElementById("incSpoiler").checked;
  const depth      = +document.getElementById("depth").value;

  // Tags visible for toggling: those that pass the content filters, by rating.
  // (Capped at 40 so the list stays manageable for tag-heavy VNs.)
  const visible = (seedVN.tags || [])
    .filter(t => (t.category !== "ero" || incEro) && ((t.spoiler || 0) < 2 || incSpoiler))
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 40);

  // The vector tells us which tags are *actually* active right now
  const activeVec   = buildTagVector(seedVN.tags || [], { incEro, incSpoiler, depth, excluded: excludedTags });
  const activeCount = Object.keys(activeVec).length;

  el.innerHTML = `
    <p class="hint">
      <b>${activeCount}</b> of these themes shape the search —
      tap any tag to exclude it and broaden the results.
    </p>
    <div class="tags-wrap">
      ${visible.map(t => {
        const isOff    = excludedTags.has(t.id);
        const isActive = !isOff && activeVec[t.id] !== undefined;
        const cls      = isOff ? "off" : (isActive ? "" : "dim");
        const title    = isOff ? "excluded — click to restore"
                       : isActive ? "used in search — click to exclude"
                       : "below theme depth — click to exclude";
        return `
          <span class="ttag ${cls}" data-id="${t.id}" title="${title}">
            <span class="dot ${t.category}"></span>${esc(t.name)}
            <span class="rt">${t.rating.toFixed(1)}</span>
          </span>`;
      }).join("")}
    </div>`;

  // Wire up toggling
  el.querySelectorAll(".ttag").forEach(chip =>
    chip.onclick = () => {
      const id = chip.dataset.id;
      if (excludedTags.has(id)) excludedTags.delete(id);
      else                      excludedTags.add(id);
      renderSeedTags();  // re-render to update active/dim/off states live
    }
  );
}


// ── 2c. VN mode option controls ───────────────────────────────────────────────

// Weighting slider: left = all staff, right = all themes
document.getElementById("weight").oninput = e => {
  const t = +e.target.value; // tag weight %
  document.getElementById("wlabel").textContent =
    `${t}% themes · ${100 - t}% staff`;
};

// Depth slider: how many of the seed's top tags to compare against
document.getElementById("depth").oninput = e => {
  document.getElementById("depthlabel").textContent = `top ${e.target.value} tags`;
  renderSeedTags();   // active/dim states shift as the depth window changes
};

// Content-tag toggles affect which tags are eligible, so refresh the chips
document.getElementById("incEro").onchange     = renderSeedTags;
document.getElementById("incSpoiler").onchange = renderSeedTags;

// Re-render seed preview when blur preference changes
document.getElementById("blur").onchange = renderSeedPreview;


// ── 2d. "Find similar" button ─────────────────────────────────────────────────

document.getElementById("goVN").onclick = runVNModeSearch;

/**
 * Reset all VN-mode pagination state.
 * Called at the start of a fresh search and when a new seed is picked.
 */
function resetVNPagination() {
  vnAllRanked   = [];
  vnShownCount  = 0;
  vnNextPage    = 1;
  vnHasMore     = false;
  vnSeenIds     = new Set();
  // Note: vnSearchParams is intentionally NOT reset here.
  // It is set by runVNModeSearch() before this is called, and must
  // survive the reset so loadMoreVN() can read it on page 1.
}

/**
 * Fresh search — resets pagination then fetches page 1.
 */
async function runVNModeSearch() {
  if (!seedVN) return;

  const tagWeight  = +document.getElementById("weight").value / 100;
  const depth      = +document.getElementById("depth").value;
  const incEro     = document.getElementById("incEro").checked;
  const incSpoiler = document.getElementById("incSpoiler").checked;
  const doBlur     = document.getElementById("blur").checked;

  // Build the seed's active tag vector (respects manual exclusions)
  const seedTagVec = buildTagVector(seedVN.tags || [], { incEro, incSpoiler, depth, excluded: excludedTags });
  const tagIds     = Object.keys(seedTagVec);

  if (!tagIds.length) {
    showError("No themes left to compare — you've excluded them all, or the title has no usable tags. Restore a tag, or enable spoiler / sexual-content tags.");
    return;
  }

  // Only pass highly-weighted staff to the candidate query (writer/director/artist)
  const seedStaffMap = buildStaffMap(seedVN.staff || []);
  const keyStaffIds  = Object.entries(seedStaffMap)
    .filter(([, w]) => w >= 0.8)
    .map(([id]) => id)
    .slice(0, 8);

  // Set params BEFORE resetVNPagination — the reset no longer nulls params,
  // but keeping this order explicit documents the dependency clearly.
  vnSearchParams = { tagIds: tagIds.slice(0, 12), keyStaffIds, tagWeight, incEro, incSpoiler, depth, doBlur };

  resetVNPagination();
  setStatus("Searching the database for shared themes…", true);
  clearOutput();

  await loadMoreVN();
}

/**
 * Fetch the next page of candidates, score them, merge into vnAllRanked,
 * and display up to VN_PAGE_SIZE more cards.
 * Called by both the initial search and the "Load more" button.
 */
async function loadMoreVN() {
  // Guard: vnSearchParams must be set by runVNModeSearch() before this runs.
  // If it's null something has gone wrong with call order — bail cleanly.
  if (!vnSearchParams) {
    showError("Search parameters missing — please run the search again.");
    return;
  }
  const { tagIds, keyStaffIds, tagWeight, incEro, incSpoiler, depth, doBlur } = vnSearchParams;
  const loadBtn = document.getElementById("loadMoreBtn");
  if (loadBtn) loadBtn.disabled = true;

  setStatus("Fetching more results…", true);

  try {
    const { results: candidates, more } = await fetchCandidates(tagIds, keyStaffIds, vnNextPage);
    vnNextPage++;
    vnHasMore = more;

    // Deduplicate — VNDB can occasionally return the same VN across pages
    const fresh = candidates.filter(vn => {
      if (vnSeenIds.has(vn.id)) return false;
      vnSeenIds.add(vn.id);
      return true;
    });

    // Score this batch and merge into the global ranked list, then re-sort
    const newScored = rankCandidates(seedVN, fresh, { tagWeight, incEro, incSpoiler, depth, excluded: excludedTags });
    vnAllRanked = [...vnAllRanked, ...newScored].sort((a, b) => b.score - a.score);

    // Build name lookup maps for card labels
    const tagNameOf   = Object.fromEntries((seedVN.tags  || []).map(t => [t.id, t.name]));
    const staffNameOf = Object.fromEntries((seedVN.staff || []).map(s => [s.id, s.name]));

    // Determine the next slice to show
    const prevShown  = vnShownCount;
    vnShownCount     = Math.min(vnAllRanked.length, vnShownCount + VN_PAGE_SIZE);

    if (vnAllRanked.length === 0) {
      setStatus("", false);
      document.getElementById("results").innerHTML =
        '<div class="empty">No close matches — try increasing theme depth or including more tag types.</div>';
      return;
    }

    // Render the full visible slice (not just the new cards) so global re-sort
    // can reorder earlier pages correctly as new high-scoring matches arrive
    const cardData = vnAllRanked.slice(0, vnShownCount).map(x => ({
      vn:    x.vn,
      score: x.score,
      why: [
        ...x.matchedStaffIds.slice(0, 2).map(id => ({ type: "staff", label: staffNameOf[id] || "shared staff" })),
        ...x.matchedTags.slice(0, 4).map(id     => ({ type: "tag",   label: tagNameOf[id]   || "shared theme" })),
      ],
    }));

    const totalDesc = vnHasMore
      ? `${vnShownCount} of ${vnAllRanked.length}+ results`
      : `${vnAllRanked.length} kindred titles`;
    setStatus(`${totalDesc}, most similar first`, false);

    renderCards(cardData, doBlur, false);

    // Show/hide "Load more" — visible when there are more VNDB pages OR more
    // already-scored results that haven't been shown yet
    const canShowMore = vnHasMore || vnShownCount < vnAllRanked.length;
    renderLoadMore(canShowMore, loadMoreVN);

  } catch (e) {
    setStatus("", false);
    showError(e.message);
  }
}


// =============================================================================
// 3. TAG MODE
// =============================================================================

// Array of the user's chosen tags: [{ id, name, category }, ...]
let chosenTags = [];

// ── Tag mode pagination state ─────────────────────────────────────────────────
// All VNs fetched and ranked so far across pages
let tagAllRanked   = [];
// How many are currently shown
let tagShownCount  = 0;
// Next VNDB page to request
let tagNextPage    = 1;
// Whether VNDB says more pages exist
let tagHasMore     = false;
// Saved params for "Load more"
let tagSearchParams = null;
const TAG_PAGE_SIZE = 24;

// ── 3a. Tag autocomplete ──────────────────────────────────────────────────────

const tagInput  = document.getElementById("tagq");
const tagDropEl = document.getElementById("tagdrop");

const debouncedTagSearch = debounce(async query => {
  if (query.trim().length < 2) { tagDropEl.hidden = true; return; }

  try {
    const { results } = await searchTags(query);

    // Filter out tags the user already added
    const fresh = results.filter(t => !chosenTags.find(c => c.id === t.id));
    if (!fresh.length) { tagDropEl.hidden = true; return; }

    tagDropEl.innerHTML = fresh.map(t => `
      <div class="row tagrow"
           data-id="${t.id}" data-name="${esc(t.name)}" data-cat="${t.category}">
        <div style="display:flex;align-items:center;gap:8px">
          <span class="dot ${t.category}"></span>
          <span class="t">${esc(t.name)}</span>
        </div>
        <span class="pill">${(t.vn_count || 0).toLocaleString()} VNs</span>
      </div>`).join("");

    tagDropEl.hidden = false;

    tagDropEl.querySelectorAll(".row").forEach(row =>
      row.onclick = () => {
        // Add this tag to the chosen list
        chosenTags.push({ id: row.dataset.id, name: row.dataset.name, category: row.dataset.cat });
        tagInput.value  = "";
        tagDropEl.hidden = true;
        renderTagChips();
      }
    );
  } catch (_) { /* silent */ }
}, 300);

tagInput.oninput = e => debouncedTagSearch(e.target.value);

document.addEventListener("click", e => {
  if (!tagInput.parentElement.contains(e.target)) tagDropEl.hidden = true;
});


// ── 3b. Tag chip rendering ────────────────────────────────────────────────────

/**
 * Re-render the row of chosen-tag chips and update the go button state.
 * Called whenever chosenTags changes.
 */
function renderTagChips() {
  const box = document.getElementById("tagchips");

  box.innerHTML = chosenTags.map((t, i) => `
    <span class="chip">
      <span class="dot ${t.category}"></span>
      ${esc(t.name)}
      <!-- data-i is the index into chosenTags[] -->
      <span class="x" data-i="${i}">✕</span>
    </span>`).join("");

  // Wire up the remove (✕) buttons
  box.querySelectorAll(".x").forEach(x =>
    x.onclick = () => {
      chosenTags.splice(+x.dataset.i, 1); // remove by index
      renderTagChips();
    }
  );

  // Keep the go button in sync
  const goBtn = document.getElementById("goTags");
  goBtn.disabled = chosenTags.length === 0;
  goBtn.textContent = chosenTags.length
    ? `Find visual novels (${chosenTags.length} tag${chosenTags.length > 1 ? "s" : ""})`
    : "Add at least one tag";
}


// ── 3c. Match-mode toggle (AND / OR) ─────────────────────────────────────────

document.querySelectorAll("#matchmode button").forEach(btn =>
  btn.onclick = () =>
    document.querySelectorAll("#matchmode button").forEach(b =>
      b.setAttribute("aria-pressed", b === btn)
    )
);


// ── 3d. Min tag strength slider ───────────────────────────────────────────────

document.getElementById("minlvl").oninput = e =>
  document.getElementById("lvllabel").textContent = (+e.target.value).toFixed(1);


// ── 3e. "Find VNs" button ─────────────────────────────────────────────────────

document.getElementById("goTags").onclick = runTagModeSearch;

/**
 * Fresh tag-mode search — resets pagination then fetches page 1.
 */
async function runTagModeSearch() {
  if (!chosenTags.length) return;

  const matchMode = document.querySelector("#matchmode button[aria-pressed='true']").dataset.v;
  const minLevel  = +document.getElementById("minlvl").value;
  const doBlur    = document.getElementById("blur2").checked;

  tagSearchParams = { matchMode, minLevel, doBlur };
  tagAllRanked    = [];
  tagShownCount   = 0;
  tagNextPage     = 1;
  tagHasMore      = false;

  setStatus("Searching…", true);
  clearOutput();
  await loadMoreTags();
}

/**
 * Fetch the next page of tag-mode results, merge and re-rank, then display.
 * Called by the initial search and by the "Load more" button.
 */
async function loadMoreTags() {
  if (!tagSearchParams) {
    showError("Search parameters missing — please run the search again.");
    return;
  }
  const { matchMode, minLevel, doBlur } = tagSearchParams;
  const loadBtn = document.getElementById("loadMoreBtn");
  if (loadBtn) loadBtn.disabled = true;

  setStatus("Fetching more results…", true);

  try {
    const { results: vns, more } = await fetchVNsByTags(chosenTags, matchMode, minLevel, tagNextPage);
    tagNextPage++;
    tagHasMore = more;

    // Merge new results into the ranked pool and re-sort
    const newRanked = rankByTags(vns, chosenTags);
    tagAllRanked    = [...tagAllRanked, ...newRanked].sort((a, b) => b.sortKey - a.sortKey);

    tagShownCount = Math.min(tagAllRanked.length, tagShownCount + TAG_PAGE_SIZE);

    if (tagAllRanked.length === 0) {
      setStatus("", false);
      document.getElementById("results").innerHTML =
        '<div class="empty">Nothing matched. Lower the tag strength or switch to "Has any tag".</div>';
      return;
    }

    const cardData = tagAllRanked.slice(0, tagShownCount).map(x => ({
      vn:    x.vn,
      score: x.coverage,
      why:   x.matchedTagNames.slice(0, 5).map(name => ({ type: "tag", label: name })),
    }));

    const totalDesc = tagHasMore
      ? `${tagShownCount} of ${tagAllRanked.length}+ matches`
      : `${tagAllRanked.length} matches`;
    setStatus(totalDesc, false);

    renderCards(cardData, doBlur, true);

    const canShowMore = tagHasMore || tagShownCount < tagAllRanked.length;
    renderLoadMore(canShowMore, loadMoreTags);

  } catch (e) {
    setStatus("", false);
    showError(e.message);
  }
}


// =============================================================================
// 4. SHARED RENDERING HELPERS
// =============================================================================

/**
 * Show/hide a status message (with optional spinner).
 *
 * @param {string}  text     - message to display, or "" to clear
 * @param {boolean} loading  - whether to show the spinner
 */
function setStatus(text, loading) {
  document.getElementById("status").innerHTML = text
    ? `<div class="status">
         ${loading ? '<span class="spin"></span>' : ""}
         ${esc(text)}
       </div>`
    : "";
}

/**
 * Show a styled error message in the status area.
 *
 * @param {string} message
 */
function showError(message) {
  document.getElementById("status").innerHTML =
    `<div class="err">${esc(message)}</div>`;
}

/** Clear the status bar, results grid, sort bar, and any load-more button. */
function clearOutput() {
  document.getElementById("status").innerHTML  = "";
  document.getElementById("results").innerHTML = "";
  document.getElementById("sortBar").hidden    = true;
  // Reset sort back to default so the bar starts fresh on next search
  currentSort = "score";
  document.querySelectorAll("#sortMode button").forEach(b =>
    b.setAttribute("aria-pressed", b.dataset.v === "score")
  );
  const wrap = document.getElementById("loadMoreWrap");
  if (wrap) wrap.remove();
}

/**
 * Sort a result array according to currentSort.
 *
 * VNDB date strings: 'YYYY-MM-DD', 'YYYY-MM', 'YYYY', 'TBA', or null.
 * We convert them to an integer for comparison:
 *   '2004-10-29' -> 20041029
 *   '2004-10'    -> 20041000  (day unknown)
 *   '2004'       -> 20040000  (month+day unknown)
 *   'TBA' / null -> 0         (sorted to the bottom in both directions)
 *
 * @param {object[]} items - each item must have a .vn.released field
 * @returns {object[]} new sorted array (original not mutated)
 */
function sortResults(items) {
  if (currentSort === 'score') {
    // Re-sort by score descending defensively (page merges can disturb order)
    return [...items].sort((a, b) => {
      const sa = a.score    ?? a.coverage ?? 0;
      const sb = b.score    ?? b.coverage ?? 0;
      return sb - sa;
    });
  }

  // Convert a VNDB date string to a sortable integer
  function dateKey(vn) {
    const d = vn.released;
    if (!d || d === 'TBA') return 0;  // unknown: sort to end
    const parts = d.split('-');
    const y   = parts[0] || '0000';
    const m   = (parts[1] || '00').padStart(2, '0');
    const day = (parts[2] || '00').padStart(2, '0');
    return parseInt(y + m + day, 10);
  }

  return [...items].sort((a, b) => {
    const ka = dateKey(a.vn);
    const kb = dateKey(b.vn);
    // Unknown dates always sink to the bottom regardless of sort direction
    if (ka === 0 && kb === 0) return 0;
    if (ka === 0) return  1;
    if (kb === 0) return -1;
    return currentSort === 'newest' ? kb - ka : ka - kb;
  });
}

/**
 * Show or hide the "Load more" button below the results grid.
 *
 * @param {boolean}  show     - whether to render the button at all
 * @param {Function} handler  - the async function to call when clicked
 */
function renderLoadMore(show, handler) {
  // Remove any existing load-more wrapper first
  const existing = document.getElementById("loadMoreWrap");
  if (existing) existing.remove();

  if (!show) return;

  const wrap = document.createElement("div");
  wrap.id        = "loadMoreWrap";
  wrap.className = "load-more-wrap";
  wrap.innerHTML = `<button class="load-more" id="loadMoreBtn">Load more</button>`;
  document.getElementById("results").after(wrap);

  document.getElementById("loadMoreBtn").onclick = handler;
}

/**
 * Render an array of result objects as a grid of cards.
 *
 * @param {object[]} items       - array of { vn, score, why[] }
 * @param {boolean}  doBlur      - whether to blur flagged covers
 * @param {boolean}  isCoverage  - if true, label the score "tag match" instead of "affinity"
 */
function renderCards(items, doBlur, isCoverage) {
  // Show the sort bar now that we have results
  document.getElementById("sortBar").hidden = false;
  // Relabel the score button to match the current mode
  document.querySelector("#sortMode button[data-v='score']").textContent =
    isCoverage ? "Coverage" : "Affinity";

  // Apply the active sort before rendering
  items = sortResults(items);

  document.getElementById("results").innerHTML =
    '<div class="grid">' +
    items.map(({ vn, score, why }) => {
      const blurCover = doBlur && isFlagged(vn.image);
      const ratingStr = formatRating(vn.rating);
      const scoreLabel = isCoverage ? "tag match" : "affinity";

      return `
        <a class="card" href="https://vndb.org/${vn.id}" target="_blank" rel="noopener">

          <!-- Cover image -->
          <div class="cov ${blurCover ? "flagged" : ""}">
            ${vn.image?.url
              ? `<img class="${blurCover ? "blur" : ""}"
                      src="${vn.image.url}" alt="" loading="lazy">`
              : ""}
            <div class="nsfw">flagged</div>
            ${buildArcBadge(score)}
          </div>

          <!-- Text body -->
          <div class="body">
            <div class="ttl">${esc(vn.title)}</div>

            <div class="row2">
              <span>${year(vn.released)}</span>
              ${ratingStr
                ? `<span class="rate">★ ${ratingStr}</span>`
                : `<span>unrated</span>`}
              <span style="margin-left:auto; color:var(--muted)">
                ${scoreLabel} ${Math.round(score * 100)}%
              </span>
            </div>

            <!-- "Why it matched" tag/staff chips -->
            ${why.length
              ? `<div class="why">
                   ${why.map(w => `
                     <span class="mtag ${w.type === "staff" ? "staff" : ""}">
                       ${w.type === "staff" ? "✎ " : ""}${esc(w.label)}
                     </span>`).join("")}
                 </div>`
              : ""}
          </div>
        </a>`;
    }).join("") +
    "</div>";
}
