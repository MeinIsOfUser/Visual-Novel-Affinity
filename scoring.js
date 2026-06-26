// =============================================================================
// scoring.js — similarity and ranking logic
//
// This file contains all the math that turns raw VNDB tag/staff data into
// an "affinity" score between two visual novels. Everything here is pure:
// no DOM access, no API calls, no side effects.
//
// OVERVIEW OF THE SCORING MODEL
// ─────────────────────────────
// Affinity = (tagWeight × tagScore) + (staffWeight × staffScore)
//
//   tagScore   — cosine similarity between the seed's and candidate's tag
//                rating vectors. Tags the user chose to include (filtering
//                out ero/spoiler if unchecked) act as the coordinate axes.
//
//   staffScore — fraction of the seed's weighted creator "mass" that also
//                appears in the candidate. Writers count more than QA staff.
//
//   tagWeight / staffWeight — set by the user's slider (default 75 / 25).
// =============================================================================


// ── Staff role weights ────────────────────────────────────────────────────────
/**
 * How much each staff role contributes to the staff-similarity score.
 * Scale is arbitrary (only ratios matter). Adjust to taste.
 *
 * The idea: a shared scenario writer is much more predictive of "same feel"
 * than a shared QA tester, so we weight accordingly.
 */
const STAFF_ROLE_WEIGHTS = {
  scenario:   1.0,   // writer — strongest signal
  director:   1.0,   // overall director
  art:        1.0,   // background art
  chardesign: 0.9,   // character design
  music:      0.8,   // composer
  songs:      0.4,   // vocalist — weaker predictor of "feel"
  translator: 0.3,
  editor:     0.3,
  qa:         0.2,
  staff:      0.2,   // catch-all "other staff"
};


// ── Tag vector helpers ────────────────────────────────────────────────────────

/**
 * Build a weighted tag vector from a VN's tag list.
 *
 * The vector is an object mapping tagId → rating (0–3).
 * Tags that fail the user's filter settings are excluded.
 *
 * @param {object[]} tags      - array of tag objects from the VNDB API
 * @param {object}   options
 * @param {boolean}  options.incEro      - include sexual-content (ero) tags?
 * @param {boolean}  options.incSpoiler  - include spoiler level 2 tags?
 * @param {number}   options.depth       - only keep the N highest-rated tags
 * @param {Set}      [options.excluded]  - tag IDs the user has manually removed
 * @returns {object} e.g. { "g1": 2.4, "g505": 1.8, ... }
 */
function buildTagVector(tags, { incEro, incSpoiler, depth, excluded }) {
  const ex = excluded || new Set();

  let filtered = tags.filter(tag => {
    if (tag.category === "ero"  && !incEro)     return false;
    if ((tag.spoiler || 0) >= 2 && !incSpoiler) return false;
    if (ex.has(tag.id))                         return false;  // user-excluded
    return true;
  });

  // Sort by rating descending, then take only the top N.
  // Note: exclusion happens BEFORE the depth slice, so removing a dominant
  // tag lets the next-strongest tag move into the active window — which is
  // what broadens the search.
  filtered.sort((a, b) => b.rating - a.rating);
  filtered = filtered.slice(0, depth);

  // Convert to a plain { id: rating } object
  const vector = {};
  filtered.forEach(tag => { vector[tag.id] = tag.rating; });
  return vector;
}

/**
 * Cosine similarity between two tag vectors (objects of { id: weight }).
 *
 * Returns a value between 0 (completely dissimilar) and 1 (identical).
 * Cosine similarity normalises for vector length, so a short VN with 5
 * highly relevant tags won't automatically beat a long VN with 50 tags.
 *
 * Formula: dot(A, B) / (|A| × |B|)
 *
 * @param {object} vecA
 * @param {object} vecB
 * @returns {number}
 */
function cosine(vecA, vecB) {
  let dot = 0, magA = 0, magB = 0;

  for (const id in vecA) {
    magA += vecA[id] * vecA[id];
    if (vecB[id]) dot += vecA[id] * vecB[id];
  }
  for (const id in vecB) {
    magB += vecB[id] * vecB[id];
  }

  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}


// ── Staff similarity ──────────────────────────────────────────────────────────

/**
 * Build a weighted staff map from a VN's staff list.
 * Maps staffId → highest role-weight for that person (a person can have
 * multiple credits; we take the most important one).
 *
 * @param {object[]} staffList - array of { id, role } objects from VNDB
 * @returns {object} e.g. { "s42": 1.0, "s81": 0.8 }
 */
function buildStaffMap(staffList) {
  const map = {};
  staffList.forEach(s => {
    const w = STAFF_ROLE_WEIGHTS[s.role] ?? 0.2;
    // If the same person has multiple roles, keep the highest-weight one
    map[s.id] = Math.max(map[s.id] || 0, w);
  });
  return map;
}

/**
 * Compute a staff similarity score between a seed VN and a candidate VN.
 *
 * Logic: sum the weights of seed staff members who also appear in the
 * candidate, then divide by the total seed staff weight. This gives a
 * value in [0, 1] representing the fraction of the seed's creative "mass"
 * that reappears. We cap at 1 and apply a 1.6× boost because even a
 * single shared writer is a strong signal and we don't want it drowned out.
 *
 * To make staff matter MORE: increase the multiplier (currently 1.6).
 * To make staff matter LESS: lower it, or reduce the max cap.
 *
 * @param {object} seedStaffMap      - output of buildStaffMap(seed.staff)
 * @param {object[]} candidateStaff  - raw staff array from the candidate VN
 * @returns {number} score in [0, 1]
 */
