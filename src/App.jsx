import { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { supabase } from "./supabaseClient";
import Papa from "papaparse";
import html2canvas from "html2canvas";

// ─── DESIGN SYSTEM TOKENS (Claude Design visual pass) ──────────
// Ported from the Kindred Taste-Matching Visual System handoff. Mood-axis
// tokens (cyan as a 3rd archetype axis) were intentionally dropped — the
// real app only has category + behavior, no mood data exists anywhere to
// back a 3-axis display. Cyan stays in the palette for general UI accents
// (it's a nice color) but is no longer reserved for archetype display.
const G = {
  bg:'#0D0D14', deep:'#13131b', card:'rgba(255,255,255,0.03)',
  border:'#2A2A36', borderDim:'#1A1A23',
  purple:'#6C5DD3', purpleLight:'#9D92F0', purpleDim:'rgba(108,93,211,0.08)',
  cyan:'#00D4FF', amber:'#F59E0B', green:'#10B881', pink:'#FF689D', gold:'#FFD66B',
  text:'#F5F7FA', muted:'#C4C8DA', dim:'#8B8FA6', faint:'#5B6079',
};

const FONTS = `@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,300;1,400&family=Inter:wght@400;500;600&family=Space+Mono:wght@400;700&display=swap');`;
const TARGET = 5;

const DOMAINS = [
  { key:'film',  label:'Film & TV', icon:'🎬', color:G.purple, placeholder:'Search movies and shows...' },
  { key:'games', label:'Games',     icon:'🎮', color:G.cyan,   placeholder:'Search video games...'     },
  { key:'books', label:'Books',     icon:'📚', color:G.amber,  placeholder:'Search books...'           },
];

// How many total ratings before we'll even attempt a twin match. Below this,
// the pool of overlap is too thin to guarantee a match that actually feels good,
// so we gate the reveal instead of showing a weak/empty result on day one.
const TWIN_UNLOCK_THRESHOLD = 8;

// Explorer level — purely a fun progression label based on total items rated.
const LEVELS = [
  { min: 0,  label: 'New Arrival' },
  { min: 1,  label: 'Wanderer' },
  { min: 5,  label: 'Explorer' },
  { min: 15, label: 'Connoisseur' },
  { min: 30, label: 'Taste Master' },
];
function getExplorerLevel(totalRated) {
  let current = LEVELS[0];
  for (const l of LEVELS) { if (totalRated >= l.min) current = l; }
  return current.label;
}

// ─── ARCHETYPE — 2-AXIS COMBINATORIAL SYSTEM ─────────────────
// UPDATE: the original spec had a 3rd "mood/tone" axis (Chaotic, Feral,
// etc). That's been dropped — it read as gimmicky/made-up. Now it's just
// category + a real, human-sounding behavior word: 8 categories x 8
// behavior words = 64 combinations, without sounding like a personality
// quiz. Each axis still gets computed independently from real rating data.

// Design system note: category tags are always the single green token
// (#10B881) per the new visual system — the category NAME differentiates
// them, not 8 different colors per category like the old palette did.
// Kept as a function (not a flat constant) so call sites that destructure
// a per-category color still work without changing every call site.
const CATEGORY_COLOR = '#10B881';
const CATEGORY_COLORS = {
  'Sci-Fi':CATEGORY_COLOR, Horror:CATEGORY_COLOR, 'Literary Fiction':CATEGORY_COLOR, 'Strategy Games':CATEGORY_COLOR,
  'Prestige Drama':CATEGORY_COLOR, Fantasy:CATEGORY_COLOR, Indie:CATEGORY_COLOR, Action:CATEGORY_COLOR,
};

// Best-effort keyword match against real rated titles. With the catalog now
// fully open (real search, not a fixed list), this won't catch everything —
// that's expected; pickCategoryAxis falls back to domain spread when it does.
const CATEGORY_KEYWORDS = {
  'Sci-Fi': ['interstellar','blade runner','dune','arrival','ex machina','inception','2001','contact','martian','foundation'],
  'Horror': ['ring','exorcist','hereditary','midsommar','conjuring','resident evil','silent hill','it follows'],
  'Literary Fiction': ['ishiguro','atwood','never let me go','beloved','the road','life of pi'],
  'Strategy Games': ['civilization','age of empires','xcom','crusader kings','total war','starcraft','frostpunk'],
  'Prestige Drama': ['succession','the wire','breaking bad','mad men','the sopranos'],
  'Fantasy': ['witcher','lord of the rings','name of the wind','game of thrones'],
  'Indie': ['hollow knight','celeste','stardew','undertale','hades','disco elysium'],
  'Action': ['dark souls','god of war','devil may cry','doom','red dead','elden ring'],
};

// AXIS 2 — behavior words, grouped into the four buckets the spec
// describes. Two near-synonyms per bucket; a seed-hash picks between them
// so two users landing in the same bucket don't necessarily get the
// identical word, without making the choice unstable per-render.
const BEHAVIOR_BUCKETS = {
  fanatic:    ['Fanatic', 'Diehard'],     // very high count concentrated in the dominant category
  connoisseur:['Connoisseur', 'Snob'],    // high count + consistently top ratings — quality-focused
  aficionado: ['Aficionado', 'Lover'],    // broad engagement, solid count, decent average — the default enthusiast
  nerd:       ['Junkie', 'Nerd'],         // thinner data / lower count — catch-all for newer profiles
};

function hashPick(seed, list) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % list.length;
  return list[Math.abs(hash) % list.length];
}

function pickCategoryAxis(ratings) {
  const allTitles = Object.keys({...ratings.film, ...ratings.games, ...ratings.books}).map(t => t.toLowerCase());
  const scores = {};
  Object.entries(CATEGORY_KEYWORDS).forEach(([cat, keywords]) => {
    scores[cat] = allTitles.filter(t => keywords.some(k => t.includes(k))).length;
  });
  const best = Object.entries(scores).sort((a,b) => b[1] - a[1])[0];
  if (best && best[1] > 0) return { category: best[0], matched: best[1] };
  // No keyword matches — fall back to whichever domain they rate most
  const counts = { film: Object.keys(ratings.film).length, games: Object.keys(ratings.games).length, books: Object.keys(ratings.books).length };
  const domainFallback = { film: 'Prestige Drama', games: 'Action', books: 'Literary Fiction' };
  const topDomain = Object.entries(counts).sort((a,b) => b[1] - a[1])[0][0];
  return { category: domainFallback[topDomain], matched: 0 };
}

// Behavior is now driven by volume/pattern WITHIN the dominant category
// specifically (not a global cross-domain comparison like the old version),
// per the updated spec. Casual mapping is fine to start — this is more
// about tone/flavor than a precise behavioral signal, refine later once
// there's real usage data to look at.
function pickBehaviorAxis(seed, category, ratings) {
  const allTitles = { ...ratings.film, ...ratings.games, ...ratings.books };
  const keywords = CATEGORY_KEYWORDS[category] || [];
  // Titles that matched the dominant category's keyword list, with their rating.
  const inCategory = Object.entries(allTitles)
    .filter(([title]) => keywords.some(k => title.toLowerCase().includes(k)))
    .map(([, rating]) => rating)
    .filter(Boolean);

  const count = inCategory.length;
  const avg = count ? inCategory.reduce((a, b) => a + b, 0) / count : 0;

  let bucket;
  if (count >= 8) bucket = 'fanatic';                  // very high count concentrated here
  else if (count >= 4 && avg >= 4.3) bucket = 'connoisseur'; // high count + consistently top ratings
  else if (count >= 2) bucket = 'aficionado';           // broad engagement, solid count
  else bucket = 'nerd';                                 // thin data — catch-all for newer profiles

  return hashPick(seed + category, BEHAVIOR_BUCKETS[bucket]);
}

function buildArchetype(seed, ratings) {
  const { category } = pickCategoryAxis(ratings);
  const behavior = pickBehaviorAxis(seed, category, ratings);
  return { category, behavior, categoryColor: CATEGORY_COLORS[category] || G.purple };
}

// ─── AFFILIATE LINKS ──────────────────────────────────────────
// Amazon covers every type today. Books are isolated in their own branch
// here on purpose — once Bookshop.org approves the account, this becomes a
// one-line swap to bookshop.org/a/[affiliate-id]/[isbn] using the existing
// /api/search-books endpoint for the ISBN, instead of touching every call site.
const AMAZON_TAG = 'kindredmatch-20';
// Bookshop is approved — books now get real ISBN-based affiliate links.
// IMPORTANT: replace this with your real Bookshop affiliate ID from the
// Bookshop dashboard before deploying.
const BOOKSHOP_AFFILIATE_ID = '125337';

// Books need a live ISBN lookup (we don't store ISBNs on ratings), so this
// is now async. Film/games stay sync-fast via Amazon search links since
// TMDB/RAWG don't expose ASINs anyway.
async function buildAffiliateLink(type, title) {
  if (type === 'book') {
    const isbn = await lookupISBN(title);
    if (isbn) return `https://bookshop.org/a/${BOOKSHOP_AFFILIATE_ID}/${isbn}`;
    // No confident ISBN match — fall back to Amazon rather than a dead link.
  }
  return `https://www.amazon.com/s?k=${encodeURIComponent(title)}&tag=${AMAZON_TAG}`;
}

// Looks up an ISBN for a book title via the existing search endpoint.
// Backed by /api/search-books, which requests Open Library's `isbn` field
// directly (fixed alongside this rebuild — it wasn't being requested before).
async function lookupISBN(title) {
  try {
    const res = await fetch(`/api/search-books?q=${encodeURIComponent(title)}`);
    const data = await res.json();
    const match = data.results?.find(r => r.title?.toLowerCase() === title.toLowerCase()) || data.results?.[0];
    return match?.isbn || null;
  } catch (e) {
    return null;
  }
}

// Looks up a poster/cover image for a rec card by title, reusing the same
// search endpoints the rating screen already uses (TMDB poster, RAWG
// background_image, Open Library cover) — so rec cards show real cover art
// instead of a generic emoji icon, matching what the rating screen shows.
// Best-effort: a failed or missing lookup just falls back to the emoji icon
// the card already renders, so this never blocks the recs screen.
async function lookupPosterImage(type, title) {
  try {
    const endpoint = type === 'book' ? `/api/search-books?q=${encodeURIComponent(title)}`
                    : type === 'game' ? `/api/search-games?q=${encodeURIComponent(title)}`
                    : `/api/search-film?q=${encodeURIComponent(title)}`;
    const res = await fetch(endpoint);
    const data = await res.json();
    const match = data.results?.find(r => r.title?.toLowerCase() === title.toLowerCase()) || data.results?.[0];
    return match?.poster || null;
  } catch (e) {
    return null;
  }
}

// Freshness — a lightweight, display-only placeholder for a future real decay
// system. No timestamps tracked yet: it simply measures progress toward the
// next 5-rating milestone, so it gives people a reason to keep adding ratings
// without us having to build full time-based decay yet.
function getFreshness(totalRated) {
  if (totalRated === 0) return { pct: 0, remaining: 5 };
  const intoCurrentBand = totalRated % 5;
  if (intoCurrentBand === 0) return { pct: 100, remaining: 0 };
  return { pct: Math.round((intoCurrentBand / 5) * 100), remaining: 5 - intoCurrentBand };
}

// Single source of truth for the "category:title" key used everywhere
// matching/rarity logic groups two ratings as "the same item" — twin
// matching, rarity weighting, and all four rec tiers. Lowercased to match
// the bot's matching key exactly: the bot has always lowercased here, so a
// title that comes back from a catalog API in slightly different casing
// across platforms (or gets free-typed by a Discord user in different
// case) previously failed to match on web even though it matched on
// Discord, silently undercounting otherwise-real shared favorites. This
// can only ever surface MORE matches than before, never fewer — existing
// matches that already worked keep working identically.
function matchKey(category, itemName) {
  return `${category}:${itemName.toLowerCase()}`;
}

// Rare shared titles should count more toward a match than mainstream ones.
// Weight runs from 0.3 (almost everyone has rated it) up to 3 (almost nobody else has).
function computeRarityWeights(allTastes) {
  const raterSets = {};
  allTastes.forEach(t => {
    const key = matchKey(t.category, t.item_name);
    if (!raterSets[key]) raterSets[key] = new Set();
    raterSets[key].add(t.user_id);
  });
  const totalUsers = new Set(allTastes.map(t => t.user_id)).size;
  const weights = {};
  Object.keys(raterSets).forEach(key => {
    const raterCount = raterSets[key].size;
    const raw = Math.log((totalUsers + 1) / (raterCount + 1)) + 0.3;
    weights[key] = Math.max(0.3, Math.min(3, raw));
  });
  return weights;
}

function buildWhyText(twin) {
  if (!twin.shared || twin.shared.length === 0) return null;
  const top = twin.shared.slice(0, 3).map(s => s.title);
  if (top.length === 1) return `Matched mostly on ${top[0]}. Not many people have rated that one.`;
  const last = top.pop();
  return `Matched mostly on ${top.join(', ')} and ${last}. Rare picks that few others share.`;
}

// ─── TASTE PASSPORT RADAR (real data, no mood axis) ────────────
// The Claude Design handoff specifies a 9-axis radar (3 mood / 3 category /
// 3 behavior) with named sub-scores like "Sci-Fi 45%, Psych-Horror 22%."
// None of that exists in the real archetype system — buildArchetype only
// ever produces ONE category and ONE behavior word, no mood axis, no
// per-genre breakdown. Rather than invent fake sub-scores to fill out a
// 9-point shape, this radar shows one REAL axis per domain the user has
// actually rated in (film/games/books — so 1-3 axes, not a fixed 9), each
// value being their average rarity-weight among their own 4-5★ ratings in
// that domain. Rarity-weight is the same real signal twin-matching already
// uses (computeRarityWeights) — high values mean "you tend to love things
// few other people have rated," which is genuinely what makes someone's
// taste distinctive, without claiming any number that isn't true.
function buildRarityRadarData(ratings, allTastes) {
  const rarityWeights = computeRarityWeights(allTastes);
  const domainLabels = { film: 'Film & TV', games: 'Games', books: 'Books' };
  const axes = [];

  Object.entries(domainLabels).forEach(([domain, label]) => {
    const loved = Object.entries(ratings[domain] || {}).filter(([, v]) => v >= 4);
    if (loved.length === 0) return; // no real signal in this domain — omit the axis rather than show a fake 0
    const weights = loved.map(([title]) => rarityWeights[`${domain}:${title}`] || 1);
    const avgWeight = weights.reduce((a, b) => a + b, 0) / weights.length;
    // Rarity weights range roughly 0.3-3 (see computeRarityWeights) — normalize
    // to a 0-1 display value for the radar's plotting math.
    const normalized = Math.max(0.15, Math.min(1, (avgWeight - 0.3) / 2.7));
    axes.push({ label, value: normalized, count: loved.length });
  });

  return axes;
}

// ─── 5-TIER RECOMMENDATION ENGINE ─────────────────────────────
// Replaces the old approach (hand the user's ratings to Claude and ask it to
// invent 6 titles). Tiers fill top-down — each tier only runs if the one
// above didn't fill the screen, and there's no padding to force a round
// number. AI is Tier 5 only: a labeled, visually distinct last resort, never
// blended with the real-data tiers above it. This protects the actual moat
// (real people whose taste matches yours) from quietly becoming AI guesses.

const RECS_TARGET = 6; // soft target per screen — tiers stop once hit, not a hard requirement

// Builds the same twin graph fetchRealTwins() builds, but returns the raw
// scored candidate list (not the UI-shaped twin cards) so both the Twins
// screen and the rec engine share one source of truth instead of two copies
// of the same matching math drifting apart over time.
function buildTwinGraph(myUserId, allTastes) {
  const rarityWeights = computeRarityWeights(allTastes);
  // Coerce both sides to string before comparing. Tier 2 (neighbor-of-
  // neighbor) calls this recursively with twin.id, which comes from an
  // object key (for...in) and is therefore a STRING, whereas tastes.user_id
  // arrives from Supabase as a number. A strict === between "7" and 7 is
  // false, so without this coercion `mine` came back empty on the recursive
  // call, weightedSims never populated, candidates was always [], and the
  // entire neighbor-of-neighbor tier silently produced zero recs. Top-level
  // callers pass a numeric id, which also works fine through String().
  const meKey = String(myUserId);
  const mine = allTastes.filter(t => String(t.user_id) === meKey);
  const byUser = {};
  allTastes.forEach(t => {
    if (String(t.user_id) === meKey) return;
    if (!byUser[t.user_id]) byUser[t.user_id] = [];
    byUser[t.user_id].push(t);
  });

  const candidates = [];
  for (const otherId in byUser) {
    const theirs = byUser[otherId];
    const weightedSims = [];
    mine.forEach(m => {
      const match = theirs.find(t => t.category === m.category && t.item_name.toLowerCase() === m.item_name.toLowerCase());
      if (match) {
        const sim = 1 - Math.abs(m.rating - match.rating) / 4;
        const weight = rarityWeights[matchKey(m.category, m.item_name)] || 1;
        weightedSims.push({ sim, weight });
      }
    });
    if (weightedSims.length === 0) continue;
    const totalWeight = weightedSims.reduce((a, b) => a + b.weight, 0);
    const overall = Math.round((weightedSims.reduce((a, b) => a + b.sim * b.weight, 0) / totalWeight) * 100);
    candidates.push({ id: otherId, overall, ratings: theirs });
  }
  candidates.sort((a, b) => b.overall - a.overall);
  return { mine, rarityWeights, candidates };
}

// Tier 1 — items the user's top twins rated 4-5 stars that the user hasn't
// rated. Ranked by twin match score + rarity weight + how many different
// twins loved it. Highest-trust tier: real people, direct match.
function buildTwinBackedRecs(myUserId, allTastes, limit = RECS_TARGET) {
  const { mine, rarityWeights, candidates } = buildTwinGraph(myUserId, allTastes);
  const mineKeys = new Set(mine.map(t => matchKey(t.category, t.item_name)));
  const topTwins = candidates.slice(0, 10); // consider top 10 twins, not just the top 5 shown on the Twins screen

  const itemMap = {};
  topTwins.forEach(twin => {
    twin.ratings.forEach(r => {
      if (r.rating < 4) return;
      const key = matchKey(r.category, r.item_name);
      if (mineKeys.has(key)) return;
      if (!itemMap[key]) itemMap[key] = { category: r.category, item_name: r.item_name, twinScores: [] };
      itemMap[key].twinScores.push({ twinScore: twin.overall, rarityWeight: rarityWeights[key] || 1 });
    });
  });

  const scored = Object.values(itemMap).map(entry => {
    const rarityWeight = entry.twinScores[0].rarityWeight;
    const twinCount = entry.twinScores.length;
    const avgTwinScore = entry.twinScores.reduce((a, b) => a + b.twinScore, 0) / twinCount;
    // Composite rank: avg twin match score, boosted by rarity and by how many
    // independent twins loved it (sqrt damping so one item loved by 6 twins
    // doesn't totally dominate over a rarer 2-twin pick).
    const rank = avgTwinScore * rarityWeight * Math.sqrt(twinCount);
    return { ...entry, twinCount, avgTwinScore: Math.round(avgTwinScore), rank, tier: 1 };
  });

  scored.sort((a, b) => b.rank - a.rank);
  return scored.slice(0, limit);
}

// Tier 2 — neighbor-of-neighbor. Walk one hop further: the user's twins' own
// top twins. Surfaces items second-degree connections loved that neither the
// user nor their direct twins have rated. Still zero AI.
function buildNeighborOfNeighborRecs(myUserId, allTastes, excludeKeys, limit = RECS_TARGET) {
  const { mine, rarityWeights, candidates } = buildTwinGraph(myUserId, allTastes);
  const mineKeys = new Set(mine.map(t => matchKey(t.category, t.item_name)));
  const directTwins = candidates.slice(0, 10);
  const directTwinIds = new Set(directTwins.map(t => t.id));
  const directTwinItemKeys = new Set();
  directTwins.forEach(t => t.ratings.forEach(r => directTwinItemKeys.add(matchKey(r.category, r.item_name))));

  const secondDegree = {}; // userId -> { score, ratings }, deduped across direct twins
  const meKey = String(myUserId);
  directTwins.forEach(twin => {
    const { candidates: theirTwins } = buildTwinGraph(twin.id, allTastes);
    theirTwins.slice(0, 5).forEach(t2 => {
      // String-coerce: t2.id is an object-key string, myUserId is numeric.
      if (String(t2.id) === meKey || directTwinIds.has(t2.id)) return;
      if (!secondDegree[t2.id]) secondDegree[t2.id] = { score: t2.overall, ratings: t2.ratings };
    });
  });

  const itemMap = {};
  Object.values(secondDegree).forEach(({ score, ratings }) => {
    ratings.forEach(r => {
      if (r.rating < 4) return;
      const key = matchKey(r.category, r.item_name);
      if (mineKeys.has(key) || directTwinItemKeys.has(key) || excludeKeys.has(key)) return;
      if (!itemMap[key]) itemMap[key] = { category: r.category, item_name: r.item_name, scores: [] };
      itemMap[key].scores.push(score);
    });
  });

  const scored = Object.values(itemMap).map(entry => {
    const count = entry.scores.length;
    const avgScore = entry.scores.reduce((a, b) => a + b, 0) / count;
    const rarityWeight = rarityWeights[matchKey(entry.category, entry.item_name)] || 1;
    const rank = avgScore * rarityWeight * Math.sqrt(count);
    return { ...entry, neighborCount: count, avgScore: Math.round(avgScore), rank, tier: 2 };
  });

  scored.sort((a, b) => b.rank - a.rank);
  return scored.slice(0, limit);
}