function staffSimilarity(seedStaffMap, candidateStaff) {
  const seedTotal = Object.values(seedStaffMap).reduce((a, b) => a + b, 0) || 1;

  // Build a quick lookup set for the candidate's staff IDs
  const candidateIds = new Set(candidateStaff.map(s => s.id));

  let shared = 0;
  for (const id in seedStaffMap) {
    if (candidateIds.has(id)) shared += seedStaffMap[id];
  }

  return Math.min(1, (shared / seedTotal) * 1.6);
}

/**
 * Find which staff IDs are shared between the seed and a candidate.
 * Used to populate the "why it matched" labels on result cards.
 *
 * @param {object}   seedStaffMap
 * @param {object[]} candidateStaff
 * @returns {string[]} array of staff IDs
 */
function sharedStaffIds(seedStaffMap, candidateStaff) {
  const candidateIds = new Set(candidateStaff.map(s => s.id));
  return Object.keys(seedStaffMap).filter(id => candidateIds.has(id));
}


// ── Main scoring pipeline (VN mode) ──────────────────────────────────────────

/**
 * Score and rank a list of candidate VNs against a seed VN.
 *
 * @param {object}   seed          - the full seed VN object (with tags + staff)
 * @param {object[]} candidates    - array of candidate VNs from fetchCandidates()
 * @param {object}   options
 * @param {number}   options.tagWeight   - 0–1, how much tag similarity counts
 * @param {boolean}  options.incEro
 * @param {boolean}  options.incSpoiler
 * @param {number}   options.depth       - how many of seed's tags to use
 * @param {Set}      [options.excluded]  - tag IDs to ignore on both sides
 * @returns {object[]} sorted array of:
 *   { vn, score, tagScore, staffScore, matchedTags, matchedStaffIds }
 *   Results are NOT sliced — the caller decides how many to display.
 */
function rankCandidates(seed, candidates, options) {
  const {
    tagWeight,
    incEro,
    incSpoiler,
    depth,
    excluded = new Set(),
  } = options;

  const staffWeight = 1 - tagWeight;

  // Build the seed's tag vector and staff map once, reuse for all candidates
  const seedTagVec  = buildTagVector(seed.tags || [], { incEro, incSpoiler, depth, excluded });
  const seedStaffMap = buildStaffMap(seed.staff || []);

  // The seed's tags in order, used to label "why it matched"
  const seedTagsOrdered = Object.entries(seedTagVec)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);

  const scored = candidates
    // Never include the seed itself in results
    .filter(vn => vn.id !== seed.id)
    .map(vn => {
      // Build candidate tag vector (ero + exclusion filters apply here too,
      // so an excluded tag doesn't distort the candidate's vector length)
      const candidateTagVec = {};
      (vn.tags || []).forEach(t => {
        if (t.category === "ero" && !incEro) return;
        if (excluded.has(t.id))              return;
        candidateTagVec[t.id] = t.rating;
      });

      const tagScore   = cosine(seedTagVec, candidateTagVec);
      const sScore     = staffSimilarity(seedStaffMap, vn.staff || []);
      const totalScore = tagWeight * tagScore + staffWeight * sScore;

      // Which of the seed's top tags does this candidate also have?
      const matchedTags = seedTagsOrdered
        .filter(id => candidateTagVec[id])
        .map(id => id);

      const matchedStaff = sharedStaffIds(seedStaffMap, vn.staff || []);

      return { vn, score: totalScore, tagScore, staffScore: sScore, matchedTags, matchedStaffIds: matchedStaff };
    })
    // Discard extremely weak matches (saves rendering noise)
    .filter(x => x.score > 0.02)
    .sort((a, b) => b.score - a.score);
    // Note: no slice here — the caller appends pages and slices for display

  return scored;
}


// ── Tag-mode re-ranking ───────────────────────────────────────────────────────

/**
 * Re-rank tag-mode results by tag coverage and strength.
 *
 * VNDB already filtered the VNs; this is a lightweight local sort to surface
 * VNs that match MORE of the chosen tags more STRONGLY.
 *
 * coverage = (# of chosen tags present on VN) / (total chosen tags)
 * strength = sum of the matched tags' rating scores
 *
 * @param {object[]} vns       - VNs returned by fetchVNsByTags()
 * @param {object[]} chosenTags - array of { id, name } the user picked
 * @returns {object[]} sorted array of { vn, coverage, matchedTagNames }
 */
function rankByTags(vns, chosenTags) {
  const wantedIds = new Set(chosenTags.map(t => t.id));
  const nameOf    = Object.fromEntries(chosenTags.map(t => [t.id, t.name]));

  return vns
    .map(vn => {
      const hits     = (vn.tags || []).filter(t => wantedIds.has(t.id));
      const coverage = hits.length / chosenTags.length;   // 0–1
      const strength = hits.reduce((sum, t) => sum + t.rating, 0);

      // Combined sort key: heavily weight coverage, then strength, then VNDB rating
      const sortKey = coverage * 100 + strength + (vn.rating || 0) / 40;

      const matchedTagNames = hits.map(t => nameOf[t.id]);

      return { vn, coverage, sortKey, matchedTagNames };
    })
    .sort((a, b) => b.sortKey - a.sortKey);
}