// Tier 3 — archetype/community trending. Items popular among users who share
// the current user's archetype. Requires users.archetype to be populated
// (written on every rating/import change — see saveArchetypeForUser below).
async function buildArchetypeTrendingRecs(myArchetype, myUserId, allTastes, excludeKeys, limit = RECS_TARGET) {
  if (!myArchetype) return [];
  const { data: sameArchetypeUsers, error } = await supabase
    .from('users').select('id').eq('archetype', myArchetype);
  if (error || !sameArchetypeUsers?.length) return [];

  const peerIds = new Set(sameArchetypeUsers.map(u => u.id).filter(id => id !== myUserId));
  if (peerIds.size === 0) return [];

  const mineKeys = new Set(allTastes.filter(t => t.user_id === myUserId).map(t => matchKey(t.category, t.item_name)));
  const itemMap = {};
  allTastes.forEach(t => {
    if (!peerIds.has(t.user_id) || t.rating < 4) return;
    const key = matchKey(t.category, t.item_name);
    if (mineKeys.has(key) || excludeKeys.has(key)) return;
    if (!itemMap[key]) itemMap[key] = { category: t.category, item_name: t.item_name, count: 0, ratingSum: 0 };
    itemMap[key].count++;
    itemMap[key].ratingSum += t.rating;
  });

  const scored = Object.values(itemMap).map(entry => ({ ...entry, avgRating: entry.ratingSum / entry.count, tier: 3 }));
  scored.sort((a, b) => (b.count * b.avgRating) - (a.count * a.avgRating));
  return scored.slice(0, limit);
}

// Tier 4 — global trending/hidden gems across the whole platform. The floor
// for "real human data, no AI." For a very early/small user base this may
// legitimately come back empty.
function buildGlobalTrendingRecs(myUserId, allTastes, excludeKeys, limit = RECS_TARGET) {
  const mineKeys = new Set(allTastes.filter(t => t.user_id === myUserId).map(t => matchKey(t.category, t.item_name)));
  const itemMap = {};
  allTastes.forEach(t => {
    if (t.user_id === myUserId || t.rating < 4) return;
    const key = matchKey(t.category, t.item_name);
    if (mineKeys.has(key) || excludeKeys.has(key)) return;
    if (!itemMap[key]) itemMap[key] = { category: t.category, item_name: t.item_name, count: 0, ratingSum: 0 };
    itemMap[key].count++;
    itemMap[key].ratingSum += t.rating;
  });
  const scored = Object.values(itemMap).map(entry => ({ ...entry, avgRating: entry.ratingSum / entry.count, tier: 4 }));
  scored.sort((a, b) => (b.count * b.avgRating) - (a.count * a.avgRating));
  return scored.slice(0, limit);
}

// Writes the user's current archetype to users.archetype. Call this right
// after a rating is saved and right after an import completes — the two
// places ratings change. Fire-and-forget; a failed write here shouldn't
// block the action the user is actually trying to do.
async function saveArchetypeForUser(uid, ratingsState) {
  try {
    const archetype = buildArchetype(uid, ratingsState);
    const label = `${archetype.category} ${archetype.behavior}`;
    await supabase.from('users').update({ archetype: label }).eq('id', uid);
  } catch (e) { /* non-critical — Tier 3 just has one less data point this round */ }
}

// ─── IMPORT HELPERS ───────────────────────────────────────────
// Letterboxd's export (ratings.csv or diary.csv) uses a 0.5–5.0 half-star
// scale in a "Rating" column. We round to the nearest whole star since
// Kindred only stores 1–5 integers.
function parseLetterboxdCSV(text) {
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  return parsed.data
    .filter(row => row.Name && row.Rating && parseFloat(row.Rating) > 0)
    .map(row => ({ title: row.Name.trim(), rating: Math.max(1, Math.min(5, Math.round(parseFloat(row.Rating)))) }));
}

// Goodreads' "My Rating" column is already 0–5 whole stars. 0 means unrated,
// so those rows are skipped.
function parseGoodreadsCSV(text) {
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  return parsed.data
    .filter(row => row['Title'] && row['My Rating'] && parseInt(row['My Rating'], 10) > 0)
    .map(row => ({ title: row['Title'].trim(), rating: Math.max(1, Math.min(5, parseInt(row['My Rating'], 10))) }));
}

// Steam has no ratings at all — only playtime. This is a rough, clearly-
// labeled estimate: more time invested generally means more enjoyed. Under
// 30 minutes returns 0, meaning "not enough signal, skip this one."
function playtimeToStars(minutes) {
  const hours = minutes / 60;
  if (hours < 0.5) return 0;
  if (hours < 2) return 2;
  if (hours < 8) return 3;
  if (hours < 25) return 4;
  return 5;
}

// ─── SHAREABLE IMAGE CARDS ─────────────────────────────────────
// Rendered off-screen at a fixed 1080x1080 (square — works cleanly on X,
// Instagram, Discord, etc.) then captured to a PNG via html2canvas and
// shared as a real image instead of plain text. Visually mirrors the on-
// screen Taste Passport / Twin cards but strips anything meaningless to a
// viewer who isn't the account owner (e.g. the freshness bar).

// Radar chart — ported from the Claude Design handoff's _initRadar, adapted
// from a fixed 9-axis vanilla-JS DOM builder into a React component that
// takes a real, variable-length axes array (1-3 axes here, not always 9).
// Single category-green value polygon — no mood/behavior groups, since
// there's only one real signal type (rarity-weight per domain) to plot.
function PassportRadar({ axes, size = 280 }) {
  if (!axes || axes.length === 0) return null;
  const W = size, H = size, cx = W / 2, cy = H / 2, R = size * 0.34;
  const n = axes.length;
  const ang = i => (-Math.PI / 2) + (i / n) * Math.PI * 2;
  const pt = (i, r) => [cx + Math.cos(ang(i)) * r, cy + Math.sin(ang(i)) * r];

  const rings = [0.25, 0.5, 0.75, 1].map((f, ri) => {
    const ptsStr = axes.map((_, i) => pt(i, R * f).join(',')).join(' ');
    return <polygon key={ri} points={ptsStr} fill="none" stroke={`rgba(255,255,255,${f === 1 ? 0.12 : 0.05})`} strokeWidth="1" />;
  });

  const spokesAndLabels = axes.map((a, i) => {
    const [x, y] = pt(i, R);
    const [lx, ly] = pt(i, R + 22);
    const cosA = Math.cos(ang(i));
    const anchor = Math.abs(cosA) < 0.3 ? 'middle' : (cosA > 0 ? 'start' : 'end');
    return (
      <g key={i}>
        <line x1={cx} y1={cy} x2={x} y2={y} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
        <text x={lx} y={ly} fill={G.green} opacity="0.85" fontFamily="'Space Mono',monospace" fontSize="9" letterSpacing="0.06em" textAnchor={anchor} dominantBaseline="middle">
          {a.label.toUpperCase()}
        </text>
      </g>
    );
  });

  const valPts = axes.map((a, i) => pt(i, R * a.value));
  const valPolyStr = valPts.map(p => p.join(',')).join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: '100%', overflow: 'visible' }}>
      {rings}
      {spokesAndLabels}
      <polygon points={valPolyStr} fill="rgba(108,93,211,0.18)" stroke="rgba(108,93,211,0.9)" strokeWidth="1.5" strokeLinejoin="round" />
      {valPts.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r="3.2" fill={G.green} stroke={G.bg} strokeWidth="1.5" />
      ))}
    </svg>
  );
}

// Constellation canvas background — ported from the design handoff's shared
// _makeSim/_draw logic (identical across every .dc.html file). Reusable
// behind any card/hero surface. color is an "r,g,b" string per the design
// tokens (purple 108,93,211 / pink 255,104,157 / cyan 0,212,255).
// One-time data-sharing consent modal. Shown exactly once, at first-twin-
// unlock (see answerConsentPrompt's call site). Equal visual weight on
// both buttons, no pre-selected default, no dark patterns — per the
// handoff's explicit instruction. Copy is the finalized text, no em dashes.
function ConsentModal({ onAnswer }) {
  return (
    <div style={{position:'fixed',inset:0,background:'rgba(8,8,12,0.78)',backdropFilter:'blur(4px)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000,padding:'1.5rem'}}>
      <div style={{maxWidth:420,width:'100%',background:G.deep,border:`1px solid ${G.border}`,borderRadius:20,padding:'1.75rem 1.5rem'}}>
        <h3 style={{fontFamily:"'Cormorant Garamond',serif",fontWeight:500,fontSize:'1.4rem',color:G.text,marginBottom:'0.85rem'}}>Help make Kindred smarter?</h3>
        <p style={{color:G.muted,fontSize:'0.88rem',lineHeight:1.65,marginBottom:'1.5rem'}}>
          When you opt in, your taste data (anonymized, never your name or identity) helps us improve recommendations and build better tools for taste discovery. You can turn this off anytime in Settings.
        </p>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0.75rem'}}>
          <button onClick={()=>onAnswer(false)} style={{background:G.card,border:`1px solid ${G.border}`,color:G.text,padding:'0.75rem',borderRadius:12,fontSize:'0.85rem',fontWeight:500,cursor:'pointer',fontFamily:'Inter,sans-serif'}}>
            No thanks
          </button>
          <button onClick={()=>onAnswer(true)} style={{background:G.card,border:`1px solid ${G.border}`,color:G.text,padding:'0.75rem',borderRadius:12,fontSize:'0.85rem',fontWeight:500,cursor:'pointer',fontFamily:'Inter,sans-serif'}}>
            Yes, help improve Kindred
          </button>
        </div>
      </div>
    </div>
  );
}

// Animates a number counting up from 0 to `value` on mount. Used for the
// twin match percentage so the reveal feels like an unlock rather than a
// number that was just always sitting there.
function CountUp({ value, duration = 900, suffix = '' }) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    let raf; const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      setDisplay(Math.round(eased * value));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <>{display}{suffix}</>;
}

// Line-art glyphs for empty/locked states, replacing emoji so these moments
// match the Cormorant/constellation aesthetic rather than relying on
// platform-inconsistent emoji rendering.
function LockGlyph({ size = 40, color = '#8B8FA6' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="11" width="14" height="10" rx="2"/>
      <path d="M8 11V7a4 4 0 0 1 8 0v4"/>
      <circle cx="12" cy="16" r="1.4" fill={color} stroke="none"/>
    </svg>
  );
}
function SearchGlyph({ size = 32, color = '#8B8FA6' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10.5" cy="10.5" r="6.5"/>
      <line x1="20" y1="20" x2="15.4" y2="15.4"/>
    </svg>
  );
}
function SproutGlyph({ size = 32, color = '#10B881' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 21V11"/>
      <path d="M12 11C12 7 9 5 5 5c0 4 2 7 7 7Z"/>
      <path d="M12 13c0-3.5 2.5-5.5 6-5.5 0 3.5-2 6-6 6Z"/>
    </svg>
  );
}

function ConstellationBg({ color = '108,93,211', opacity = 0.4, density = 6500, speed = 1, parallax = false }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf, resizeTimer;
    let w, h, pts;
    let targetOx = 0, targetOy = 0, ox = 0, oy = 0;

    const ctx = canvas.getContext('2d');

    // Re-measures the canvas's actual on-screen size and rebuilds the
    // point field to match. Called on mount AND on resize/orientation
    // change -- without this, rotating a phone/iPad or resizing a
    // desktop window leaves the canvas's internal pixel buffer stuck at
    // its original dimensions, stretching or cropping the constellation
    // relative to its CSS box.
    const setup = () => {
      const dpr = window.devicePixelRatio || 1;
      w = canvas.offsetWidth; h = canvas.offsetHeight;
      if (!w || !h) return;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      const n = Math.max(8, Math.round((w * h) / density));
      pts = [];
      for (let i = 0; i < n; i++) pts.push({ x: Math.random()*w, y: Math.random()*h, vx:(Math.random()-.5)*.12*speed, vy:(Math.random()-.5)*.12*speed, r: Math.random()*1.2+.4, tw: Math.random()*Math.PI*2 });
    };
    setup();

    const onMove = (e) => {
      if (!parallax) return;
      const rect = canvas.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / (rect.width || 1)) - 0.5;
      const ny = ((e.clientY - rect.top) / (rect.height || 1)) - 0.5;
      targetOx = -nx * 18; targetOy = -ny * 18; // px range of drift, kept subtle
    };
    if (parallax) window.addEventListener('mousemove', onMove);

    // Debounced so a rapid sequence of resize events (orientation change
    // on mobile/tablet fires several in quick succession) doesn't rebuild
    // the point field dozens of times in a row.
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(setup, 150);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    const draw = () => {
      if (w && h && pts) {
        ox += (targetOx - ox) * 0.04; oy += (targetOy - oy) * 0.04;
        ctx.clearRect(0, 0, w, h);
        ctx.save();
        ctx.translate(ox, oy);
        for (const p of pts) { p.x += p.vx; p.y += p.vy; p.tw += .02*speed; if (p.x<0||p.x>w) p.vx*=-1; if (p.y<0||p.y>h) p.vy*=-1; }
        for (let i = 0; i < pts.length; i++) for (let j = i+1; j < pts.length; j++) {
          const a = pts[i], b = pts[j]; const d = Math.hypot(a.x-b.x, a.y-b.y);
          if (d < 64) { ctx.strokeStyle = `rgba(${color},${.12*(1-d/64)})`; ctx.lineWidth = .6; ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke(); }
        }
        for (const p of pts) { const a = .35+.4*Math.sin(p.tw); ctx.fillStyle = `rgba(${color},${a})`; ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2); ctx.fill(); }
        ctx.restore();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      if (parallax) window.removeEventListener('mousemove', onMove);
    };
  }, [color, density, speed, parallax]);
  return <canvas ref={canvasRef} style={{ position:'absolute', inset:0, width:'100%', height:'100%', opacity }} />;
}

function PassportShareCard({ archetype, level, total }) {
  return (
    <div style={{
      width:1080, height:1080, background:`linear-gradient(135deg, ${G.bg}, ${G.deep})`,
      display:'flex', flexDirection:'column', justifyContent:'center', padding:'90px',
      fontFamily:"'Inter',system-ui,sans-serif", color:G.text, boxSizing:'border-box', position:'relative',
    }}>
      <div style={{position:'absolute', top:70, left:90, fontFamily:"'Cormorant Garamond',serif", fontSize:38, fontWeight:500, letterSpacing:'0.04em'}}>
        Kind<span style={{color:G.purple}}>r</span>ed
      </div>
      <div style={{position:'absolute', top:78, right:90, background:'rgba(108,93,211,0.18)', border:'1px solid rgba(108,93,211,0.35)', borderRadius:100, padding:'10px 28px', fontSize:22, color:'#9D92F0', fontFamily:'Space Mono,monospace'}}>{level}</div>
      <div style={{fontFamily:'Space Mono,monospace', fontSize:24, color:G.purple, textTransform:'uppercase', letterSpacing:'0.16em', marginBottom:28}}>Taste Passport</div>
      <div style={{fontFamily:"'Cormorant Garamond',serif", fontWeight:300, fontSize:74, lineHeight:1.18, marginBottom:48}}>
        <span style={{color:archetype.categoryColor}}>{archetype.category}</span>{' '}
        <span>{archetype.behavior}</span>
      </div>
      <div style={{fontSize:30, color:G.muted, marginBottom:64}}>{total} items rated across film, games, and books</div>
      <div style={{height:1, background:G.border, marginBottom:48}}/>
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between'}}>
        <div style={{fontSize:26, color:G.muted}}>Find your taste twin at</div>
        <div style={{fontSize:30, color:G.cyan, fontFamily:'Space Mono,monospace'}}>kindredmatch.co</div>
      </div>
    </div>
  );
}

function TwinShareCard({ twin }) {
  return (
    <div style={{
      width:1080, height:1080, background:`linear-gradient(135deg, ${G.bg}, ${G.deep})`,
      display:'flex', flexDirection:'column', justifyContent:'center', padding:'90px',
      fontFamily:"'Inter',system-ui,sans-serif", color:G.text, boxSizing:'border-box', position:'relative',
    }}>
      <div style={{position:'absolute', top:70, left:90, fontFamily:"'Cormorant Garamond',serif", fontSize:38, fontWeight:500, letterSpacing:'0.04em'}}>
        Kind<span style={{color:G.purple}}>r</span>ed
      </div>
      <div style={{fontFamily:'Space Mono,monospace', fontSize:24, color:G.purple, textTransform:'uppercase', letterSpacing:'0.16em', marginBottom:28}}>Taste Twin Match</div>
      <div style={{display:'flex', alignItems:'baseline', gap:24, marginBottom:40}}>
        <div style={{fontFamily:'Space Mono,monospace', fontSize:160, color:G.purple, fontWeight:700, lineHeight:1}}>{twin.overall}%</div>
        <div style={{fontSize:34, color:G.muted}}>match with {twin.handle}</div>
      </div>
      {twin.why && (
        <div style={{background:'rgba(108,93,211,0.08)', border:'1px solid rgba(108,93,211,0.2)', borderRadius:18, padding:'32px 36px', marginBottom:48, fontSize:28, color:'#9D92F0', lineHeight:1.5}}>
          💡 {twin.why}
        </div>
      )}
      {twin.shared?.length > 0 && (
        <div style={{marginBottom:48}}>
          <div style={{fontFamily:'Space Mono,monospace', fontSize:22, color:G.dim, textTransform:'uppercase', letterSpacing:'0.12em', marginBottom:20}}>You both loved</div>
          <div style={{display:'flex', flexWrap:'wrap', gap:14}}>
            {twin.shared.slice(0,4).map((s,i)=>(
              <span key={i} style={{background:G.purpleDim, border:'1px solid rgba(108,93,211,0.25)', color:'#9D92F0', padding:'12px 26px', borderRadius:100, fontSize:26}}>{s.title}</span>
            ))}
          </div>
        </div>
      )}
      <div style={{height:1, background:G.border, marginBottom:48}}/>
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between'}}>
        <div style={{fontSize:26, color:G.muted}}>Find your taste twin at</div>
        <div style={{fontSize:30, color:G.cyan, fontFamily:'Space Mono,monospace'}}>kindredmatch.co</div>
      </div>
    </div>
  );
}

// Mounts a React element into a detached, off-screen DOM node (positioned
// far outside the viewport rather than display:none, since html2canvas
// needs real layout to read), waits a tick for it to paint, captures it to a
// PNG, then unmounts and removes the node. Fully self-contained — doesn't
// rely on the calling component's own JSX tree, which matters here since
// the app's screens are a series of early `return`s per step rather than
// one shared wrapper any hidden node could live inside.
async function captureCardToBlob(element) {
  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.top = '-99999px';
  host.style.left = '-99999px';
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(element);
  // Give React + web fonts a moment to actually paint before snapshotting.
  await new Promise(resolve => setTimeout(resolve, 150));
  let blob = null;
  try {
    const canvas = await html2canvas(host.firstChild, { backgroundColor: null, scale: 1 });
    blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  } finally {
    root.unmount();
    document.body.removeChild(host);
  }
  return blob;
}

// Tries the native share sheet with a real image attachment (mobile — what
// actually fixes the "shared as plain text" problem), falling back to a
// plain download if native share is unavailable or the user cancels it.
async function shareOrDownloadBlob(blob, filename, shareTitle, shareText) {
  if (!blob) return false;
  const file = new File([blob], filename, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: shareTitle, text: shareText });
      return true;
    } catch (e) {
      // Cancelled or failed — fall through to download instead of nothing.
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return true;
}

function CompletionWidget({ ratings }) {
  const perDomain = {};
  DOMAINS.forEach(d => {
    const n = Object.values(ratings[d.key]).filter(Boolean).length;
    perDomain[d.key] = Math.min(100, Math.round((n / TARGET) * 100));
  });
  const overall = Math.round(Object.values(perDomain).reduce((a,b)=>a+b,0) / DOMAINS.length);
  return (
    <div style={{background:G.card,border:`1px solid ${G.border}`,borderRadius:14,padding:'1rem 1.25rem',marginBottom:'1.25rem'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'0.625rem'}}>
        <span style={{fontFamily:'Space Mono,monospace',fontSize:'0.6rem',color:G.dim,textTransform:'uppercase',letterSpacing:'0.1em'}}>Taste Completion</span>
        <span style={{fontFamily:'Space Mono,monospace',fontSize:'0.9rem',color:G.purple,fontWeight:700}}>{overall}%</span>
      </div>
      <div style={{display:'flex',gap:'0.5rem'}}>
        {DOMAINS.map(d => (
          <div key={d.key} style={{flex:1}}>
            <div style={{display:'flex',justifyContent:'space-between',fontSize:'0.65rem',color:G.muted,marginBottom:'0.3rem'}}>
              <span>{d.icon}</span>
              <span style={{fontFamily:'Space Mono,monospace',color:d.color}}>{perDomain[d.key]}%</span>
            </div>
            <div style={{height:3,background:'rgba(255,255,255,0.06)',borderRadius:2,overflow:'hidden'}}>
              <div style={{height:'100%',width:`${perDomain[d.key]}%`,background:d.color,borderRadius:2,transition:'width 0.6s ease'}}/>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function KindredApp() {
  const [step, setStep] = useState('welcome');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [userId, setUserId] = useState(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState(null);
  // Signup abuse protection: client-side cooldown to stop a user (or bot)
  // from spamming the "send sign-in link" button. Without this, nothing
  // stops repeated clicks from firing repeated signInWithOtp calls --
  // each one sends a real email, so this is both an abuse vector and a
  // real annoyance for whoever's inbox it is. This is a UX-layer
  // throttle only; the actual security backstop is Supabase Auth's own
  // server-side rate limiting (per-IP/per-email), which is a project
  // dashboard setting, not something this file can configure.
  const [authCooldown, setAuthCooldown] = useState(0);
  const [subscribeEmail, setSubscribeEmail] = useState(true);
  const [checkingSession, setCheckingSession] = useState(true);
  const [linkSent, setLinkSent] = useState(false);
  const [pendingAuthUser, setPendingAuthUser] = useState(null);

  const [ratings, setRatings] = useState({film:{},games:{},books:{}});
  // Separate from `ratings` (which stays title-keyed, exactly as every
  // other consumer in this file — passport radar, archetype, recs engine —
  // already expects). This map exists ONLY to fix the search-result star
  // display bug: two different real things can share a title (e.g.
  // "Foundation" the 2021 show vs the 1984 series), so title alone can't
  // tell search-result cards apart. Keyed by `${domain}:${sourceId}`,
  // populated whenever a rating is saved with a real source_id available.
  const [sourceIdRatings, setSourceIdRatings] = useState({});
  const [quizDomain, setQuizDomain] = useState('film');
  const [searchQuery, setSearchQuery] = useState({film:'',games:'',books:''});
  const [searchResults, setSearchResults] = useState({film:[],games:[],books:[]});
  const [searchLoading, setSearchLoading] = useState({film:false,games:false,books:false});

  // IMPORT
  const [importTab, setImportTab] = useState('letterboxd');
  const [importPreview, setImportPreview] = useState(null);
  const [importStatus, setImportStatus] = useState(null);
  const [steamInput, setSteamInput] = useState('');
  const [steamLoading, setSteamLoading] = useState(false);
  const [steamError, setSteamError] = useState(null);
  const [steamGames, setSteamGames] = useState(null);
  const [steamMode, setSteamMode] = useState('auto');
  const [steamManualRatings, setSteamManualRatings] = useState({});
  const [hoveredStar, setHoveredStar] = useState({});

  const [realTwins, setRealTwins] = useState(null);
  const [twinsLoading, setTwinsLoading] = useState(false);
  const [twinsError, setTwinsError] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  // Scoped to the Passport screen's radar — a small fetch of the same
  // platform-wide tastes table fetchRealTwins already queries, just used
  // here for the real rarity-by-domain radar instead of twin matching.
  const [radarTastes, setRadarTastes] = useState(null);
  // Discord account-linking state — a short code the user types into the
  // bot via /link, generated on demand and expiring after 10 minutes so a
  // stale code can't be reused later by mistake.
  const [linkCode, setLinkCode] = useState(null);
  const [linkCodeLoading, setLinkCodeLoading] = useState(false);
  const [discordLinked, setDiscordLinked] = useState(false);
  // Data-sharing consent state. consentPrompted gates whether the one-time
  // opt-in modal shows at all (per the handoff: ask once, never re-prompt
  // regardless of answer). dataSharingConsent is the actual current value,
  // shown/editable later in Settings.
  const [dataSharingConsent, setDataSharingConsent] = useState(false);
  // Opt-in email notifications (default off, mirrors the DB default). Set
  // from the user row on session load, toggled in Settings.
  const [emailNotifications, setEmailNotifications] = useState(false);
  const [consentPrompted, setConsentPrompted] = useState(true); // default true so it never flashes before real data loads
  const [showConsentModal, setShowConsentModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // "Your twin changed" notifications (V1: #1 Taste Neighbor rated
  // something new). showNotifInbox toggles the dropdown/panel open;
  // notifications holds the fetched list (null = not loaded yet, so the
  // bell can stay hidden until we actually know there's nothing to show).
  const [notifications, setNotifications] = useState(null);
  const [showNotifInbox, setShowNotifInbox] = useState(false);

  // Daily rating streak — shared identity with the Discord bot. Both
  // platforms read/write the SAME users.streak_count / last_streak_date
  // columns with the SAME date rules, so a user's streak is one consistent
  // number whether they rated on the web or in Discord that day. Null
  // until the session loads, so the Passport doesn't flash a 0 before real
  // data arrives.
  const [streakCount, setStreakCount] = useState(null);
  // How many people this user has successfully referred — shown in the
  // invite UI as social proof / progress. Loaded from the user row.
  const [referralCount, setReferralCount] = useState(0);

  const [recs, setRecs] = useState(null);
  const [aiFallbackRecs, setAiFallbackRecs] = useState([]);
  const [recError, setRecError] = useState(null);
  const [recLoading, setRecLoading] = useState(false);
  const [procStage, setProcStage] = useState(0);

  const debounceRef = useRef({});

  // ─── REAL AUTH — Supabase magic link ──────────────────────────
  // On mount: check for an existing session, and listen for changes (this is
  // what catches it the moment someone clicks the magic link in their email).
  // A session gives us a real auth UUID — we look up (or create) the matching
  // row in `users` by that UUID to get the int8 id everything else uses.
  useEffect(() => {
    let active = true;

    // Capture a referral param (?ref=<referrerUserId>) on first load and
    // stash it in sessionStorage. This has to survive the magic-link round
    // trip: the user lands here with ?ref=, but the account row isn't
    // created until AFTER they click the email link and come back — by
    // which point the original URL params are long gone. sessionStorage
    // bridges that gap (persists across the redirect within the same tab/
    // session, clears when the tab closes). Stored as a plain string; it's
    // validated server-side at credit time, so a junk value just fails to
    // credit rather than causing harm. We don't overwrite an existing
    // stashed ref, so the FIRST referral link someone arrives through wins.
    try {
      const params = new URLSearchParams(window.location.search);
      const ref = params.get('ref');
      if (ref && /^\d+$/.test(ref) && !sessionStorage.getItem('kindred_ref')) {
        sessionStorage.setItem('kindred_ref', ref);
      }
    } catch (e) { /* sessionStorage unavailable (rare) — referral just won't attribute */ }

    async function getUserRowByAuthId(authId) {
      const { data } = await supabase.from('users').select('*').eq('auth_id', authId).maybeSingle();
      return data;
    }

    async function handleSession(session) {
      if (!session) {
        if (active) { setCheckingSession(false); setStep('welcome'); }
        return;
      }
      const authUser = session.user;
      const row = await getUserRowByAuthId(authUser.id);
      if (!active) return;
      if (row) {
        setUserId(row.id);
        setEmail(row.email || authUser.email);
        setUsername(row.username || '');
        setDiscordLinked(!!row.discord_id);
        setDataSharingConsent(!!row.data_sharing_consent);
        setConsentPrompted(!!row.data_sharing_consent_prompted);
        setStreakCount(row.streak_count || 0);
        setEmailNotifications(!!row.email_notifications);
        setReferralCount(row.referral_count || 0);
        const { data: saved } = await supabase.from('tastes').select('category, item_name, rating, source_id').eq('user_id', row.id);
        if (saved && saved.length) {
          const loaded = { film:{}, games:{}, books:{} };
          const loadedBySourceId = {};
          saved.forEach(t => {
            if (loaded[t.category]) loaded[t.category][t.item_name] = t.rating;
            if (t.source_id) loadedBySourceId[`${t.category}:${t.source_id}`] = t.rating;
          });
          setRatings(loaded);
          setSourceIdRatings(loadedBySourceId);
        }
        touchLastActive(row.id);
        setStep('quiz');
      } else {
        // Verified, but no profile yet — this is a brand new account.
        setPendingAuthUser({ id: authUser.id, email: authUser.email });
        setEmail(authUser.email);
        setStep('welcome_setup');
      }
      setCheckingSession(false);
    }

    supabase.auth.getSession().then(({ data }) => handleSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => handleSession(session));
    return () => { active = false; listener.subscription.unsubscribe(); };
  }, []);

  // "Your twin changed" notifications — fetch once on login, then a light
  // poll every 2 minutes while signed in. No realtime subscription for V1
  // (would need a Supabase Realtime channel, more infra than this scope
  // needs); a 2-minute poll is cheap and plenty responsive for a feature
  // whose entire point is "something changed since you last looked".
  useEffect(() => {
    if (!userId) return;
    fetchNotifications();
    const iv = setInterval(fetchNotifications, 120000);
    return () => clearInterval(iv);
  }, [userId]);

  // SEARCH — debounced, fires 400ms after user stops typing
  useEffect(() => {
    const domain = quizDomain;
    const q = searchQuery[domain];
    if (debounceRef.current[domain]) clearTimeout(debounceRef.current[domain]);
    if (!q || q.trim().length < 2) {
      setSearchResults(prev => ({...prev, [domain]: []}));
      return;
    }
    debounceRef.current[domain] = setTimeout(() => doSearch(domain, q.trim()), 400);
  }, [searchQuery, quizDomain]);

  async function doSearch(domain, q) {
    setSearchLoading(prev => ({...prev, [domain]: true}));
    try {
      const endpoint = domain === 'film' ? `/api/search-film?q=${encodeURIComponent(q)}`
                     : domain === 'games' ? `/api/search-games?q=${encodeURIComponent(q)}`
                     : `/api/search-books?q=${encodeURIComponent(q)}`;
      const res = await fetch(endpoint);
      const data = await res.json();
      setSearchResults(prev => ({...prev, [domain]: data.results || []}));
    } catch (e) {
      setSearchResults(prev => ({...prev, [domain]: []}));
    }
    setSearchLoading(prev => ({...prev, [domain]: false}));
  }

  // ─── LIGHTWEIGHT ANALYTICS ───────────────────────────────────
  // Plain rows in an `events` table — no dashboard, just data you can query.
  // Takes an explicit uid (not the userId state) so it's safe to call in the
  // same tick a user is created, before state has caught up.
  async function logEvent(uid, eventType, detail) {
    if (!uid) return;
    try { await supabase.from('events').insert({ user_id: uid, event_type: eventType, detail: detail || null }); } catch (e) {}
  }
  async function logEventOnce(uid, eventType, detail) {
    if (!uid) return;
    try {
      const { data: existing } = await supabase.from('events').select('id')
        .eq('user_id', uid).eq('event_type', eventType).limit(1).maybeSingle();
      if (existing) return;
      await supabase.from('events').insert({ user_id: uid, event_type: eventType, detail: detail || null });
    } catch (e) {}
  }
  async function touchLastActive(uid) {
    try { await supabase.from('users').update({ last_active_at: new Date().toISOString() }).eq('id', uid); } catch (e) {}
  }

  // ─── DAILY STREAK (shared with the Discord bot) ──────────────
  // These three helpers are a byte-for-byte port of the bot's streak
  // logic (todayUTC / daysBetweenUTC / computeStreakAfterRating). They
  // MUST stay identical to the bot's versions — both platforms operate on
  // the same users.streak_count / last_streak_date columns, so if the date
  // rules diverged, a user rating on web vs Discord on the same day could
  // produce two different streak values for the same account. UTC date
  // strings, same as the bot, to sidestep timezone/DST drift.
  function streakTodayUTC() {
    return new Date().toISOString().slice(0, 10);
  }
  function streakDaysBetween(fromDateStr, toDateStr) {
    const a = new Date(`${fromDateStr}T00:00:00Z`).getTime();
    const b = new Date(`${toDateStr}T00:00:00Z`).getTime();
    return Math.round((b - a) / 86400000);
  }
  function computeStreakAfterRating(count, lastStreakDate, today) {
    if (!lastStreakDate) return 1;
    const gap = streakDaysBetween(lastStreakDate, today);
    if (gap <= 0) return count;       // already counted today
    if (gap === 1) return count + 1;  // consecutive
    if (gap === 2) return count + 1;  // one grace day — still continues
    return 1;                         // missed 2+ days — reset
  }
  // Advance the streak after a rating. Reads the current stored values
  // fresh (rather than trusting React state, which could be stale if the
  // user rated on Discord since this page loaded), applies the same rules
  // as the bot, writes only when something changed, and updates the local
  // streakCount so the Passport reflects it immediately. Fire-and-forget
  // from setRating's perspective — never blocks the rating itself.
  async function advanceStreak(uid) {
    try {
      const today = streakTodayUTC();
      const { data: row } = await supabase
        .from('users').select('streak_count, last_streak_date').eq('id', uid).maybeSingle();
      const current = row?.streak_count || 0;
      const lastDate = row?.last_streak_date || null;
      const next = computeStreakAfterRating(current, lastDate, today);
      if (next === current && lastDate === today) { setStreakCount(current); return; }
      await supabase.from('users').update({ streak_count: next, last_streak_date: today }).eq('id', uid);
      setStreakCount(next);
    } catch (e) { /* non-critical — streak just doesn't advance this round */ }
  }

  // "Your twin changed" V1 inbox. This is a plain SELECT of the user's own
  // notifications, no service-role endpoint needed here — reading your own
  // rows is exactly what the normal self-only RLS policy already allows.
  // Only the cross-user WRITE (in /api/notify-twins) needed the workaround.
  async function fetchNotifications() {
    if (!userId) return;
    try {
      const { data, error } = await supabase
        .from('notifications')
        .select('id, twin_user_id, category, item_name, rating, source_id, read, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      if (!data || data.length === 0) { setNotifications([]); return; }
      // Resolve twin_user_id -> username in one extra query rather than a
      // join, since the rest of this app already fetches users separately
      // (see fetchRealTwins' nameMap pattern) rather than relying on
      // Supabase relational embeds.
      const twinIds = [...new Set(data.map(n => n.twin_user_id))];
      const { data: twinRows } = await supabase.from('users').select('id, username').in('id', twinIds);
      const nameMap = {};
      twinRows?.forEach(u => { nameMap[u.id] = u.username; });
      setNotifications(data.map(n => ({ ...n, twinName: nameMap[n.twin_user_id] || 'Someone' })));
    } catch (e) {
      console.error('Failed to load notifications', e);
    }
  }

  async function markNotificationsRead(ids) {
    if (!ids.length) return;
    setNotifications(prev => prev ? prev.map(n => ids.includes(n.id) ? { ...n, read: true } : n) : prev);
    try { await supabase.from('notifications').update({ read: true }).in('id', ids); } catch (e) {}
  }

  // Ticks the cooldown down once a second while active. Cleans up its
  // interval on unmount/re-trigger so this never leaks timers across
  // re-renders or stacks multiple intervals if the effect re-fires.
  useEffect(() => {
    if (authCooldown <= 0) return;
    const t = setInterval(() => setAuthCooldown(c => (c <= 1 ? 0 : c - 1)), 1000);
    return () => clearInterval(t);
  }, [authCooldown > 0]);

  async function requestMagicLink() {
    setAuthError(null);
    if (authCooldown > 0) return; // belt-and-suspenders: button is also
    // disabled during cooldown (see the welcome screen JSX), but this
    // guards the function itself in case it's ever called another way
    // (e.g. the Enter-key handler) while disabled state hasn't caught up.
    if (!email || !email.includes('@')) { setAuthError('Enter a valid email.'); return; }
    setAuthLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) throw error;
      setLinkSent(true);
      setAuthCooldown(30); // 30s before another send is allowed to this
      // or any other email -- stops rapid repeat clicks from spamming
      // real magic-link emails to whatever address is typed in.
    } catch (e) {
      setAuthError('Could not send the link. Check your connection and try again.');
    }
    setAuthLoading(false);
  }

  async function completeNewAccountSetup() {
    setAuthError(null);
    setAuthLoading(true);
    try {
      // Pull the stashed referral (if any) captured at first load. Validated
      // again here as digits-only; anything else is ignored. We do NOT set
      // referred_by directly in this insert — instead we pass it to the
      // credit-referral endpoint, which sets it server-side under the
      // service role AND increments the referrer atomically with its own
      // anti-abuse checks (self-referral, referrer-exists, no double-credit).
      // Setting it here too would risk crediting without the guards.
      let stashedRef = null;
      try { stashedRef = sessionStorage.getItem('kindred_ref'); } catch (e) {}

      const { data: created, error } = await supabase.from('users').insert({
        auth_id: pendingAuthUser.id,
        email: pendingAuthUser.email,
        username: username || pendingAuthUser.email.split('@')[0],
        subscribe_weekly_email: subscribeEmail,
      }).select().single();
      if (error) throw error;
      logEvent(created.id, 'signup_completed');
      touchLastActive(created.id);

      // Credit the referrer (fire-and-forget). The endpoint self-guards
      // against self-referral and double-crediting, so even if this somehow
      // ran twice it's safe. Clear the stash either way so a later signup in
      // the same tab can't reuse a stale ref.
      if (stashedRef && /^\d+$/.test(stashedRef) && String(stashedRef) !== String(created.id)) {
        fetch('/api/credit-referral', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newUserId: created.id, referrerId: Number(stashedRef) }),
        }).catch(() => {});
        logEvent(created.id, 'referral_signup', stashedRef);
      }
      try { sessionStorage.removeItem('kindred_ref'); } catch (e) {}

      setUserId(created.id);
      setStep('quiz');
    } catch (e) {
      setAuthError('Could not finish setting up your account. Try again.');
    }
    setAuthLoading(false);
  }

  // Generates a short, human-typeable code and saves it to this user's row
  // with a 10-minute expiry. The Discord bot looks this up when the user
  // runs /link CODE, using its service-role key — RLS correctly wouldn't
  // let a web session write to a different account's row anyway, so the
  // actual merge has to happen bot-side. This function only ever writes to
  // the signed-in user's OWN row, which the existing users_update_own
  // policy already allows.
  // Handles the one-time opt-in modal's answer (yes or no — both call this,
  // just with a different value). Marks the prompt as answered so it never
  // shows again, regardless of which button was pressed.
  async function answerConsentPrompt(consent) {
    setShowConsentModal(false);
    setDataSharingConsent(consent);
    setConsentPrompted(true);
    try {
      await supabase.from('users').update({
        data_sharing_consent: consent,
        data_sharing_consent_prompted: true,
      }).eq('id', userId);
      if (consent) logEvent(userId, 'data_sharing_consent_given');
    } catch (e) { /* non-critical — worst case the prompt could resurface once */ }
  }

  // Settings toggle uses this instead — same column, different event type
  // (consent_changed, not consent_given) since the handoff wants the two
  // tracked separately: one for the initial decision, one for anyone who
  // later flips it either direction.
  async function toggleDataSharingConsent(consent) {
    setDataSharingConsent(consent);
    try {
      await supabase.from('users').update({ data_sharing_consent: consent }).eq('id', userId);
      logEvent(userId, 'data_sharing_consent_changed', consent ? 'on' : 'off');
    } catch (e) { setAuthError('Could not update that setting. Try again.'); }
  }

  // Opt-in email notifications toggle. Optimistic update, reverts the UI if
  // the write fails so the toggle never shows a state that didn't persist.
  async function toggleEmailNotifications(enabled) {
    setEmailNotifications(enabled);
    try {
      await supabase.from('users').update({ email_notifications: enabled }).eq('id', userId);
      logEvent(userId, 'email_notifications_changed', enabled ? 'on' : 'off');
    } catch (e) {
      setEmailNotifications(!enabled); // revert
      setAuthError('Could not update that setting. Try again.');
    }
  }

  async function generateLinkCode() {
    setLinkCodeLoading(true);
    try {
      const code = Math.random().toString(36).slice(2, 8).toUpperCase();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const { error } = await supabase.from('users')
        .update({ link_code: code, link_code_expires_at: expiresAt })
        .eq('id', userId);
      if (error) throw error;
      setLinkCode(code);
    } catch (e) {
      setAuthError('Could not generate a link code. Try again.');
    }
    setLinkCodeLoading(false);
  }

  // Account deletion. Confirmed via direct database check that NO foreign
  // key constraints exist between tastes/matches/events and users — so
  // there's no automatic cascade, and rows must be explicitly deleted in
  // this order (children first, users last) or they'd be left orphaned.
  // matches has both user_id_1 and user_id_2, so both sides need clearing.
  async function deleteAccount() {
    setDeleteLoading(true);
    try {
      await supabase.from('tastes').delete().eq('user_id', userId);
      await supabase.from('events').delete().eq('user_id', userId);
      await supabase.from('matches').delete().eq('user_id_1', userId);
      await supabase.from('matches').delete().eq('user_id_2', userId);
      await supabase.from('users').delete().eq('id', userId);
      await supabase.auth.signOut();
      setUserId(null);
      setRatings({ film:{}, games:{}, books:{} });
      setStep('welcome');
    } catch (e) {
      setAuthError('Could not delete your account. Try again or contact support.');
      setDeleteLoading(false);
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    setUserId(null);
    setRatings({ film:{}, games:{}, books:{} });
    setEmail('');
    setUsername('');
    setLinkSent(false);
    setStep('welcome');
  }

  // RATING — title is used as item_name key
  // sourceId is optional — only the search-results screen has one (from the
  // TMDB/RAWG/Open Library response). Manual entries, imports, and any
  // other caller can omit it and behave exactly as before. When present,
  // it's stored on the tastes row (new source_id column) and also tracked
  // in sourceIdRatings, which is what actually fixes the search-result
  // display bug — see that map's declaration for why a separate map was
  // needed rather than changing the main ratings object's key.
  async function setRating(domain, title, val, sourceId = null) {
    // FOUND while re-auditing after the two fixes above, same root cause:
    // this toggle check decided "is the user un-rating, or setting a new
    // value?" by comparing against the TITLE-keyed value, even when a
    // sourceId is available. That broke rating a second same-titled item:
    // if book A (title "X") was already rated 5*, clicking 5* on a
    // DIFFERENT book B that also happens to be titled "X" would see the
    // title slot already holding 5, conclude the user must be toggling OFF
    // an existing 5* rating, and silently turn the click into an unrate
    // (deleting nothing, since book B never had a row) instead of saving
    // book B's first rating at all. Fixed to check the correct per-item
    // value: sourceIdRatings for items that have a sourceId, the
    // title-keyed value only as a fallback for items that don't.
    const sk = sourceId ? `${domain}:${sourceId}` : null;
    const currentForThisItem = sk
      ? (sourceIdRatings[sk] !== undefined ? sourceIdRatings[sk] : 0)
      : (ratings[domain][title] || 0);
    const newVal = currentForThisItem === val ? undefined : val;
    const nextRatings = {...ratings, [domain]: {...ratings[domain], [title]: newVal}};
    setRatings(nextRatings);
    if (sourceId) {
      setSourceIdRatings(prev => ({ ...prev, [sk]: newVal }));
    }
    if (!userId) return;
    if (newVal !== undefined) touchLastActive(userId);
    try {
      if (newVal === undefined) {
        // Unrate: when this came from a search result with a real sourceId,
        // delete that exact row by id rather than by title, for the same
        // reason as the lookup below — deleting by title alone could hit
        // the wrong one of two same-titled different things.
        if (sourceId) {
          await supabase.from('tastes').delete()
            .eq('user_id', userId).eq('category', domain).eq('source_id', sourceId);
        } else {
          await supabase.from('tastes').delete()
            .eq('user_id', userId).eq('category', domain).eq('item_name', title);
        }
        return;
      }
      // Look up the existing row by source_id when one is available.
      //
      // FIXED after live testing surfaced a real data-corruption bug here:
      // the earlier version of this lookup fell through to a title-only
      // match whenever no row existed with the given source_id — but "no
      // row with this source_id yet" is the NORMAL state for a brand-new
      // item, not a sign that the title-only fallback is safe to use. That
      // fallback could (and did) match a DIFFERENT existing row that just
      // happened to share the exact title text (e.g. two different real
      // "The Hunger Games" books), and then overwrite THAT row's
      // rating/source_id with the new item's data — silently corrupting an
      // unrelated rating, not just displaying it wrong.
      //
      // The fix: once a sourceId is provided, ONLY ever match on that exact
      // source_id. No match -> this is genuinely new -> insert. The
      // title-only fallback now applies ONLY when no sourceId was provided
      // at all (manual entries, imports, or a catalog source that doesn't
      // expose a stable id) — the same narrow, unavoidable case as the
      // search-display fix.
      let existing = null;
      if (sourceId) {
        const { data } = await supabase
          .from('tastes').select('id')
          .eq('user_id', userId).eq('category', domain).eq('source_id', sourceId).maybeSingle();
        existing = data;
      } else {
        const { data } = await supabase
          .from('tastes').select('id')
          .eq('user_id', userId).eq('category', domain).eq('item_name', title).maybeSingle();
        existing = data;
      }
      if (existing) {
        await supabase.from('tastes').update({ rating: newVal, source_id: sourceId, item_name: title }).eq('id', existing.id);
      } else {
        await supabase.from('tastes').insert({ user_id: userId, category: domain, item_name: title, rating: newVal, source_id: sourceId });
      }
      // Keep the archetype on file fresh so Tier 3 (archetype trending) has
      // accurate data for this user going forward. Fire-and-forget.
      saveArchetypeForUser(userId, nextRatings);
      // Advance the daily streak (any rating counts, same as the bot).
      // Fire-and-forget — a streak write failing must never affect the
      // rating the user just made.
      advanceStreak(userId);
      // "Your twin changed" V1 — only trigger: am I anyone's #1 Taste
      // Neighbor, and did I just rate something 4-5★ that they haven't
      // rated yet? Routed through a serverless endpoint (not a direct
      // Supabase call) because this writes a notification row into SOMEONE
      // ELSE's account, which a self-only RLS policy correctly won't allow
      // from this browser session. Fire-and-forget: a failed notification
      // check should never block the rating the user is actually trying to
      // save. Scoped to live ratings only (search/manual rate) — bulk
      // import deliberately does NOT call this, to avoid one big import
      // firing a flood of notifications at someone's twins all at once.
      if (newVal >= 4) {
        fetch('/api/notify-twins', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ raterId: userId, category: domain, itemName: title, rating: newVal, sourceId }),
        }).catch(() => {});
      }
    } catch (e) { console.error('Save failed', e); }
  }

  const rated = (d) => Object.values(ratings[d]).filter(Boolean).length;
  const totalRated = () => DOMAINS.reduce((sum, d) => sum + rated(d.key), 0);

  // BULK IMPORT — shared by Letterboxd, Goodreads, and Steam.
  // Skips anything already rated locally so a second import never clobbers
  // ratings made by hand or via search.
  async function importRows(category, items) {
    setImportStatus({ loading: true });
    try {
      const existingTitles = new Set(Object.keys(ratings[category]).map(t => t.toLowerCase()));
      // Real exports can legitimately contain the same title more than once
      // (a re-watch logged twice in Letterboxd, a duplicate diary entry,
      // etc.). The filter below only checked against titles already saved
      // to the DB/state — it never protected against two rows in THIS SAME
      // file sharing a title, so both passed through and both got inserted
      // as separate tastes rows. Dedupe within the batch first, keeping the
      // last occurrence (most exports list entries newest-first, so "last"
      // in file order is usually the earliest watch/read, but either way
      // this guarantees exactly one row per title rather than a random
      // count depending on how many times it appeared).
      const seenInBatch = new Map();
      items.forEach(i => {
        if (i.title && i.rating >= 1) seenInBatch.set(i.title.toLowerCase(), i);
      });
      const fresh = [...seenInBatch.values()].filter(i => !existingTitles.has(i.title.toLowerCase()));
      const rows = fresh.map(i => ({ user_id: userId, category, item_name: i.title, rating: i.rating }));
      const chunkSize = 300;
      for (let idx = 0; idx < rows.length; idx += chunkSize) {
        const chunk = rows.slice(idx, idx + chunkSize);
        if (chunk.length) {
          const { error } = await supabase.from('tastes').insert(chunk);
          if (error) throw error;
        }
      }
      const nextRatings = { ...ratings, [category]: { ...ratings[category] } };
      fresh.forEach(i => { nextRatings[category][i.title] = i.rating; });
      setRatings(nextRatings);
      const sourceLabel = category === 'film' ? 'letterboxd' : category === 'books' ? 'goodreads' : 'steam';
      logEvent(userId, 'import_completed', `${sourceLabel}:${fresh.length}`);
      saveArchetypeForUser(userId, nextRatings); // keep archetype fresh after a bulk import too
      setImportStatus({ loading: false, done: true, imported: fresh.length, skipped: items.length - fresh.length });
    } catch (e) {
      setImportStatus({ loading: false, error: 'Import failed. Check your connection and try again.' });
    }
  }

  function handleFileUpload(e, source) {
    const file = e.target.files[0];
    if (!file) return;
    setImportStatus(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result;
      const items = source === 'letterboxd' ? parseLetterboxdCSV(text) : parseGoodreadsCSV(text);
      const category = source === 'letterboxd' ? 'film' : 'books';
      setImportPreview({ source, category, items });
    };
    reader.readAsText(file);
  }

  async function fetchSteamLibrary() {
    setSteamLoading(true); setSteamError(null); setSteamGames(null);
    try {
      const res = await fetch(`/api/steam-library?steamid=${encodeURIComponent(steamInput.trim())}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load your Steam library.');
      setSteamGames(data.games);
    } catch (e) {
      setSteamError(e.message || 'Could not load your Steam library. Make sure your profile and game list are set to public.');
    }
    setSteamLoading(false);
  }

  // REAL TWIN MATCHING
  async function fetchRealTwins() {
    setTwinsLoading(true); setTwinsError(null);
    try {
      const { data: all, error } = await supabase.from('tastes').select('user_id, category, item_name, rating');
      if (error) throw error;
      const mine = all.filter(t => t.user_id === userId);
      const rarityWeights = computeRarityWeights(all);
      const byUser = {};
      all.forEach(t => {
        if (t.user_id === userId) return;
        if (!byUser[t.user_id]) byUser[t.user_id] = [];
        byUser[t.user_id].push(t);
      });
      const candidates = [];
      for (const otherId in byUser) {
        const theirs = byUser[otherId];
        const weightedSims = []; // {sim, weight, category}
        mine.forEach(m => {
          const match = theirs.find(t => t.category === m.category && t.item_name.toLowerCase() === m.item_name.toLowerCase());
          if (match) {
            const sim = 1 - Math.abs(m.rating - match.rating) / 4;
            const weight = rarityWeights[matchKey(m.category, m.item_name)] || 1;
            weightedSims.push({ sim, weight, category: m.category });
          }
        });
        if (weightedSims.length === 0) continue;
        const totalWeight = weightedSims.reduce((a,b)=>a+b.weight,0);
        const overall = Math.round((weightedSims.reduce((a,b)=>a+b.sim*b.weight,0)/totalWeight)*100);
        const domains = {};
        ['film','games','books'].forEach(d => {
          const arr = weightedSims.filter(w=>w.category===d);
          if (!arr.length) { domains[d] = null; return; }
          const tw = arr.reduce((a,b)=>a+b.weight,0);
          domains[d] = Math.round((arr.reduce((a,b)=>a+b.sim*b.weight,0)/tw)*100);
        });
        // Same matchKey helper used everywhere else in the recs/twin-matching
        // system, so "I both rated this" can't disagree with "the rarity/
        // similarity math both rated this" over a casing difference.
        const mineMap = {}; mine.forEach(t => { mineMap[matchKey(t.category, t.item_name)] = t.rating; });
        const theirMap = {}; theirs.forEach(t => { theirMap[matchKey(t.category, t.item_name)] = t.rating; });
        const shared = mine.filter(t => theirMap[matchKey(t.category, t.item_name)] !== undefined && t.rating >= 4 && theirMap[matchKey(t.category, t.item_name)] >= 4)
          .map(t => {
            const key = matchKey(t.category, t.item_name);
            return { title: t.item_name, mine: t.rating, theirs: theirMap[key], weight: rarityWeights[key] || 1 };
          })
          .sort((a,b)=>b.weight-a.weight).slice(0,4);
        const onlyMine = mine.filter(t => !theirMap[matchKey(t.category, t.item_name)] && t.rating >= 4).slice(0,3);
        const onlyTheirs = theirs.filter(t => !mineMap[matchKey(t.category, t.item_name)] && t.rating >= 4).slice(0,3);
        const candidate = { id: otherId, overall, domains, overlap: weightedSims.length, shared, onlyMine, onlyTheirs };
        candidate.why = buildWhyText(candidate);
        candidates.push(candidate);
      }
      candidates.sort((a,b)=>b.overall-a.overall);
      const top = candidates.slice(0,5);
      if (top.length) {
        const { data: userRows } = await supabase.from('users').select('id, username').in('id', top.map(c=>c.id));
        const nameMap = {};
        userRows?.forEach(u => { nameMap[u.id] = u.username; });
        top.forEach(c => { c.handle = nameMap[c.id] ? `@${nameMap[c.id]}` : `@user`; });
      }
      setRealTwins(top);
      if (top.length > 0) {
        logEventOnce(userId, 'first_match_unlocked', `${top[0].overall}%`);
        // Per the handoff: ask once, exactly at this moment (first twin
        // unlock, not signup, not the home screen) — when trust is
        // highest because the product just worked. consentPrompted being
        // false means this account has genuinely never seen the prompt.
        if (!consentPrompted) setShowConsentModal(true);
      }
    } catch (e) {
      setTwinsError('Could not load taste twins. Check your connection and try again.');
    }
    setTwinsLoading(false);
  }

  useEffect(() => {
    if (step === 'twins' && realTwins === null && !twinsLoading && totalRated() >= TWIN_UNLOCK_THRESHOLD) fetchRealTwins();
  }, [step]);

  // Fetches the platform-wide tastes table for the Passport screen's real
  // rarity-by-domain radar (same data fetchRealTwins uses, just a separate
  // small fetch scoped to this screen rather than a shared global cache).
  useEffect(() => {
    if (step !== 'profile' || radarTastes !== null) return;
    supabase.from('tastes').select('user_id, category, item_name, rating')
      .then(({ data, error }) => { if (!error && data) setRadarTastes(data); });
  }, [step]);

  // INVITE — shares a personal referral link. This is the growth loop:
  // the link carries ?ref=<this user's id>, so when someone signs up
  // through it, credit-referral attributes it back here. Uses the native
  // share sheet on mobile (the high-conversion path) and falls back to
  // copying the link on desktop/unsupported browsers. Fired at the
  // highest-intent moment — when a user has no twins yet and the app has
  // just told them more people rating is the fix.
  async function inviteFriend() {
    if (!userId) return;
    logEvent(userId, 'invite_shared');
    const url = `https://kindredmatch.co/?ref=${userId}`;
    const text = `I'm on Kindred finding my taste twin — someone whose taste in movies, shows, books and games matches mine so closely their favorites become my next favorites. Join me: ${url}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Join me on Kindred', text, url });
        setCopiedId('invite');
        setTimeout(() => setCopiedId(null), 2500);
        return;
      }
    } catch (e) {
      // User cancelled the share sheet — not an error, just stop here.
      if (e && e.name === 'AbortError') return;
    }
    // Fallback: copy the link to clipboard.
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId('invite');
      setTimeout(() => setCopiedId(null), 2500);
    } catch (e) {
      setAuthError('Could not open the share sheet. Your invite link is: ' + url);
    }
  }

  async function sharePassport(level, archetype, total) {
    const archetypeLabel = `${archetype.category} ${archetype.behavior}`;
    logEvent(userId, 'taste_passport_shared', archetypeLabel);
    try {
      const blob = await captureCardToBlob(<PassportShareCard archetype={archetype} level={level} total={total} />);
      const ok = await shareOrDownloadBlob(
        blob, 'kindred-taste-passport.png', 'My Kindred Taste Passport',
        `${archetypeLabel}. Find your own taste twin at kindredmatch.co`,
      );
      if (ok) { setCopiedId('passport'); setTimeout(() => setCopiedId(null), 2500); }
    } catch (e) { console.error('Share failed', e); }
  }

  // SHARE
  async function shareTwin(twin) {
    logEvent(userId, 'twin_card_shared', `${twin.overall}%`);
    try {
      const blob = await captureCardToBlob(<TwinShareCard twin={twin} />);
      const ok = await shareOrDownloadBlob(
        blob, 'kindred-taste-twin.png', 'My Kindred Taste Twin Match',
        `${twin.overall}% match with ${twin.handle}. Find your own taste twin at kindredmatch.co`,
      );
      if (ok) { setCopiedId(twin.id); setTimeout(() => setCopiedId(null), 2500); }
    } catch (e) { console.error('Share failed', e); }
  }

  // PROCESSING ANIMATION
  useEffect(() => {
    if (step !== 'processing') return;
    const stages = ['Analyzing taste fingerprint...','Mapping cross-domain patterns...','Building your profile...','Almost there...'];
    let i = 0; setProcStage(0);
    const iv = setInterval(() => {
      i++;
      if (i < stages.length) setProcStage(i);
      else { clearInterval(iv); setTimeout(() => setStep('profile'), 600); }
    }, 900);
    return () => clearInterval(iv);
  }, [step]);

  // AI RECS
  useEffect(() => {
    if (step === 'recs' && !recs && !recLoading) generateRecs();
  }, [step]);

  async function generateRecs() {
    setRecLoading(true); setRecError(null);
    try {
      const { data: allTastes, error } = await supabase
        .from('tastes').select('user_id, category, item_name, rating');
      if (error) throw error;

      const { data: myUserRow } = await supabase.from('users').select('archetype').eq('id', userId).single();
      const myArchetype = myUserRow?.archetype || null;

      const excludeKeys = new Set();
      const addToExclude = (items) => items.forEach(i => excludeKeys.add(matchKey(i.category, i.item_name)));
      let combined = [];

      // Tier 1 — twin-backed
      const tier1 = buildTwinBackedRecs(userId, allTastes, RECS_TARGET);
      addToExclude(tier1);
      combined = combined.concat(tier1);

      // Tier 2 — neighbor-of-neighbor (only if Tier 1 didn't fill the screen)
      if (combined.length < RECS_TARGET) {
        const tier2 = buildNeighborOfNeighborRecs(userId, allTastes, excludeKeys, RECS_TARGET - combined.length);
        addToExclude(tier2);
        combined = combined.concat(tier2);
      }

      // Tier 3 — archetype trending
      if (combined.length < RECS_TARGET) {
        const tier3 = await buildArchetypeTrendingRecs(myArchetype, userId, allTastes, excludeKeys, RECS_TARGET - combined.length);
        addToExclude(tier3);
        combined = combined.concat(tier3);
      }

      // Tier 4 — global trending
      if (combined.length < RECS_TARGET) {
        const tier4 = buildGlobalTrendingRecs(userId, allTastes, excludeKeys, RECS_TARGET - combined.length);
        addToExclude(tier4);
        combined = combined.concat(tier4);
      }

      // Tier 5 — AI last resort, ONLY if tiers 1-4 produced nothing at all.
      // Rendered in its own clearly-labeled bucket — never merged into the
      // same list as the human-data tiers above, never worded similarly.
      let aiPicks = [];
      if (combined.length === 0) {
        aiPicks = await generateAIFallbackPicks();
      }

      const finalRecs = await Promise.all(combined.map(async (item) => {
        const type = item.category === 'film' ? 'film' : item.category === 'games' ? 'game' : 'book';
        let reason, matchScore, tierLabel;
        if (item.tier === 1) {
          reason = item.twinCount > 1
            ? `${item.twinCount} of your Taste Neighbors rated this 4-5★`
            : `Your top taste twin rated this a strong match for you`;
          matchScore = item.avgTwinScore;
          tierLabel = 'Twin-Backed';
        } else if (item.tier === 2) {
          reason = `${item.neighborCount} people in your extended taste network loved this`;
          matchScore = item.avgScore;
          tierLabel = 'Taste Network';
        } else if (item.tier === 3) {
          reason = `Popular among people who share your taste archetype (${item.count} loved it)`;
          matchScore = Math.round(item.avgRating * 20); // 1-5 stars -> 20-100 scale, rough but consistent
          tierLabel = 'Trending In Your Archetype';
        } else {
          reason = `Trending across all of Kindred. ${item.count} people rated it ${item.avgRating.toFixed(1)}★ on average`;
          matchScore = Math.round(item.avgRating * 20);
          tierLabel = 'Kindred Trending';
        }
        // Best-effort poster lookup — same images shown on the rating screen.
        // A miss just means the card falls back to its emoji icon.
        const poster = await lookupPosterImage(type, item.item_name);
        return { title: item.item_name, type, reason, matchScore, tier: item.tier, tierLabel, poster };
      }));

      setRecs(finalRecs);
      setAiFallbackRecs(aiPicks);
    } catch (e) {
      setRecError('Could not load recommendations. Check your connection and try again.');
    }
    setRecLoading(false);
  }

  // Tier 5 only. Surfaced in the UI as "Beyond Your Taste Network" —
  // deliberately NOT worded like the twin-backed tiers, so it never reads as
  // equally trusted. Only called when a user has zero real-data matches
  // anywhere in the graph (very early days, or a very sparse catalog overlap).
  async function generateAIFallbackPicks() {
    try {
      const fmt = (d) => Object.entries(ratings[d]).filter(([,v])=>v).map(([k,v])=>`${k}:${v}/5`).join(', ');
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6", max_tokens: 1000,
          messages: [{ role: "user", content: `You are Kindred. This user has no taste-twin matches yet (too new, or too little catalog overlap with other users), so generate exactly 4 fallback picks based on general knowledge of their own ratings only. These are explicitly lower-trust than human-matched picks — keep that framing in mind.

Film & TV ratings: ${fmt('film') || 'none rated'}
Game ratings: ${fmt('games') || 'none rated'}
Book ratings: ${fmt('books') || 'none rated'}

Return ONLY a JSON object, no markdown, no backticks:
{"recommendations":[{"title":"string","type":"film|show|game|book","reason":"one sentence why"}]}` }]
        })
      });
      const data = await res.json();
      const tb = data.content?.find(c => c.type === 'text');
      if (!tb) return [];
      const parsed = JSON.parse(tb.text.replace(/```json|```/g,'').trim());
      const picks = parsed.recommendations || [];
      // Best-effort poster lookup, same as the real-data tiers above.
      // 'show' uses the film/TV endpoint since search-film covers both.
      return Promise.all(picks.map(async (r) => {
        const lookupType = r.type === 'show' ? 'film' : r.type;
        const poster = await lookupPosterImage(lookupType, r.title);
        return { ...r, tier: 5, tierLabel: 'Beyond Your Taste Network', poster };
      }));
    } catch (e) {
      return [];
    }
  }

  // STYLES
  const s = {
    app:{minHeight:'100%',background:G.bg,color:G.text,fontFamily:"'Inter',system-ui,sans-serif"},
    center:{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',minHeight:'100%',padding:'2rem',textAlign:'center'},
    card:{background:G.card,border:`1px solid ${G.border}`,borderRadius:18,padding:'1.5rem'},
    h1:{fontFamily:"'Cormorant Garamond',Georgia,serif",fontSize:'clamp(2.5rem,6vw,4.5rem)',fontWeight:300,lineHeight:1.08,marginBottom:'1rem'},
    h2:{fontFamily:"'Cormorant Garamond',Georgia,serif",fontSize:'clamp(1.75rem,4vw,2.75rem)',fontWeight:300,lineHeight:1.15,marginBottom:'0.875rem'},
    btn:{background:G.purple,color:'white',border:'none',padding:'0.9rem 2rem',borderRadius:12,fontSize:'0.95rem',fontWeight:600,cursor:'pointer',fontFamily:'inherit',width:'100%'},
    outBtn:{background:'transparent',color:G.muted,border:`1px solid ${G.border}`,padding:'0.9rem 2rem',borderRadius:12,fontSize:'0.95rem',cursor:'pointer',fontFamily:'inherit',width:'100%'},
    input:{background:'rgba(255,255,255,0.05)',border:`1px solid ${G.border}`,color:G.text,padding:'0.8rem 1.1rem',borderRadius:10,fontSize:'0.9rem',fontFamily:'inherit',outline:'none',width:'100%',marginBottom:'0.75rem'},
    eyebrow:{fontFamily:'Space Mono,monospace',fontSize:'0.65rem',letterSpacing:'0.12em',textTransform:'uppercase',marginBottom:'0.875rem'},
  };

  const css = `
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
    @keyframes slideIn{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
    @keyframes logoPulse{0%,100%{opacity:1}50%{opacity:0.55}}
    @keyframes btnGlow{0%,100%{box-shadow:0 0 0 0 rgba(108,93,211,0)}50%{box-shadow:0 0 18px 2px rgba(108,93,211,0.45)}}
    @keyframes gradientSweep{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
    @keyframes wordmarkFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
    @keyframes ringPulse{0%{box-shadow:0 0 0 0 rgba(108,93,211,0.35)}100%{box-shadow:0 0 0 8px rgba(108,93,211,0)}}
    .k-btn:hover{background:#5d4fc0!important;transform:translateY(-1px)}
    .k-out:hover{border-color:rgba(255,255,255,0.2)!important;color:#F1F5F9!important}
    .k-tab:hover{border-color:rgba(255,255,255,0.15)!important}
    .k-result:hover{border-color:rgba(255,255,255,0.15)!important;background:rgba(255,255,255,0.06)!important}
    .k-star:hover{transform:scale(1.2)!important}
    .k-star:active{transform:scale(1.35)!important;transition:transform 0.08s!important}
    .k-twin:hover{border-color:rgba(108,93,211,0.3)!important;transform:translateY(-2px)}
    .k-rec:hover{border-color:rgba(108,93,211,0.25)!important}
    .slide-in{animation:slideIn 0.4s ease forwards}
    .fade-up{animation:fadeUp 0.4s ease forwards}
    .fade-up-delay-1{opacity:0;animation:fadeUp 0.5s ease forwards;animation-delay:0.1s}
    .fade-up-delay-2{opacity:0;animation:fadeUp 0.5s ease forwards;animation-delay:0.22s}
    .fade-up-delay-3{opacity:0;animation:fadeUp 0.5s ease forwards;animation-delay:0.34s}
    .k-logo-r{display:inline-block;animation:logoPulse 3.4s ease-in-out infinite}
    .k-btn-glow:hover{animation:btnGlow 1.8s ease-in-out infinite}
    .k-input:focus{border-color:#6C5DD3!important;outline:none}
    .k-search:focus{border-color:#6C5DD3!important;outline:none}
    .k-hero-gradient{background:linear-gradient(90deg,${G.purple},${G.pink},${G.purpleLight},${G.purple});background-size:300% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;animation:gradientSweep 6s ease-in-out infinite;font-style:italic}
    .k-wordmark{display:inline-block;animation:wordmarkFloat 5s ease-in-out infinite}
    .k-word-reveal{display:inline-block;opacity:0;animation:fadeUp 0.55s ease forwards}
    .k-input-glow:focus{animation:ringPulse 1.4s ease-out 1}
    @keyframes twinReveal{from{opacity:0;transform:translateY(18px) scale(0.97)}to{opacity:1;transform:translateY(0) scale(1)}}
    @keyframes posterFadeIn{from{opacity:0}to{opacity:1}}
    @keyframes barShimmer{0%{background-position:-120px 0}100%{background-position:120px 0}}
    .k-twin-reveal{opacity:0;animation:twinReveal 0.55s cubic-bezier(.2,.8,.2,1) forwards}
    .k-poster{animation:posterFadeIn 0.35s ease forwards}
    .k-progress-shimmer{background-image:linear-gradient(90deg,rgba(255,255,255,0) 0%,rgba(255,255,255,0.35) 50%,rgba(255,255,255,0) 100%);background-size:120px 100%;animation:barShimmer 1.6s linear infinite}
  `;

  // ─── WELCOME ───────────────────────────────────────────────
  // ─── CHECKING SESSION ─────────────────────────────────────────
  if (checkingSession) return (
    <div style={s.app}>
      <style>{FONTS+css}</style>
      <div style={s.center}>
        <div style={{width:40,height:40,border:`2px solid ${G.border}`,borderTop:`2px solid ${G.purple}`,borderRadius:'50%',animation:'spin 1s linear infinite'}}/>
      </div>
    </div>
  );

  // ─── WELCOME / SIGN IN ─────────────────────────────────────────
  if (step === 'welcome') return (
    <div style={{...s.app,position:'relative',overflow:'hidden'}}>
      <style>{FONTS+css}</style>
      <ConstellationBg color="108,93,211" opacity={0.5} density={3200} speed={1.6} parallax />
      <div style={{
        position:'absolute', top:'18%', left:'50%', transform:'translateX(-50%)',
        width:'min(560px, 90vw)', height:'min(560px, 90vw)', borderRadius:'50%', pointerEvents:'none',
        background:`radial-gradient(circle, rgba(108,93,211,0.16) 0%, rgba(255,104,157,0.06) 45%, transparent 72%)`,
        filter:'blur(2px)',
      }}/>
      <div style={{...s.center,position:'relative'}}>
        <div className="fade-up" style={{fontFamily:"'Cormorant Garamond',serif",fontSize:'2rem',fontWeight:500,marginBottom:'2.5rem',letterSpacing:'0.06em'}}>
          <span className="k-wordmark">Kind<span className="k-logo-r" style={{color:G.purple}}>r</span>ed</span>
        </div>
        <h1 className="fade-up-delay-1" style={s.h1}>
          <span className="k-word-reveal" style={{animationDelay:'0.1s'}}>Find</span>{' '}
          <span className="k-word-reveal" style={{animationDelay:'0.2s'}}>your</span>
          <br/>
          <em className="k-hero-gradient" style={{fontStyle:'italic'}}>taste twin.</em>
        </h1>
        <p className="fade-up-delay-2" style={{color:G.muted,lineHeight:1.75,fontSize:'1rem',maxWidth:460,margin:'0 auto 2.25rem'}}>
          Someone who actually gets your taste in movies, shows, books, and games. Get recommendations from them, not an algorithm.
        </p>

        {linkSent ? (
          <div style={{maxWidth:340,width:'100%'}}>
            <div style={{fontSize:'1.75rem',marginBottom:'1rem'}}>📬</div>
            <p style={{color:G.text,fontSize:'0.95rem',marginBottom:'0.5rem',fontWeight:500}}>Check your email</p>
            <p style={{color:G.muted,fontSize:'0.85rem',lineHeight:1.6,marginBottom:'1.25rem'}}>We sent a sign-in link to <strong style={{color:G.text}}>{email}</strong>. Open it on this device to continue.</p>
            <button onClick={()=>setLinkSent(false)} style={{background:'none',border:'none',color:G.dim,fontSize:'0.78rem',cursor:'pointer',fontFamily:'inherit',textDecoration:'underline'}}>Use a different email</button>
          </div>
        ) : (
          <div className="fade-up-delay-3" style={{maxWidth:340,width:'100%'}}>
            <input className="k-input k-input-glow" style={{...s.input,background:'rgba(255,255,255,0.06)',backdropFilter:'blur(10px)',WebkitBackdropFilter:'blur(10px)',border:'1px solid rgba(255,255,255,0.14)',boxShadow:'inset 0 1px 0 rgba(255,255,255,0.08)'}} type="email" placeholder="your@email.com"
              value={email} onChange={e=>setEmail(e.target.value)}
              onKeyDown={e=>e.key==='Enter'&&requestMagicLink()} />
            {authError && <div style={{color:'#FCA5A5',fontSize:'0.78rem',marginBottom:'0.75rem'}}>{authError}</div>}
            <button className="k-btn k-btn-glow" style={{...s.btn,transition:'all 0.2s',opacity:(authLoading||authCooldown>0)?0.6:1}}
              onClick={requestMagicLink} disabled={authLoading||authCooldown>0}>
              {authLoading ? 'Sending...' : authCooldown>0 ? `Wait ${authCooldown}s to resend` : 'Send me a sign-in link →'}
            </button>
            <p style={{color:G.dim,fontSize:'0.7rem',marginTop:'0.75rem',lineHeight:1.5}}>
              By signing up, you agree to our <button onClick={()=>setStep('terms')} style={{background:'none',border:'none',color:G.dim,fontSize:'0.7rem',textDecoration:'underline',cursor:'pointer',fontFamily:'inherit',padding:0}}>Terms</button> and <button onClick={()=>setStep('privacy')} style={{background:'none',border:'none',color:G.dim,fontSize:'0.7rem',textDecoration:'underline',cursor:'pointer',fontFamily:'inherit',padding:0}}>Privacy Policy</button>.
            </p>
          </div>
        )}
        <p style={{color:G.dim,fontSize:'0.76rem',marginTop:'1rem'}}>No password needed. We'll email you a one-click link.</p>
        <p style={{color:G.dim,fontSize:'0.68rem',marginTop:'1.5rem'}}>
          <button onClick={()=>setStep('privacy')} style={{background:'none',border:'none',color:G.dim,fontSize:'0.68rem',textDecoration:'underline',cursor:'pointer',fontFamily:'inherit',padding:0,marginRight:'0.75rem'}}>Privacy</button>
          <button onClick={()=>setStep('terms')} style={{background:'none',border:'none',color:G.dim,fontSize:'0.68rem',textDecoration:'underline',cursor:'pointer',fontFamily:'inherit',padding:0,marginRight:'0.75rem'}}>Terms</button>
          <a href="mailto:info@kindredmatch.co" style={{color:G.dim,fontSize:'0.68rem',textDecoration:'underline'}}>Contact</a>
        </p>
      </div>
    </div>
  );

  // ─── FIRST-TIME ACCOUNT SETUP ──────────────────────────────────
  // Only ever shown once, right after someone's very first verified sign-in.
  // Returning users skip this completely — Supabase remembers them.
  if (step === 'welcome_setup') return (
    <div style={s.app}>
      <style>{FONTS+css}</style>
      <div style={s.center}>
        <div style={{fontFamily:"'Cormorant Garamond',serif",fontSize:'2rem',fontWeight:500,marginBottom:'2rem',letterSpacing:'0.06em'}}>
          Kind<span style={{color:G.purple}}>r</span>ed
        </div>
        <h2 style={s.h2}>You're verified, almost there</h2>
        <p style={{color:G.muted,lineHeight:1.7,fontSize:'0.95rem',maxWidth:420,margin:'0 auto 2rem'}}>One last thing before we build your taste profile.</p>
        <div style={{maxWidth:340,width:'100%'}}>
          <input className="k-input" style={s.input} type="text" placeholder="Display name (optional)"
            value={username} onChange={e=>setUsername(e.target.value)} />
          <label style={{display:'flex',alignItems:'flex-start',gap:'0.6rem',marginBottom:'1rem',cursor:'pointer',textAlign:'left'}}>
            <input type="checkbox" checked={subscribeEmail} onChange={e=>setSubscribeEmail(e.target.checked)}
              style={{marginTop:'0.15rem',width:14,height:14,accentColor:G.purple,flexShrink:0}} />
            <span style={{fontSize:'0.78rem',color:G.muted,lineHeight:1.5}}>Send me a weekly taste recap by email. Unsubscribe anytime.</span>
          </label>
          {authError && <div style={{color:'#FCA5A5',fontSize:'0.78rem',marginBottom:'0.75rem'}}>{authError}</div>}
          <button className="k-btn" style={{...s.btn,transition:'all 0.2s',opacity:authLoading?0.6:1}}
            onClick={completeNewAccountSetup} disabled={authLoading}>
            {authLoading ? 'Setting up...' : 'Start rating →'}
          </button>
        </div>
      </div>
    </div>
  );

  // ─── QUIZ ──────────────────────────────────────────────────
  if (step === 'quiz') {
    const domInfo = DOMAINS.find(d => d.key === quizDomain);
    const currentRatings = ratings[quizDomain];
    const ratedTitles = Object.entries(currentRatings).filter(([,v])=>v).sort((a,b)=>b[1]-a[1]);
    const isSearching = searchLoading[quizDomain];
    const results = searchResults[quizDomain];

    return (
      <div style={s.app}>
        <style>{FONTS+css}</style>
        <div style={{maxWidth:640,margin:'0 auto',padding:'2rem 1.5rem'}}>

          {/* Domain tabs */}
          <div style={{display:'flex',gap:'0.5rem',marginBottom:'1.25rem'}}>
            {DOMAINS.map(d => {
              const active = d.key === quizDomain;
              return (
                <button key={d.key} className="k-tab" onClick={()=>setQuizDomain(d.key)} style={{
                  flex:1,padding:'0.6rem 0.5rem',borderRadius:10,border:`1px solid ${active?d.color:G.border}`,
                  background:active?`${d.color}18`:G.card,color:active?d.color:G.muted,
                  cursor:'pointer',fontFamily:'inherit',fontSize:'0.78rem',fontWeight:active?600:400,
                  transition:'all 0.2s'
                }}>
                  {d.icon} {d.label}
                  {rated(d.key)>0 && <span style={{marginLeft:'0.3rem',fontSize:'0.65rem',opacity:0.7}}>({rated(d.key)})</span>}
                </button>
              );
            })}
          </div>

          <button onClick={()=>setStep('import')} style={{background:'none',border:'none',color:G.dim,fontSize:'0.74rem',cursor:'pointer',fontFamily:'inherit',marginBottom:'1.25rem',padding:0,textDecoration:'underline'}}>
            📥 Already rate things elsewhere? Import from Letterboxd, Goodreads, or Steam
          </button>

          <CompletionWidget ratings={ratings} />

          {/* Intro line on first domain */}
          {quizDomain === 'film' && totalRated() === 0 && (
            <p style={{color:G.muted,fontSize:'0.83rem',lineHeight:1.65,marginBottom:'1rem'}}>
              Rate as many as you recognize, skip the rest. The more you rate, the better your twin match.
            </p>
          )}

          {/* Search box */}
          <div style={{position:'relative',marginBottom:'1rem'}}>
            <input
              className="k-search"
              style={{...s.input,marginBottom:0,paddingLeft:'2.5rem',border:`1px solid ${G.border}`,borderRadius:10}}
              placeholder={domInfo.placeholder}
              value={searchQuery[quizDomain]}
              onChange={e => setSearchQuery(prev=>({...prev,[quizDomain]:e.target.value}))}
            />
            <span style={{position:'absolute',left:'0.875rem',top:'50%',transform:'translateY(-50%)',fontSize:'0.9rem',pointerEvents:'none'}}>
              {isSearching ? '⏳' : '🔍'}
            </span>
          </div>

          {/* Search results */}
          {results.length > 0 && (
            <div style={{display:'flex',flexDirection:'column',gap:'0.5rem',marginBottom:'1.25rem'}}>
              {results.map((item, idx) => {
                // Real fix for the search-results star bug: results were
                // keyed by item.title alone, so two different real things
                // that happen to share a title (e.g. "Foundation" the 2021
                // show vs "Foundation" the 1984 series) would show/share
                // the same filled-in rating even though only one had
                // actually been rated.
                //
                // IMPORTANT, fixed after live testing surfaced it: the
                // earlier version of this check fell back to the
                // title-keyed ratings object whenever sourceIdRatings[sk]
                // was undefined — but "undefined" is the NORMAL state for
                // any item that simply hasn't been rated under its own ID
                // yet, not just for items with no ID at all. That meant
                // rating one of two same-titled-but-different items (each
                // with its own real, distinct sourceId from the catalog)
                // still made the OTHER one light up, because the fallback
                // fired for it too. The fix: once an item HAS a sourceId,
                // ONLY ever check sourceIdRatings for that exact ID — never
                // fall back to title. The title-only fallback now applies
                // ONLY to results with no sourceId at all (a source that
                // didn't expose a stable id), which is a much narrower,
                // genuinely unavoidable edge case.
                const sk = item.sourceId ? `${quizDomain}:${item.sourceId}` : null;
                const userRating = sk
                  ? (sourceIdRatings[sk] !== undefined ? sourceIdRatings[sk] : 0)
                  : (currentRatings[item.title] || 0);
                const hk = item.sourceId ? `${quizDomain}:${item.sourceId}` : `${quizDomain}:${item.title}`;
                const hovered = hoveredStar[hk] || 0;
                return (
                  <div key={item.sourceId || idx} className="k-result" style={{
                    background:G.card,border:`1px solid ${userRating?domInfo.color+'44':G.border}`,
                    borderRadius:12,padding:'0.75rem 1rem',display:'flex',alignItems:'center',gap:'0.875rem',
                    transition:'all 0.2s',cursor:'default'
                  }}>
                    {item.poster && <img src={item.poster} alt="" className="k-poster" style={{width:36,height:52,objectFit:'cover',borderRadius:4,flexShrink:0,background:G.deep}} onError={e=>e.target.style.display='none'} />}
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontWeight:500,fontSize:'0.88rem',marginBottom:'0.15rem'}}>{item.title}</div>
                      <div style={{color:G.dim,fontSize:'0.72rem'}}>
                        {item.year && <span>{item.year}</span>}
                        {item.year && item.overview && <span> · </span>}
                        {item.overview && <span>{item.overview}</span>}
                      </div>
                    </div>
                    <div style={{display:'flex',gap:'0.15rem',flexShrink:0}}>
                      {[1,2,3,4,5].map(star => {
                        const filled = hovered>0 ? star<=hovered : star<=userRating;
                        return (
                          <button key={star} className="k-star"
                            onClick={()=>setRating(quizDomain,item.title,star,item.sourceId)}
                            onMouseEnter={()=>setHoveredStar(h=>({...h,[hk]:star}))}
                            onMouseLeave={()=>setHoveredStar(h=>({...h,[hk]:0}))}
                            style={{background:'none',border:'none',cursor:'pointer',fontSize:'1rem',padding:'0.1rem',
                              transition:'transform 0.12s',lineHeight:1,color:filled?G.gold:G.border}}>
                            ★
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Empty search state */}
          {searchQuery[quizDomain].length >= 2 && !isSearching && results.length === 0 && (
            <div style={{textAlign:'center',padding:'1.5rem',color:G.dim,fontSize:'0.83rem',marginBottom:'1rem'}}>
              No results found for "{searchQuery[quizDomain]}"
            </div>
          )}

          {/* Hint when search box is empty */}
          {searchQuery[quizDomain].length === 0 && ratedTitles.length === 0 && (
            <div style={{textAlign:'center',padding:'1.5rem 0',color:G.dim,fontSize:'0.83rem',marginBottom:'0.5rem'}}>
              Start typing to search for {domInfo.label.toLowerCase()} you've seen or played
            </div>
          )}

          {/* Your ratings for this domain */}
          {ratedTitles.length > 0 && (
            <div style={{marginBottom:'1.25rem'}}>
              <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.6rem',color:G.dim,textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:'0.625rem'}}>
                Your {domInfo.label} ratings ({ratedTitles.length})
              </div>
              <div style={{display:'flex',flexDirection:'column',gap:'0.4rem'}}>
                {ratedTitles.map(([title, stars]) => (
                  <div key={title} style={{display:'flex',alignItems:'center',gap:'0.75rem',padding:'0.5rem 0.875rem',background:G.card,border:`1px solid ${domInfo.color}33`,borderRadius:10}}>
                    <span style={{flex:1,fontSize:'0.83rem',fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{title}</span>
                    <span style={{color:G.gold,fontSize:'0.78rem',fontFamily:'Space Mono,monospace',flexShrink:0}}>{'★'.repeat(stars)}{'☆'.repeat(5-stars)}</span>
                    <button onClick={()=>setRating(quizDomain,title,undefined)} style={{background:'none',border:'none',cursor:'pointer',color:G.dim,fontSize:'0.65rem',padding:'0 0.2rem',fontFamily:'inherit',flexShrink:0}}>✕</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Footer nav */}
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',paddingTop:'0.5rem'}}>
            <span style={{fontFamily:'Space Mono,monospace',fontSize:'0.65rem',color:G.dim}}>{totalRated()} total rated</span>
            <button className="k-btn" style={{...s.btn,width:'auto',padding:'0.75rem 1.5rem',fontSize:'0.88rem',transition:'all 0.2s'}} onClick={()=>setStep('processing')}>
              {totalRated() === 0 ? 'Skip for now →' : 'See my profile →'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── IMPORT ────────────────────────────────────────────────
  if (step === 'import') {
    const sources = [
      { key:'letterboxd', label:'Letterboxd', icon:'🎬' },
      { key:'goodreads',  label:'Goodreads',  icon:'📚' },
      { key:'steam',      label:'Steam',      icon:'🎮' },
    ];

    return (
      <div style={s.app}>
        <style>{FONTS+css}</style>
        <div style={{maxWidth:620,margin:'0 auto',padding:'2rem 1.5rem'}} className="slide-in">
          <button onClick={()=>setStep('quiz')} style={{background:'none',border:'none',color:G.dim,fontSize:'0.78rem',cursor:'pointer',fontFamily:'inherit',marginBottom:'1.5rem',padding:0}}>← Back to rating</button>

          <div style={{marginBottom:'1.5rem'}}>
            <div style={{...s.eyebrow,color:G.purple}}>BULK IMPORT</div>
            <h2 style={s.h2}>Bring in your existing ratings</h2>
            <p style={{color:G.muted,fontSize:'0.85rem',lineHeight:1.65}}>Already rated things on another platform? Import them here instead of starting from zero.</p>
          </div>

          <div style={{display:'flex',gap:'0.5rem',marginBottom:'1.5rem'}}>
            {sources.map(src => {
              const active = importTab === src.key;
              return (
                <button key={src.key} className="k-tab" onClick={()=>{setImportTab(src.key);setImportPreview(null);setImportStatus(null);}} style={{
                  flex:1,padding:'0.6rem 0.5rem',borderRadius:10,border:`1px solid ${active?G.purple:G.border}`,
                  background:active?G.purpleDim:G.card,color:active?G.purple:G.muted,
                  cursor:'pointer',fontFamily:'inherit',fontSize:'0.78rem',fontWeight:active?600:400,transition:'all 0.2s'
                }}>
                  {src.icon} {src.label}
                </button>
              );
            })}
          </div>

          {/* LETTERBOXD */}
          {importTab === 'letterboxd' && (
            <>
              <div style={{...s.card,marginBottom:'1.25rem'}}>
                <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.6rem',color:G.dim,textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:'0.75rem'}}>How to export from Letterboxd</div>
                <ol style={{color:G.muted,fontSize:'0.82rem',lineHeight:1.8,paddingLeft:'1.2rem',margin:0}}>
                  <li>On Letterboxd, hover your username (top right) → <strong style={{color:G.text}}>Settings</strong></li>
                  <li>Click the <strong style={{color:G.text}}>Data</strong> tab</li>
                  <li>Click <strong style={{color:G.text}}>Export Your Data</strong>, a ZIP file downloads</li>
                  <li>Unzip it, then upload <strong style={{color:G.text}}>ratings.csv</strong> (or <strong style={{color:G.text}}>diary.csv</strong> if you don't have ratings.csv) below</li>
                </ol>
              </div>
              {!importPreview && (
                <label style={{display:'block',...s.card,textAlign:'center',cursor:'pointer',borderStyle:'dashed',marginBottom:'1rem'}}>
                  <input type="file" accept=".csv" onChange={e=>handleFileUpload(e,'letterboxd')} style={{display:'none'}} />
                  <div style={{fontSize:'1.5rem',marginBottom:'0.5rem'}}>📂</div>
                  <div style={{fontSize:'0.85rem',color:G.muted}}>Tap to choose your ratings.csv or diary.csv</div>
                </label>
              )}
            </>
          )}

          {/* GOODREADS */}
          {importTab === 'goodreads' && (
            <>
              <div style={{...s.card,marginBottom:'1.25rem'}}>
                <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.6rem',color:G.dim,textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:'0.75rem'}}>How to export from Goodreads</div>
                <ol style={{color:G.muted,fontSize:'0.82rem',lineHeight:1.8,paddingLeft:'1.2rem',margin:0}}>
                  <li>On Goodreads (desktop site), click <strong style={{color:G.text}}>My Books</strong></li>
                  <li>In the left sidebar under Tools, click <strong style={{color:G.text}}>Import and export</strong></li>
                  <li>Click <strong style={{color:G.text}}>Export Library</strong> and wait for it to generate</li>
                  <li>Download the CSV and upload it below</li>
                </ol>
              </div>
              {!importPreview && (
                <label style={{display:'block',...s.card,textAlign:'center',cursor:'pointer',borderStyle:'dashed',marginBottom:'1rem'}}>
                  <input type="file" accept=".csv" onChange={e=>handleFileUpload(e,'goodreads')} style={{display:'none'}} />
                  <div style={{fontSize:'1.5rem',marginBottom:'0.5rem'}}>📂</div>
                  <div style={{fontSize:'0.85rem',color:G.muted}}>Tap to choose your Goodreads export CSV</div>
                </label>
              )}
            </>
          )}

          {/* SHARED PREVIEW + CONFIRM (Letterboxd & Goodreads) */}
          {(importTab==='letterboxd' || importTab==='goodreads') && importPreview && !importStatus?.done && (
            <div style={{...s.card,marginBottom:'1.25rem'}}>
              <div style={{fontWeight:500,marginBottom:'0.5rem'}}>Found {importPreview.items.length} rated {importPreview.category==='film'?'movies/shows':'books'}</div>
              <div style={{display:'flex',flexDirection:'column',gap:'0.3rem',marginBottom:'1rem'}}>
                {importPreview.items.slice(0,5).map((it,i)=>(
                  <div key={i} style={{fontSize:'0.78rem',color:G.muted,display:'flex',justifyContent:'space-between'}}>
                    <span>{it.title}</span><span style={{color:G.gold,fontFamily:'Space Mono,monospace'}}>{'★'.repeat(it.rating)}</span>
                  </div>
                ))}
                {importPreview.items.length>5 && <div style={{fontSize:'0.75rem',color:G.dim}}>+ {importPreview.items.length-5} more</div>}
              </div>
              {importStatus?.error && <div style={{color:'#FCA5A5',fontSize:'0.8rem',marginBottom:'0.75rem'}}>{importStatus.error}</div>}
              <div style={{display:'flex',gap:'0.75rem'}}>
                <button className="k-out" style={{...s.outBtn,transition:'all 0.2s'}} onClick={()=>setImportPreview(null)}>Cancel</button>
                <button className="k-btn" style={{...s.btn,transition:'all 0.2s',opacity:importStatus?.loading?0.6:1}}
                  onClick={()=>importRows(importPreview.category, importPreview.items)} disabled={importStatus?.loading}>
                  {importStatus?.loading ? 'Importing...' : `Import All ${importPreview.items.length} →`}
                </button>
              </div>
            </div>
          )}

          {/* STEAM */}
          {importTab === 'steam' && (
            <>
              <div style={{...s.card,marginBottom:'1.25rem'}}>
                <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.6rem',color:G.dim,textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:'0.75rem'}}>Before you start</div>
                <p style={{color:G.muted,fontSize:'0.82rem',lineHeight:1.7,margin:0}}>
                  Steam has no star ratings, only playtime. Your Steam profile and game list also need to be set to <strong style={{color:G.text}}>Public</strong> (Steam → Settings → Privacy Settings), or we won't be able to see your library at all.
                </p>
              </div>
              {!steamGames && (
                <div style={{...s.card,marginBottom:'1.25rem'}}>
                  <input className="k-input" style={{...s.input,marginBottom:'0.75rem'}} placeholder="Your Steam profile URL or SteamID64"
                    value={steamInput} onChange={e=>setSteamInput(e.target.value)} />
                  {steamError && <div style={{color:'#FCA5A5',fontSize:'0.8rem',marginBottom:'0.75rem'}}>{steamError}</div>}
                  <button className="k-btn" style={{...s.btn,transition:'all 0.2s',opacity:steamLoading?0.6:1}} onClick={fetchSteamLibrary} disabled={steamLoading || !steamInput.trim()}>
                    {steamLoading ? 'Loading your library...' : 'Fetch My Library →'}
                  </button>
                </div>
              )}

              {steamGames && !importStatus?.done && (
                <>
                  <div style={{display:'flex',gap:'0.5rem',marginBottom:'1.25rem'}}>
                    {[['auto','⚡ Auto-convert playtime'],['manual','✋ Pick stars myself']].map(([key,label])=>(
                      <button key={key} className="k-tab" onClick={()=>setSteamMode(key)} style={{
                        flex:1,padding:'0.55rem 0.5rem',borderRadius:10,border:`1px solid ${steamMode===key?G.cyan:G.border}`,
                        background:steamMode===key?'rgba(6,182,212,0.1)':G.card,color:steamMode===key?G.cyan:G.muted,
                        cursor:'pointer',fontFamily:'inherit',fontSize:'0.74rem',fontWeight:steamMode===key?600:400,transition:'all 0.2s'
                      }}>{label}</button>
                    ))}
                  </div>

                  {steamMode === 'auto' && (() => {
                    const converted = steamGames.map(g=>({title:g.title, rating:playtimeToStars(g.minutes), hours:(g.minutes/60)}))
                      .filter(g=>g.rating>0).sort((a,b)=>b.rating-a.rating);
                    return (
                      <div style={{...s.card,marginBottom:'1.25rem'}}>
                        <p style={{color:G.muted,fontSize:'0.78rem',lineHeight:1.6,marginBottom:'1rem'}}>Rough estimate based on hours played. {steamGames.length-converted.length} games skipped (too little playtime for a real signal).</p>
                        <div style={{display:'flex',flexDirection:'column',gap:'0.3rem',marginBottom:'1rem',maxHeight:280,overflowY:'auto'}}>
                          {converted.slice(0,30).map((g,i)=>(
                            <div key={i} style={{fontSize:'0.78rem',color:G.muted,display:'flex',justifyContent:'space-between',gap:'0.5rem'}}>
                              <span style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{g.title}</span>
                              <span style={{color:G.cyan,fontFamily:'Space Mono,monospace',flexShrink:0}}>{'★'.repeat(g.rating)} · {g.hours.toFixed(0)}h</span>
                            </div>
                          ))}
                          {converted.length>30 && <div style={{fontSize:'0.75rem',color:G.dim}}>+ {converted.length-30} more</div>}
                        </div>
                        {importStatus?.error && <div style={{color:'#FCA5A5',fontSize:'0.8rem',marginBottom:'0.75rem'}}>{importStatus.error}</div>}
                        <button className="k-btn" style={{...s.btn,transition:'all 0.2s',opacity:importStatus?.loading?0.6:1}}
                          onClick={()=>importRows('games', converted)} disabled={importStatus?.loading}>
                          {importStatus?.loading ? 'Importing...' : `Import All ${converted.length} →`}
                        </button>
                      </div>
                    );
                  })()}

                  {steamMode === 'manual' && (
                    <div style={{...s.card,marginBottom:'1.25rem'}}>
                      <p style={{color:G.muted,fontSize:'0.78rem',lineHeight:1.6,marginBottom:'1rem'}}>Click stars for whatever you want to rate. Skip the rest.</p>
                      <div style={{display:'flex',flexDirection:'column',gap:'0.4rem',marginBottom:'1rem',maxHeight:320,overflowY:'auto'}}>
                        {steamGames.slice(0,80).map((g,i)=>{
                          const current = steamManualRatings[g.title] || 0;
                          return (
                            <div key={i} style={{display:'flex',alignItems:'center',gap:'0.5rem',padding:'0.4rem 0'}}>
                              <span style={{flex:1,fontSize:'0.78rem',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{g.title}</span>
                              <div style={{display:'flex',gap:'0.1rem',flexShrink:0}}>
                                {[1,2,3,4,5].map(star=>(
                                  <button key={star} onClick={()=>setSteamManualRatings(prev=>({...prev,[g.title]: prev[g.title]===star?0:star}))}
                                    style={{background:'none',border:'none',cursor:'pointer',fontSize:'0.9rem',padding:'0.05rem',color:star<=current?G.cyan:'rgba(255,255,255,0.2)'}}>★</button>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {importStatus?.error && <div style={{color:'#FCA5A5',fontSize:'0.8rem',marginBottom:'0.75rem'}}>{importStatus.error}</div>}
                      <button className="k-btn" style={{...s.btn,transition:'all 0.2s',opacity:importStatus?.loading?0.6:1}}
                        onClick={()=>importRows('games', Object.entries(steamManualRatings).filter(([,v])=>v>0).map(([title,rating])=>({title,rating})))}
                        disabled={importStatus?.loading || Object.values(steamManualRatings).every(v=>!v)}>
                        {importStatus?.loading ? 'Saving...' : 'Save My Ratings →'}
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* SUCCESS (all sources) */}
          {importStatus?.done && (
            <div style={{...s.card,textAlign:'center',marginBottom:'1.25rem'}}>
              <div style={{fontSize:'1.75rem',marginBottom:'0.75rem'}}>✅</div>
              <div style={{fontWeight:500,marginBottom:'0.5rem'}}>Imported {importStatus.imported} rating{importStatus.imported===1?'':'s'}</div>
              {importStatus.skipped>0 && <p style={{color:G.dim,fontSize:'0.78rem',marginBottom:'1rem'}}>{importStatus.skipped} skipped (already rated)</p>}
              <div style={{display:'flex',gap:'0.75rem'}}>
                <button className="k-out" style={{...s.outBtn,transition:'all 0.2s'}} onClick={()=>{setImportPreview(null);setImportStatus(null);setSteamGames(null);setSteamInput('');setSteamManualRatings({});}}>Import More</button>
                <button className="k-btn" style={{...s.btn,transition:'all 0.2s'}} onClick={()=>setStep('profile')}>See My Passport →</button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── PROCESSING ────────────────────────────────────────────
  if (step === 'processing') {
    const stages = ['Analyzing taste fingerprint...','Mapping cross-domain patterns...','Saving your profile...','Almost there...'];
    return (
      <div style={s.app}>
        <style>{FONTS+css}</style>
        <div style={s.center}>
          <div style={{width:48,height:48,border:`2px solid ${G.border}`,borderTop:`2px solid ${G.purple}`,borderRadius:'50%',animation:'spin 1s linear infinite',marginBottom:'2rem'}}/>
          <div key={procStage} className="fade-up" style={{fontFamily:'Space Mono,monospace',fontSize:'0.78rem',color:G.purple,marginBottom:'1.25rem'}}>
            {stages[procStage]}
          </div>
          <div style={{display:'flex',gap:'0.5rem'}}>
            {stages.map((_,i)=>(<div key={i} style={{width:6,height:6,borderRadius:'50%',background:i<=procStage?G.purple:G.border,transition:'background 0.4s'}}/>))}
          </div>
        </div>
      </div>
    );
  }

  // ─── PROFILE / TASTE PASSPORT ────────────────────────────────
  if (step === 'profile') {
    const total = totalRated();
    const avg = (d) => { const v=Object.values(ratings[d]).filter(Boolean); return v.length?v.reduce((a,b)=>a+b,0)/v.length:0; };
    const pct = (d) => Math.round(avg(d)*20);

    // Taste tags based on actual rated titles
    const allTitles = Object.keys({...ratings.film,...ratings.games,...ratings.books}).map(t=>t.toLowerCase());
    const tags = [];
    if (allTitles.some(t=>['interstellar','blade runner','her','arrival','dune','ex machina','inception','2001','gravity','contact','martian'].some(k=>t.includes(k)))) tags.push('Sci-Fi Enthusiast');
    if (allTitles.some(t=>['elden ring','dark souls','disco elysium','hollow knight','celeste','last of us','red dead','witcher'].some(k=>t.includes(k)))) tags.push('Narrative Gamer');
    if (Object.values(ratings.books).filter(v=>v>=4).length >= 2) tags.push('Avid Reader');
    if (allTitles.some(t=>['parasite','portrait','burning','moonlight','mulholland','shoplifters'].some(k=>t.includes(k)))) tags.push('Art House Fan');
    if (allTitles.some(t=>['hades','celeste','hollow knight','stardew','undertale','shovel knight'].some(k=>t.includes(k)))) tags.push('Indie Game Fan');
    if (tags.length === 0) tags.push('Eclectic Taste', 'Curious Explorer');

    const level = getExplorerLevel(total);
    const archetype = buildArchetype(username || email || 'kindred', ratings);
    const fresh = getFreshness(total);
    const radarAxes = buildRarityRadarData(ratings, radarTastes || []);

    return (
      <div style={s.app}>
        <style>{FONTS+css}</style>
        <div style={{maxWidth:560,margin:'0 auto',padding:'2.5rem 1.5rem'}} className="slide-in">

          {/* NOTIFICATIONS BELL — "Your twin changed" V1. Sits above the
              Passport card so it's the first thing visible on the home
              screen, since the whole point is "something changed since you
              last looked" — burying it below the fold defeats that. */}
          {(() => {
            const unread = (notifications || []).filter(n => !n.read);
            return (
              <div style={{position:'relative',marginBottom:'0.85rem'}}>
                <button
                  onClick={() => {
                    const next = !showNotifInbox;
                    setShowNotifInbox(next);
                    if (next && unread.length > 0) markNotificationsRead(unread.map(n => n.id));
                  }}
                  style={{
                    display:'flex',alignItems:'center',gap:'0.5rem',background:'none',border:'none',
                    cursor:'pointer',fontFamily:'inherit',padding:'0.3rem 0',color:unread.length?G.text:G.dim,
                  }}
                >
                  <span style={{fontSize:'1.05rem'}}>🔔</span>
                  <span style={{fontSize:'0.82rem',fontWeight:unread.length?600:400}}>
                    {unread.length > 0 ? `${unread.length} new` : 'Notifications'}
                  </span>
                  {unread.length > 0 && (
                    <span style={{width:7,height:7,borderRadius:'50%',background:G.purple,display:'inline-block'}}/>
                  )}
                </button>

                {showNotifInbox && (
                  <div style={{
                    position:'absolute',top:'100%',left:0,right:0,zIndex:20,marginTop:'0.4rem',
                    background:G.card,border:`1px solid ${G.border}`,borderRadius:14,
                    boxShadow:'0 12px 32px rgba(0,0,0,0.45)',overflow:'hidden',maxHeight:340,overflowY:'auto',
                  }}>
                    {notifications === null ? (
                      <div style={{padding:'1rem',fontSize:'0.8rem',color:G.dim}}>Loading…</div>
                    ) : notifications.length === 0 ? (
                      <div style={{padding:'1.1rem',fontSize:'0.8rem',color:G.dim,textAlign:'center'}}>
                        Nothing yet. We'll let you know when your #1 Taste Neighbor rates something new.
                      </div>
                    ) : (
                      notifications.map(n => {
                        const icon = n.category === 'film' ? '🎬' : n.category === 'games' ? '🎮' : '📚';
                        const stars = '★'.repeat(n.rating);
                        return (
                          <div key={n.id} style={{
                            padding:'0.85rem 1rem',borderBottom:`1px solid ${G.border}`,
                            background:n.read?'transparent':'rgba(139,92,246,0.06)',
                          }}>
                            <div style={{fontSize:'0.82rem',lineHeight:1.4}}>
                              {icon} <strong>{n.twinName}</strong> just rated <strong>{n.item_name}</strong>{' '}
                              <span style={{color:G.gold}}>{stars}</span>
                            </div>
                            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:'0.45rem'}}>
                              <span style={{fontSize:'0.66rem',color:G.dim}}>
                                {new Date(n.created_at).toLocaleDateString()}
                              </span>
                              <button
                                onClick={() => {
                                  setQuizDomain(n.category);
                                  setSearchQuery(prev => ({...prev, [n.category]: n.item_name}));
                                  setShowNotifInbox(false);
                                  setStep('quiz');
                                }}
                                style={{...s.outBtn,padding:'0.3rem 0.7rem',fontSize:'0.68rem',width:'auto'}}
                              >
                                Find &amp; rate →
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {/* PASSPORT CARD — collectible card per Claude Design handoff */}
          <div style={{position:'relative',border:`1px solid ${G.border}`,borderRadius:24,overflow:'hidden',background:`linear-gradient(180deg, ${G.deep}, ${G.bg})`,marginBottom:'1.25rem'}}>
            <ConstellationBg color="108,93,211" opacity={0.4} />
            <div style={{position:'absolute',top:14,left:14,width:14,height:14,borderTop:'1px solid #46465a',borderLeft:'1px solid #46465a'}}/>
            <div style={{position:'absolute',top:14,right:14,width:14,height:14,borderTop:'1px solid #46465a',borderRight:'1px solid #46465a'}}/>
            <div style={{position:'absolute',bottom:14,left:14,width:14,height:14,borderBottom:'1px solid #46465a',borderLeft:'1px solid #46465a'}}/>
            <div style={{position:'absolute',bottom:14,right:14,width:14,height:14,borderBottom:'1px solid #46465a',borderRight:'1px solid #46465a'}}/>

            <div style={{position:'relative',padding:'1.4rem 1.4rem 1.6rem'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',fontFamily:'Space Mono,monospace',fontSize:'0.62rem',letterSpacing:'0.16em',color:G.dim}}>
                <span>KINDRED · PASSPORT</span>
                <span style={{color:fresh.pct===100?G.green:G.cyan}}>{fresh.pct}% COMPLETE</span>
              </div>

              {radarAxes.length > 0 ? (
                <div style={{position:'relative',height:220,marginTop:'0.5rem'}}>
                  <div style={{
                    position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)',
                    width:230, height:230, borderRadius:'50%', pointerEvents:'none',
                    background:'radial-gradient(circle, rgba(108,93,211,0.22) 0%, rgba(108,93,211,0.06) 55%, transparent 75%)',
                  }}/>
                  <PassportRadar axes={radarAxes} size={260} />
                </div>
              ) : (
                <div style={{height:140,display:'flex',alignItems:'center',justifyContent:'center',color:G.dim,fontSize:'0.82rem',textAlign:'center',padding:'0 1rem'}}>
                  Rate a few 4-5★ things to start filling in your radar.
                </div>
              )}

              <div style={{textAlign:'center',marginTop:'0.2rem'}}>
                <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.62rem',letterSpacing:'0.28em',color:G.dim}}>YOUR ARCHETYPE</div>
                <div style={{fontFamily:"'Cormorant Garamond',serif",fontStyle:'italic',fontWeight:400,fontSize:'1.6rem',color:G.text,marginTop:'0.25rem',lineHeight:1.1}}>
                  <span style={{color:archetype.categoryColor,fontStyle:'normal'}}>{archetype.category}</span>{' '}{archetype.behavior}
                </div>
                <div style={{background:'rgba(108,93,211,0.18)',border:'1px solid rgba(108,93,211,0.3)',borderRadius:100,padding:'0.25rem 0.75rem',fontSize:'0.68rem',color:G.purpleLight,fontFamily:'Space Mono,monospace',display:'inline-block',marginTop:'0.6rem'}}>{level}</div>
              </div>
            </div>
          </div>

          {/* legend — single real series (rarity by domain). No behavior/mood
              legend entries since the radar only plots the one real signal. */}
          {radarAxes.length > 0 && (
            <div style={{display:'flex',justifyContent:'center',gap:'1.1rem',marginBottom:'1.25rem'}}>
              <div style={{display:'flex',alignItems:'center',gap:'0.4rem'}}><span style={{width:9,height:9,borderRadius:'50%',background:G.green,display:'inline-block'}}/><span style={{fontFamily:'Space Mono,monospace',fontSize:'0.62rem',letterSpacing:'0.08em',color:G.dim}}>RARITY BY DOMAIN</span></div>
            </div>
          )}

          <p style={{color:G.muted,fontSize:'0.82rem',marginBottom:'1.25rem',textAlign:'center'}}>{total} items rated across film, games, and books</p>

          <div style={{marginBottom:'1.25rem'}}>
            <div style={{display:'flex',justifyContent:'space-between',fontSize:'0.7rem',color:G.muted,marginBottom:'0.4rem'}}>
              <span>Profile Freshness</span>
              <span style={{fontFamily:'Space Mono,monospace',color:fresh.pct===100?G.green:G.amber}}>{fresh.pct}%</span>
            </div>
            <div style={{height:4,background:'rgba(255,255,255,0.08)',borderRadius:2,overflow:'hidden',marginBottom:'0.5rem'}}>
              <div style={{height:'100%',width:`${fresh.pct}%`,background:fresh.pct===100?G.green:G.amber,borderRadius:2,transition:'width 0.6s ease'}}/>
            </div>
            <p style={{color:G.dim,fontSize:'0.72rem',margin:0,textAlign:'center'}}>
              {fresh.remaining===0 ? 'Your profile is fresh!' : `Rate ${fresh.remaining} more thing${fresh.remaining===1?'':'s'} to refresh it.`}
            </p>
            {(streakCount || 0) >= 2 && (
              <div style={{marginTop:'1rem',display:'flex',alignItems:'center',justifyContent:'center',gap:'0.4rem'}}>
                <span style={{fontSize:'0.95rem'}}>🔥</span>
                <span style={{fontFamily:'Space Mono,monospace',fontSize:'0.78rem',color:G.amber,fontWeight:600}}>
                  {streakCount}-day streak
                </span>
                <span style={{fontSize:'0.66rem',color:G.dim}}>· rate today to keep it</span>
              </div>
            )}
          </div>

          <button onClick={()=>sharePassport(level,archetype,total)} style={{width:'100%',background:G.pink,color:'#1a0a12',border:'none',borderRadius:14,padding:'0.9rem',fontSize:'0.92rem',fontWeight:600,cursor:'pointer',fontFamily:'Inter,sans-serif',marginBottom:'1.5rem',transition:'all 0.2s'}}>
            {copiedId==='passport' ? '✓ Shared as image' : '⇪ Share your Passport'}
          </button>

          <div style={{...s.card,marginBottom:'1rem'}}>
            <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.6rem',color:G.dim,textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:'1.25rem'}}>Average Rating by Domain</div>
            {DOMAINS.map(d => {
              const p=pct(d.key); const n=rated(d.key);
              return (
                <div key={d.key} style={{marginBottom:'1.25rem'}}>
                  <div style={{display:'flex',justifyContent:'space-between',fontSize:'0.8rem',marginBottom:'0.5rem'}}>
                    <span style={{color:G.muted}}>{d.icon} {d.label}</span>
                    <span style={{fontFamily:'Space Mono,monospace',fontSize:'0.72rem',color:n>0?d.color:G.dim}}>
                      {n>0?`${p}% avg · ${n} rated`:'Not rated yet'}
                    </span>
                  </div>
                  <div style={{height:5,background:'rgba(255,255,255,0.06)',borderRadius:3,overflow:'hidden'}}>
                    <div style={{height:'100%',width:`${p}%`,background:d.color,borderRadius:3,transition:'width 1.2s ease'}}/>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{...s.card,marginBottom:'1.25rem'}}>
            <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.6rem',color:G.dim,textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:'0.875rem'}}>Taste Tags</div>
            <div style={{display:'flex',flexWrap:'wrap',gap:'0.5rem'}}>
              {tags.map(t=>(<span key={t} style={{background:G.purpleDim,border:'1px solid rgba(108,93,211,0.2)',color:'#9D92F0',padding:'0.35rem 0.875rem',borderRadius:100,fontSize:'0.76rem'}}>{t}</span>))}
            </div>
          </div>
          <div style={{display:'flex',gap:'0.75rem',marginBottom:'1rem'}}>
            <button className="k-out" style={{...s.outBtn,transition:'all 0.2s'}} onClick={()=>setStep('quiz')}>Rate More</button>
            <button className="k-btn" style={{...s.btn,transition:'all 0.2s'}} onClick={()=>setStep('twins')}>
              {total >= TWIN_UNLOCK_THRESHOLD ? 'Find My Taste Twins →' : `🔒 Unlock Twin (${TWIN_UNLOCK_THRESHOLD - total} more)`}
            </button>
          </div>
          <div style={{...s.card,marginBottom:'1rem'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:discordLinked||linkCode?'0.75rem':'0'}}>
              <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.6rem',color:G.dim,textTransform:'uppercase',letterSpacing:'0.1em'}}>Discord</div>
              {discordLinked && <span style={{color:G.green,fontSize:'0.74rem'}}>✓ Connected</span>}
            </div>
            {discordLinked ? (
              <p style={{color:G.muted,fontSize:'0.82rem',margin:0}}>Your ratings sync across web and Discord.</p>
            ) : linkCode ? (
              <>
                <p style={{color:G.muted,fontSize:'0.82rem',marginBottom:'0.75rem'}}>In Discord, type this command:</p>
                <div style={{background:G.purpleDim,border:'1px solid rgba(108,93,211,0.25)',borderRadius:10,padding:'0.75rem 1rem',fontFamily:'Space Mono,monospace',fontSize:'0.95rem',color:'#9D92F0',textAlign:'center',marginBottom:'0.5rem'}}>
                  /link {linkCode}
                </div>
                <p style={{color:G.dim,fontSize:'0.72rem',margin:0}}>Expires in 10 minutes. This combines your Discord ratings with this account.</p>
              </>
            ) : (
              <>
                <p style={{color:G.muted,fontSize:'0.82rem',marginBottom:'0.75rem'}}>Connect your Discord account so ratings and twins are shared across both.</p>
                <button onClick={generateLinkCode} disabled={linkCodeLoading} style={{width:'100%',background:'transparent',border:`1px solid rgba(108,93,211,0.3)`,color:'#9D92F0',padding:'0.6rem',borderRadius:10,fontSize:'0.78rem',cursor:linkCodeLoading?'default':'pointer',fontFamily:'inherit',opacity:linkCodeLoading?0.6:1,transition:'all 0.2s'}}>
                  {linkCodeLoading ? 'Generating…' : 'Connect Discord'}
                </button>
              </>
            )}
          </div>

          {/* Data sharing — same toggle the one-time prompt sets, editable
              anytime per the handoff's requirement. */}
          <div style={{...s.card,marginBottom:'1rem'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div>
                <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.6rem',color:G.dim,textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:'0.3rem'}}>Data Sharing</div>
                <p style={{color:G.muted,fontSize:'0.78rem',margin:0,maxWidth:240}}>Help improve recommendations with anonymized taste data.</p>
              </div>
              <button onClick={()=>toggleDataSharingConsent(!dataSharingConsent)} style={{flexShrink:0,width:44,height:26,borderRadius:13,border:'none',cursor:'pointer',background:dataSharingConsent?G.purple:G.border,position:'relative',transition:'background 0.2s'}}>
                <span style={{position:'absolute',top:3,left:dataSharingConsent?22:3,width:20,height:20,borderRadius:'50%',background:'#fff',transition:'left 0.2s'}}/>
              </button>
            </div>
          </div>

          {/* Email notifications — opt-in (default off). When on, the
              /api/notify-twins endpoint emails the user when their #1 Taste
              Neighbor rates something new, in addition to the in-app inbox. */}
          <div style={{...s.card,marginBottom:'1rem'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div>
                <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.6rem',color:G.dim,textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:'0.3rem'}}>Email Updates</div>
                <p style={{color:G.muted,fontSize:'0.78rem',margin:0,maxWidth:240}}>Get an email when your #1 Taste Neighbor rates something new.</p>
              </div>
              <button onClick={()=>toggleEmailNotifications(!emailNotifications)} style={{flexShrink:0,width:44,height:26,borderRadius:13,border:'none',cursor:'pointer',background:emailNotifications?G.purple:G.border,position:'relative',transition:'background 0.2s'}}>
                <span style={{position:'absolute',top:3,left:emailNotifications?22:3,width:20,height:20,borderRadius:'50%',background:'#fff',transition:'left 0.2s'}}/>
              </button>
            </div>
          </div>

          {/* Support + account deletion — grouped as the two "control your
              data" actions, per the handoff's placement instruction. */}
          <div style={{...s.card,marginBottom:'1rem'}}>
            <a href="mailto:info@kindredmatch.co" style={{display:'block',color:G.muted,fontSize:'0.82rem',textDecoration:'none',marginBottom:'0.85rem'}}>
              Contact / Get Help
            </a>
            <div style={{height:1,background:G.border,marginBottom:'0.85rem'}}/>
            {showDeleteConfirm ? (
              <div>
                <p style={{color:'#FCA5A5',fontSize:'0.8rem',lineHeight:1.6,marginBottom:'0.85rem'}}>This permanently deletes your account and all your ratings. This can't be undone.</p>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0.6rem'}}>
                  <button onClick={()=>setShowDeleteConfirm(false)} style={{background:'transparent',border:`1px solid ${G.border}`,color:G.text,padding:'0.6rem',borderRadius:10,fontSize:'0.8rem',cursor:'pointer',fontFamily:'inherit'}}>Cancel</button>
                  <button onClick={deleteAccount} disabled={deleteLoading} style={{background:'#7a1f1f',border:'none',color:'#fff',padding:'0.6rem',borderRadius:10,fontSize:'0.8rem',cursor:deleteLoading?'default':'pointer',fontFamily:'inherit',opacity:deleteLoading?0.6:1}}>
                    {deleteLoading ? 'Deleting…' : 'Yes, delete'}
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={()=>setShowDeleteConfirm(true)} style={{background:'none',border:'none',color:'#d97a7a',fontSize:'0.8rem',cursor:'pointer',fontFamily:'inherit',padding:0}}>
                Delete my account
              </button>
            )}
          </div>

          <button onClick={handleSignOut} style={{background:'none',border:'none',color:G.dim,fontSize:'0.74rem',cursor:'pointer',fontFamily:'inherit',width:'100%',textAlign:'center',padding:'0.5rem'}}>Sign out</button>
          <p style={{color:G.dim,fontSize:'0.68rem',marginTop:'1.5rem',textAlign:'center'}}>
            <button onClick={()=>setStep('privacy')} style={{background:'none',border:'none',color:G.dim,fontSize:'0.68rem',textDecoration:'underline',cursor:'pointer',fontFamily:'inherit',padding:0,marginRight:'0.75rem'}}>Privacy</button>
            <button onClick={()=>setStep('terms')} style={{background:'none',border:'none',color:G.dim,fontSize:'0.68rem',textDecoration:'underline',cursor:'pointer',fontFamily:'inherit',padding:0,marginRight:'0.75rem'}}>Terms</button>
            <a href="mailto:info@kindredmatch.co" style={{color:G.dim,fontSize:'0.68rem',textDecoration:'underline'}}>Contact</a>
          </p>
        </div>
      </div>
    );
  }

  // ─── TWINS ─────────────────────────────────────────────────
  if (step === 'twins') {
    const totalNow = totalRated();
    if (totalNow < TWIN_UNLOCK_THRESHOLD) {
      const remaining = TWIN_UNLOCK_THRESHOLD - totalNow;
      return (
        <div style={s.app}>
          <style>{FONTS+css}</style>
          <div style={s.center}>
            <div style={{marginBottom:'1.25rem',display:'flex',justifyContent:'center'}}><LockGlyph size={42} color={G.dim} /></div>
            <h2 style={s.h2}>Your first twin is close</h2>
            <p style={{color:G.muted,fontSize:'0.9rem',lineHeight:1.7,maxWidth:380,margin:'0 auto 1.75rem'}}>
              Rate {remaining} more thing{remaining===1?'':'s'} to unlock your first twin. We hold off until there's enough signal for a match that actually feels right.
            </p>
            <div style={{maxWidth:280,width:'100%',margin:'0 auto 1.75rem'}}>
              <div style={{height:5,background:'rgba(255,255,255,0.06)',borderRadius:3,overflow:'hidden'}}>
                <div className="k-progress-shimmer" style={{height:'100%',width:`${Math.round((totalNow/TWIN_UNLOCK_THRESHOLD)*100)}%`,background:G.cyan,borderRadius:3,transition:'width 0.6s ease',position:'relative'}}/>
              </div>
              <p style={{color:G.dim,fontSize:'0.72rem',marginTop:'0.5rem'}}>{totalNow} / {TWIN_UNLOCK_THRESHOLD} rated</p>
            </div>
            <div style={{maxWidth:280,width:'100%'}}>
              <button className="k-btn" style={{...s.btn,transition:'all 0.2s'}} onClick={()=>setStep('quiz')}>Rate More →</button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div style={s.app}>
        <style>{FONTS+css}</style>
        {showConsentModal && <ConsentModal onAnswer={answerConsentPrompt} />}
        <div style={{maxWidth:600,margin:'0 auto',padding:'2.5rem 1.5rem'}} className="slide-in">
          <div style={{textAlign:'center',marginBottom:'2rem'}}>
            <div style={{...s.eyebrow,color:G.cyan}}>TASTE MATCHING</div>
            <h2 style={s.h2}>Your taste twins</h2>
            <p style={{color:G.muted,fontSize:'0.85rem',lineHeight:1.65}}>Real users matched against your saved ratings.</p>
          </div>
          {twinsLoading && (
            <div style={{textAlign:'center',padding:'3rem 0'}}>
              <div style={{width:40,height:40,border:`2px solid ${G.border}`,borderTop:`2px solid ${G.cyan}`,borderRadius:'50%',animation:'spin 1s linear infinite',margin:'0 auto 1rem'}}/>
              <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.7rem',color:G.dim}}>Comparing taste with everyone...</div>
            </div>
          )}
          {twinsError && (
            <div style={{background:'rgba(239,68,68,0.08)',border:'1px solid rgba(239,68,68,0.2)',borderRadius:14,padding:'1.25rem',textAlign:'center',marginBottom:'1.25rem'}}>
              <div style={{color:'#FCA5A5',marginBottom:'0.75rem',fontSize:'0.85rem'}}>{twinsError}</div>
              <button className="k-btn" style={{...s.btn,width:'auto',padding:'0.6rem 1.25rem',fontSize:'0.85rem',transition:'all 0.2s'}} onClick={fetchRealTwins}>Try Again</button>
            </div>
          )}
          {!twinsLoading && !twinsError && realTwins && realTwins.length === 0 && (
            <div style={{...s.card,textAlign:'center',marginBottom:'1.25rem'}}>
              <div style={{marginBottom:'0.75rem',display:'flex',justifyContent:'center'}}><SearchGlyph size={32} color={G.dim} /></div>
              <div style={{fontWeight:500,marginBottom:'0.5rem'}}>No taste twins yet</div>
              <p style={{color:G.muted,fontSize:'0.83rem',lineHeight:1.6,marginBottom:'1.1rem'}}>Nobody else has rated the same titles as you yet. Invite a friend — the more people who rate, the better your matches get, and you'll both be matchable.</p>
              <button onClick={inviteFriend} style={{width:'100%',background:G.pink,color:'#1a0a12',border:'none',borderRadius:12,padding:'0.8rem',fontSize:'0.88rem',fontWeight:600,cursor:'pointer',fontFamily:'Inter,sans-serif',transition:'all 0.2s'}}>
                {copiedId==='invite' ? '✓ Invite link ready' : '✦ Invite a friend'}
              </button>
              {(referralCount || 0) > 0 && (
                <p style={{color:G.dim,fontSize:'0.72rem',marginTop:'0.75rem',marginBottom:0}}>
                  You've invited {referralCount} friend{referralCount===1?'':'s'} so far 🎉
                </p>
              )}
            </div>
          )}
          {!twinsLoading && realTwins && realTwins.length > 0 && (
            <div style={{display:'flex',flexDirection:'column',gap:'1.25rem',marginBottom:'1.25rem'}}>
              {realTwins.map((twin, twinIdx) => (
                <div key={twin.id} className="k-twin k-twin-reveal" style={{borderRadius:20,transition:'all 0.2s',animationDelay:`${twinIdx*0.12}s`}}>
                  <div style={{position:'relative',border:`1px solid ${G.border}`,borderRadius:'20px 20px 0 0',overflow:'hidden',background:`linear-gradient(180deg, ${G.deep}, ${G.bg})`,borderBottom:'none'}}>
                    <ConstellationBg color="255,104,157" opacity={0.3} density={9000} />
                    <div style={{position:'absolute',top:12,left:12,width:12,height:12,borderTop:'1px solid #46465a',borderLeft:'1px solid #46465a'}}/>
                    <div style={{position:'absolute',top:12,right:12,width:12,height:12,borderTop:'1px solid #46465a',borderRight:'1px solid #46465a'}}/>
                    <div style={{position:'relative',padding:'1.3rem'}}>
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',fontFamily:'Space Mono,monospace',fontSize:'0.62rem',letterSpacing:'0.16em',color:G.dim}}>
                        <span>KINDRED · TASTE TWIN</span><span style={{color:G.pink}}>{twin.handle}</span>
                      </div>
                      <div style={{textAlign:'center',marginTop:'0.5rem'}}>
                        <div style={{position:'relative',width:64,height:64,margin:'0 auto',borderRadius:'50%',background:`radial-gradient(circle at 38% 32%, ${G.pink}, ${G.purple})`,display:'flex',alignItems:'center',justifyContent:'center',boxShadow:`0 0 28px rgba(255,104,157,0.4)`}}>
                          <span style={{fontFamily:"'Cormorant Garamond',serif",fontSize:'1.7rem',color:'#fff'}}>{twin.handle?.replace('@','')[0]?.toUpperCase() || '?'}</span>
                        </div>
                        <div style={{fontFamily:"'Cormorant Garamond',serif",fontWeight:300,fontSize:'2.6rem',lineHeight:1,color:G.text,marginTop:'0.6rem'}}>
                          <CountUp value={twin.overall} /><span style={{fontSize:'1rem',color:G.pink}}>%</span>
                        </div>
                        <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.62rem',letterSpacing:'0.28em',color:G.dim,marginTop:'0.15rem'}}>TASTE MATCH</div>
                        <div style={{fontFamily:"'Cormorant Garamond',serif",fontWeight:400,fontSize:'1.25rem',color:G.text,marginTop:'0.6rem'}}>{twin.handle}</div>
                        <div style={{color:G.dim,fontSize:'0.73rem',marginTop:'0.2rem'}}>{twin.overlap} titles in common</div>
                      </div>
                    </div>
                  </div>
                  <div style={{...s.card,borderRadius:'0 0 20px 20px',borderTop:'none'}}>
                    {twin.why && (
                      <div style={{background:G.purpleDim,border:'1px solid rgba(108,93,211,0.2)',borderRadius:10,padding:'0.7rem 0.875rem',marginBottom:'1rem',fontSize:'0.78rem',color:G.purpleLight,lineHeight:1.5}}>
                        💡 {twin.why}
                      </div>
                    )}
                    <div style={{display:'flex',gap:'0.5rem',marginBottom:twin.shared?.length?'1rem':'0'}}>
                      {DOMAINS.map(d => twin.domains[d.key]!==null && (
                        <div key={d.key} style={{flex:1,background:'rgba(255,255,255,0.03)',borderRadius:8,padding:'0.5rem',textAlign:'center'}}>
                          <div style={{fontSize:'0.8rem',marginBottom:'0.2rem'}}>{d.icon}</div>
                          <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.7rem',color:G.purpleLight,fontWeight:700}}>{twin.domains[d.key]}%</div>
                        </div>
                      ))}
                    </div>
                    {twin.shared?.length > 0 && (
                      <div style={{marginBottom:'0.875rem'}}>
                        <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.6rem',color:G.dim,textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:'0.5rem'}}>Shared favorites</div>
                        <div style={{display:'flex',flexWrap:'wrap',gap:'0.4rem'}}>
                          {twin.shared.map((sh,i)=>(<span key={i} style={{background:G.purpleDim,border:'1px solid rgba(108,93,211,0.2)',color:G.purpleLight,padding:'0.25rem 0.7rem',borderRadius:100,fontSize:'0.7rem'}}>{sh.title}</span>))}
                        </div>
                      </div>
                    )}
                    <button onClick={()=>shareTwin(twin)} style={{width:'100%',background:G.pink,color:'#1a0a12',border:'none',borderRadius:11,padding:'0.7rem',fontSize:'0.85rem',fontWeight:600,cursor:'pointer',fontFamily:'Inter,sans-serif',transition:'all 0.2s'}}>
                      {copiedId===twin.id ? '✓ Shared as image' : '⇪ Share this match'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <button className="k-btn" style={{...s.btn,transition:'all 0.2s'}} onClick={()=>setStep('recs')}>See my recommendations →</button>
          {realTwins && realTwins.length > 0 && (
            <button onClick={inviteFriend} style={{width:'100%',background:'transparent',border:`1px solid ${G.border}`,color:G.muted,borderRadius:12,padding:'0.75rem',fontSize:'0.83rem',cursor:'pointer',fontFamily:'inherit',marginTop:'0.75rem',transition:'all 0.2s'}}>
              {copiedId==='invite' ? '✓ Invite link ready' : '✦ Invite a friend → more twins'}
            </button>
          )}
        </div>
      </div>
    );
  }

  // ─── RECOMMENDATIONS ───────────────────────────────────────
  if (step === 'recs') {
    const typeMap = {film:{label:'Film',color:G.purple,icon:'🎬'},show:{label:'Show',color:G.pink,icon:'📺'},game:{label:'Game',color:G.cyan,icon:'🎮'},book:{label:'Book',color:G.amber,icon:'📚'}};
    // Tier identity per the Claude Design handoff: name, icon, trust-dot count
    // (●●●●● down to ○○○○○), each rendered with the design's exact glyphs.
    const tierMeta = {
      1: { label: 'TWIN-BACKED', color: G.purple, dots: '●●●●●', icon: 'crown' },
      2: { label: 'EXTENDED NETWORK', color: '#9a93c0', dots: '●●●●○', icon: '⁂' },
      3: { label: 'TRENDING IN YOUR ARCHETYPE', color: '#8b8fa6', dots: '●●●○○', icon: '◈' },
      4: { label: 'GLOBAL KINDRED TRENDING', color: '#6f7390', dots: '●●○○○', icon: '◉' },
    };
    async function handleBuyClick(rec) {
      logEvent(userId,'affiliate_link_clicked',`${rec.type}:${rec.title}`);
      const href = await buildAffiliateLink(rec.type, rec.title);
      window.open(href, '_blank', 'noopener,noreferrer');
    }
    const hasRealRecs = recs && recs.length > 0;
    const headerSub = hasRealRecs
      ? 'Ranked by how much we trust the source. Real taste twins first.'
      : "Based on everything you've rated across all domains.";

    const CrownIcon = ({ size = 20 }) => (
      <svg width={size} height={size*0.85} viewBox="0 0 24 20" style={{filter:'drop-shadow(0 0 6px rgba(108,93,211,.8))'}}>
        <polygon points="2,18 4,5 9,11 12,3 15,11 20,5 22,18" fill={G.purple}/>
      </svg>
    );

    return (
      <div style={s.app}>
        <style>{FONTS+css}</style>
        <div style={{maxWidth:620,margin:'0 auto',padding:'2.5rem 1.5rem'}} className="slide-in">
          <button onClick={()=>setStep('twins')} style={{background:'none',border:'none',color:G.dim,fontSize:'0.78rem',cursor:'pointer',fontFamily:'inherit',marginBottom:'1.25rem',padding:0}}>← Back to twins</button>
          <div style={{marginBottom:'1.5rem'}}>
            <div style={{...s.eyebrow,color:G.dim,marginBottom:0}}>FOR YOU</div>
            <h2 style={{...s.h2,marginBottom:'0.5rem'}}>Recommendations</h2>
            <p style={{color:G.muted,fontSize:'0.85rem',lineHeight:1.65}}>{headerSub}</p>
          </div>
          {recLoading && (
            <div style={{textAlign:'center',padding:'4rem 0'}}>
              <div style={{width:40,height:40,border:`2px solid ${G.border}`,borderTop:`2px solid ${G.purple}`,borderRadius:'50%',animation:'spin 1s linear infinite',margin:'0 auto 1rem'}}/>
              <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.72rem',color:G.dim}}>Generating recommendations...</div>
            </div>
          )}
          {recError && (
            <div style={{background:'rgba(239,68,68,0.08)',border:'1px solid rgba(239,68,68,0.2)',borderRadius:14,padding:'1.25rem',textAlign:'center',marginBottom:'1.25rem'}}>
              <div style={{color:'#FCA5A5',marginBottom:'0.75rem',fontSize:'0.85rem'}}>{recError}</div>
              <button className="k-btn" style={{...s.btn,width:'auto',padding:'0.6rem 1.25rem',fontSize:'0.85rem',transition:'all 0.2s'}} onClick={generateRecs}>Try Again</button>
            </div>
          )}
          {recs && (
            <>
              <p style={{color:G.dim,fontSize:'0.7rem',lineHeight:1.5,marginBottom:'1.25rem'}}>Kindred earns a small commission on purchases through these links, at no extra cost to you.</p>
              {hasRealRecs && (() => {
                // Group real recs by tier so each tier gets its own header
                // block, matching the design's per-tier sections, while the
                // underlying data/order from generateRecs() stays untouched.
                const byTier = {};
                recs.forEach(r => { (byTier[r.tier] = byTier[r.tier] || []).push(r); });
                return Object.keys(byTier).sort((a,b)=>a-b).map(tierNum => {
                  const meta = tierMeta[tierNum];
                  const items = byTier[tierNum];
                  return (
                    <div key={tierNum} style={{marginBottom:'1.75rem'}}>
                      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'0.5rem'}}>
                        <div style={{display:'flex',alignItems:'center',gap:'0.5rem'}}>
                          {meta.icon === 'crown' ? <CrownIcon /> : <span style={{color:meta.color,fontSize:'0.95rem'}}>{meta.icon}</span>}
                          <span style={{fontFamily:'Space Mono,monospace',fontSize:'0.7rem',fontWeight:700,letterSpacing:'0.12em',color:meta.color}}>{meta.label}</span>
                        </div>
                        <span style={{fontFamily:'Space Mono,monospace',fontSize:'0.6rem',letterSpacing:'0.14em',color:meta.color}}>{meta.dots}</span>
                      </div>
                      <div style={{display:'flex',flexDirection:'column',gap:'0.75rem'}}>
                        {items.map((rec,i)=>{
                          const cfg=typeMap[rec.type]||typeMap.film;
                          const isHero = tierNum === '1' && i === 0;
                          return (
                            <div key={i} className="k-rec" style={isHero ? {
                              position:'relative',border:'1.5px solid rgba(108,93,211,0.55)',borderRadius:18,
                              background:'linear-gradient(180deg,rgba(108,93,211,0.10),rgba(108,93,211,0.02))',
                              boxShadow:'0 0 34px rgba(108,93,211,0.20)',padding:'1.1rem',transition:'all 0.2s'
                            } : {...s.card,transition:'all 0.2s'}}>
                              <div style={{display:'flex',gap:'1rem',alignItems:'flex-start'}}>
                                {rec.poster ? (
                                  <img src={rec.poster} alt="" className="k-poster" style={{width:isHero?64:42,height:rec.type==='game'?(isHero?44:28):(isHero?90:60),objectFit:'cover',borderRadius:8,flexShrink:0,background:G.deep}}/>
                                ) : (
                                  <span style={{fontSize:isHero?'2rem':'1.5rem',flexShrink:0,paddingTop:'0.05rem'}}>{cfg.icon}</span>
                                )}
                                <div style={{flex:1,minWidth:0}}>
                                  <div style={{display:'flex',alignItems:'center',gap:'0.625rem',marginBottom:'0.3rem',flexWrap:'wrap'}}>
                                    <span style={{fontWeight:isHero?500:600,fontSize:isHero?'1.05rem':'0.92rem',fontFamily:isHero?"'Cormorant Garamond',serif":'inherit'}}>{rec.title}</span>
                                    <span style={{background:`${cfg.color}20`,color:cfg.color,padding:'0.12rem 0.6rem',borderRadius:100,fontSize:'0.62rem',fontFamily:'Space Mono,monospace'}}>{cfg.label}</span>
                                  </div>
                                  <p style={{color:G.muted,fontSize:'0.8rem',lineHeight:1.6,margin:0}}>{rec.reason}</p>
                                </div>
                                <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.82rem',color:G.purpleLight,fontWeight:700,flexShrink:0}}>{rec.matchScore}%</div>
                              </div>
                              <button onClick={()=>handleBuyClick(rec)} style={{display:'inline-flex',alignItems:'center',gap:'0.4rem',marginTop:'0.75rem',marginLeft:isHero?0:'2.5rem',color:G.cyan,fontSize:'0.76rem',background:'none',border:'none',cursor:'pointer',fontFamily:'inherit',padding:0}}>
                                🛒 {rec.type==='book' ? 'Find it on Bookshop' : 'Find it on Amazon'}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                });
              })()}
              {!hasRealRecs && aiFallbackRecs && aiFallbackRecs.length === 0 && (
                <div style={{...s.card,textAlign:'center',marginBottom:'1.25rem'}}>
                  <div style={{marginBottom:'0.75rem',display:'flex',justifyContent:'center'}}><SproutGlyph size={32} color={G.green} /></div>
                  <div style={{fontWeight:500,marginBottom:'0.5rem'}}>Your taste network is still growing</div>
                  <p style={{color:G.muted,fontSize:'0.83rem',lineHeight:1.6}}>Nobody with overlapping taste has rated enough yet. Rate a few more things or share Kindred with friends, since real recs come from real people here.</p>
                </div>
              )}
              {!hasRealRecs && aiFallbackRecs && aiFallbackRecs.length > 0 && (
                <div style={{margin:'0.5rem 0 1.25rem',border:'1.5px dashed #33333f',borderRadius:18,background:'rgba(255,255,255,0.012)',padding:'1.1rem'}}>
                  <div style={{display:'flex',alignItems:'center',gap:'0.5rem',marginBottom:'0.6rem'}}>
                    <span style={{display:'inline-flex',width:20,height:20,borderRadius:5,border:'1px dashed #4a4a58',alignItems:'center',justifyContent:'center',fontFamily:'Space Mono,monospace',fontSize:'0.55rem',color:'#6b6f86'}}>AI</span>
                    <span style={{fontFamily:'Space Mono,monospace',fontSize:'0.68rem',fontWeight:700,letterSpacing:'0.1em',color:'#6b6f86'}}>BEYOND YOUR TASTE NETWORK</span>
                  </div>
                  <p style={{color:'#6b6f86',fontSize:'0.75rem',lineHeight:1.5,marginBottom:'0.75rem'}}>No human taste-twin matches yet, so these are AI-generated guesses based only on your own ratings. Lower trust than picks above this line.</p>
                  <div style={{display:'flex',flexDirection:'column',gap:'0.75rem'}}>
                    {aiFallbackRecs.map((rec,i)=>{
                      const cfg=typeMap[rec.type]||typeMap.film;
                      return (
                        <div key={i} className="k-rec" style={{...s.card,border:`1px dashed ${G.border}`,transition:'all 0.2s'}}>
                          <div style={{display:'flex',gap:'1rem',alignItems:'flex-start'}}>
                            {rec.poster ? (
                              <img src={rec.poster} alt="" className="k-poster" style={{width:42,height:rec.type==='game'?28:60,objectFit:'cover',borderRadius:6,flexShrink:0,background:G.deep}}/>
                            ) : (
                              <span style={{fontSize:'1.5rem',flexShrink:0,paddingTop:'0.05rem'}}>{cfg.icon}</span>
                            )}
                            <div style={{flex:1,minWidth:0}}>
                              <div style={{display:'flex',alignItems:'center',gap:'0.625rem',marginBottom:'0.35rem',flexWrap:'wrap'}}>
                                <span style={{fontWeight:600,fontSize:'0.92rem'}}>{rec.title}</span>
                                <span style={{background:`${cfg.color}20`,color:cfg.color,padding:'0.12rem 0.6rem',borderRadius:100,fontSize:'0.62rem',fontFamily:'Space Mono,monospace'}}>{cfg.label}</span>
                              </div>
                              <p style={{color:G.muted,fontSize:'0.8rem',lineHeight:1.6,margin:0}}>{rec.reason}</p>
                            </div>
                          </div>
                          <button onClick={()=>handleBuyClick(rec)} style={{display:'inline-flex',alignItems:'center',gap:'0.4rem',marginTop:'0.75rem',marginLeft:'2.5rem',color:G.cyan,fontSize:'0.76rem',background:'none',border:'none',cursor:'pointer',fontFamily:'inherit',padding:0}}>
                            🛒 {rec.type==='book' ? 'Find it on Bookshop' : 'Find it on Amazon'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <div style={{display:'grid',gridTemplateColumns:'1fr 2fr',gap:'0.75rem'}}>
                <button className="k-out" style={{...s.outBtn,transition:'all 0.2s'}} onClick={()=>setStep('quiz')}>Rate More</button>
                <button className="k-btn" style={{...s.btn,transition:'all 0.2s'}} onClick={()=>{setRecs(null);setAiFallbackRecs([]);generateRecs();}}>Refresh Recs ↺</button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  if (step === 'privacy' || step === 'terms') {
    const isPrivacy = step === 'privacy';
    return (
      <div style={s.app}>
        <style>{FONTS+css}</style>
        <div style={{maxWidth:640,margin:'0 auto',padding:'2.5rem 1.5rem'}} className="slide-in">
          <button onClick={()=>setStep(userId ? 'profile' : 'welcome')} style={{background:'none',border:'none',color:G.dim,fontSize:'0.8rem',cursor:'pointer',fontFamily:'inherit',marginBottom:'1.5rem',padding:0}}>← Back</button>
          <h2 style={s.h2}>{isPrivacy ? 'Privacy Policy' : 'Terms of Service'}</h2>
          <p style={{color:G.dim,fontSize:'0.74rem',marginBottom:'2rem'}}>Last updated: June 28, 2026</p>

          {isPrivacy ? (
            <div style={{color:G.muted,fontSize:'0.88rem',lineHeight:1.75}}>
              <h3 style={{color:G.text,fontSize:'1rem',marginTop:'1.5rem',marginBottom:'0.5rem'}}>What we collect</h3>
              <p>When you use Kindred, we collect your email address (for sign-in via magic link, no password), the titles you rate and your star rating for each, basic usage activity, and, if you connect a Discord account, your Discord ID, used to combine your ratings across both platforms into one profile.</p>

              <h3 style={{color:G.text,fontSize:'1rem',marginTop:'1.5rem',marginBottom:'0.5rem'}}>What we do with it</h3>
              <p>We use your ratings to find your taste twins and generate recommendations based on what they loved. We use basic usage data to understand what's working and improve the product. If you opt in to data sharing (a separate, optional choice you control in Settings), we may use your anonymized taste data, never your name or identity, to improve our recommendation system and to build future taste-discovery tools, which may include future Kindred products or partnerships with other companies. Opting in is never required to use Kindred, and you can turn it off anytime.</p>

              <h3 style={{color:G.text,fontSize:'1rem',marginTop:'1.5rem',marginBottom:'0.5rem'}}>What we don't do</h3>
              <p>We never sell your name, email, or any way to identify you personally. We never share your individual ratings with other users by name beyond what the product already shows. We don't let any company pay to influence your taste-twin matches or recommendations. If Kindred ever shows advertising in the future, it will be clearly labeled as such and will never affect who you're matched with or what real users' ratings show you.</p>

              <h3 style={{color:G.text,fontSize:'1rem',marginTop:'1.5rem',marginBottom:'0.5rem'}}>Third-party services we use</h3>
              <p>Supabase (database and sign-in), Resend (magic-link emails), TMDB/RAWG/Open Library (search), Anthropic's Claude API (last-resort recommendation fallback only), and Amazon Associates / Bookshop.org (affiliate links, disclosed on the page itself).</p>

              <h3 style={{color:G.text,fontSize:'1rem',marginTop:'1.5rem',marginBottom:'0.5rem'}}>Your controls</h3>
              <p>You can change your data-sharing choice anytime in Settings. You can delete your account anytime in Settings, which permanently removes your ratings, profile, and activity history. You can contact us anytime at <a href="mailto:info@kindredmatch.co" style={{color:G.cyan}}>info@kindredmatch.co</a>.</p>

              <h3 style={{color:G.text,fontSize:'1rem',marginTop:'1.5rem',marginBottom:'0.5rem'}}>Children</h3>
              <p>Kindred is not intended for anyone under 13. We don't knowingly collect data from children under 13.</p>
            </div>
          ) : (
            <div style={{color:G.muted,fontSize:'0.88rem',lineHeight:1.75}}>
              <h3 style={{color:G.text,fontSize:'1rem',marginTop:'1.5rem',marginBottom:'0.5rem'}}>Using Kindred</h3>
              <p>Kindred helps you find people with similar taste in film, TV, games, and books, and get recommendations from them. You need a valid email to sign up. You're responsible for what you post being accurate and not impersonating someone else.</p>

              <h3 style={{color:G.text,fontSize:'1rem',marginTop:'1.5rem',marginBottom:'0.5rem'}}>Acceptable use</h3>
              <p>Don't use Kindred to harass or impersonate other users, attempt to access another user's account, scrape or republish other users' data without permission, or use automated tools to create fake accounts or ratings.</p>

              <h3 style={{color:G.text,fontSize:'1rem',marginTop:'1.5rem',marginBottom:'0.5rem'}}>Account termination</h3>
              <p>We can suspend or remove an account that violates these terms. You can delete your own account anytime in Settings.</p>

              <h3 style={{color:G.text,fontSize:'1rem',marginTop:'1.5rem',marginBottom:'0.5rem'}}>No warranty</h3>
              <p>Kindred is provided as-is. Recommendations are based on real user taste data and, occasionally, AI, and we don't guarantee you'll love everything suggested.</p>

              <h3 style={{color:G.text,fontSize:'1rem',marginTop:'1.5rem',marginBottom:'0.5rem'}}>Affiliate disclosure</h3>
              <p>Some links on Kindred (to Amazon or Bookshop.org) are affiliate links. We may earn a small commission if you make a purchase through them, at no extra cost to you.</p>

              <h3 style={{color:G.text,fontSize:'1rem',marginTop:'1.5rem',marginBottom:'0.5rem'}}>Future advertising</h3>
              <p>Kindred does not currently show ads. If that changes in the future, any advertising will be clearly labeled, will never affect taste-twin matches or recommendations, and this policy will be updated to reflect it before it happens.</p>

              <h3 style={{color:G.text,fontSize:'1rem',marginTop:'1.5rem',marginBottom:'0.5rem'}}>Contact</h3>
              <p>Questions about these terms: <a href="mailto:info@kindredmatch.co" style={{color:G.cyan}}>info@kindredmatch.co</a>.</p>
            </div>
          )}
        </div>
      </div>
    );
  }


  return null;
}
