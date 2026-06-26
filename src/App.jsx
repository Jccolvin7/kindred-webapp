import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";
import Papa from "papaparse";

const G = {
  bg:'#080B16', deep:'#0D1120', card:'rgba(255,255,255,0.04)',
  border:'rgba(255,255,255,0.08)', purple:'#8B5CF6', purpleDim:'rgba(139,92,246,0.12)',
  cyan:'#06B6D4', amber:'#F59E0B', green:'#10B981', pink:'#EC4899',
  text:'#F1F5F9', muted:'#94A3B8', dim:'#475569',
};

const FONTS = `@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;1,300;1,400&family=Space+Mono&display=swap');`;
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

// ─── ARCHETYPE — 3-AXIS COMBINATORIAL SYSTEM ─────────────────
// Mood + dominant category + behavior, each computed independently from real
// rating data, so two very different users won't land on the same label.
// Mood and category get their own separate color palettes (pink/rose family
// vs purple/red/amber/cyan/green/blue/yellow) so the two can never visually
// collide on the same card, by construction rather than by runtime checking.

const MOOD_WORDS_SAFE = ['Chaotic','Feral','Unhinged','Niche']; // won't date
const MOOD_WORDS_FUN = ['Unwell','Delulu','Touch-Grass-Resistant','Insufferable']; // spicier, may date faster
const MOOD_COLORS = {
  Chaotic:'#EC4899', Feral:'#E11D48', Unhinged:'#DB2777', Niche:'#F472B6',
  Unwell:'#FB7185', Delulu:'#F0ABFC', 'Touch-Grass-Resistant':'#FDA4AF', Insufferable:'#FB7185',
};

const CATEGORY_COLORS = {
  'Sci-Fi':'#8B5CF6', Horror:'#EF4444', 'Literary Fiction':'#F59E0B', 'Strategy Games':'#06B6D4',
  'Prestige Drama':'#A78BFA', Fantasy:'#10B981', Indie:'#FBBF24', Action:'#3B82F6',
};

// Best-effort keyword match against real rated titles. With the catalog now
// fully open (real search, not a fixed list), this won't catch everything —
// that's expected. No match at all just means the mood axis reads as "Niche."
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

function pickBehaviorAxis(ratings) {
  const counts = { film: Object.keys(ratings.film).length, games: Object.keys(ratings.games).length, books: Object.keys(ratings.books).length };
  const total = counts.film + counts.games + counts.books;
  const allVals = [...Object.values(ratings.film), ...Object.values(ratings.games), ...Object.values(ratings.books)].filter(Boolean);
  const avg = allVals.length ? allVals.reduce((a,b) => a+b, 0) / allVals.length : 0;
  const minCount = Math.min(counts.film, counts.games, counts.books);
  const maxCount = Math.max(counts.film, counts.games, counts.books);

  if (total >= 15 && minCount >= 3) return 'Collector';
  if (maxCount >= 8 && total > 0 && (maxCount / total) >= 0.7) return 'Completionist';
  if (total > 0 && total <= 8 && avg >= 4.3) return 'Connoisseur';
  return 'Explorer';
}

function pickMoodAxis(seed, category, behavior, matchedKeywords, totalRated) {
  if (totalRated > 0 && matchedKeywords === 0) return 'Niche'; // didn't match any common-title list — genuinely obscure taste
  if (category === 'Horror' || category === 'Action') return hashPick(seed + category, ['Feral','Unhinged']);
  if (behavior === 'Collector' || behavior === 'Explorer') return 'Chaotic';
  return hashPick(seed, MOOD_WORDS_SAFE);
}

function buildArchetype(seed, ratings) {
  const total = Object.keys(ratings.film).length + Object.keys(ratings.games).length + Object.keys(ratings.books).length;
  const { category, matched } = pickCategoryAxis(ratings);
  const behavior = pickBehaviorAxis(ratings);
  const mood = pickMoodAxis(seed, category, behavior, matched, total);
  return { mood, category, behavior, moodColor: MOOD_COLORS[mood] || G.pink, categoryColor: CATEGORY_COLORS[category] || G.purple };
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
// NOTE: assumes /api/search-books returns an `isbn` field per result (it's
// backed by Open Library, which exposes ISBNs) — verify this matches your
// actual endpoint response shape; if the field is named differently, fix it
// here in this one place.
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

// Rare shared titles should count more toward a match than mainstream ones.
// Weight runs from 0.3 (almost everyone has rated it) up to 3 (almost nobody else has).
function computeRarityWeights(allTastes) {
  const raterSets = {};
  allTastes.forEach(t => {
    const key = `${t.category}:${t.item_name}`;
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
  if (top.length === 1) return `Matched mostly on ${top[0]} — not many people have rated that one.`;
  const last = top.pop();
  return `Matched mostly on ${top.join(', ')} and ${last} — rare picks that few others share.`;
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
  const mine = allTastes.filter(t => t.user_id === myUserId);
  const byUser = {};
  allTastes.forEach(t => {
    if (t.user_id === myUserId) return;
    if (!byUser[t.user_id]) byUser[t.user_id] = [];
    byUser[t.user_id].push(t);
  });

  const candidates = [];
  for (const otherId in byUser) {
    const theirs = byUser[otherId];
    const weightedSims = [];
    mine.forEach(m => {
      const match = theirs.find(t => t.category === m.category && t.item_name === m.item_name);
      if (match) {
        const sim = 1 - Math.abs(m.rating - match.rating) / 4;
        const weight = rarityWeights[`${m.category}:${m.item_name}`] || 1;
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
  const mineKeys = new Set(mine.map(t => `${t.category}:${t.item_name}`));
  const topTwins = candidates.slice(0, 10); // consider top 10 twins, not just the top 5 shown on the Twins screen

  const itemMap = {};
  topTwins.forEach(twin => {
    twin.ratings.forEach(r => {
      if (r.rating < 4) return;
      const key = `${r.category}:${r.item_name}`;
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
  const mineKeys = new Set(mine.map(t => `${t.category}:${t.item_name}`));
  const directTwins = candidates.slice(0, 10);
  const directTwinIds = new Set(directTwins.map(t => t.id));
  const directTwinItemKeys = new Set();
  directTwins.forEach(t => t.ratings.forEach(r => directTwinItemKeys.add(`${r.category}:${r.item_name}`)));

  const secondDegree = {}; // userId -> { score, ratings }, deduped across direct twins
  directTwins.forEach(twin => {
    const { candidates: theirTwins } = buildTwinGraph(twin.id, allTastes);
    theirTwins.slice(0, 5).forEach(t2 => {
      if (t2.id === myUserId || directTwinIds.has(t2.id)) return;
      if (!secondDegree[t2.id]) secondDegree[t2.id] = { score: t2.overall, ratings: t2.ratings };
    });
  });

  const itemMap = {};
  Object.values(secondDegree).forEach(({ score, ratings }) => {
    ratings.forEach(r => {
      if (r.rating < 4) return;
      const key = `${r.category}:${r.item_name}`;
      if (mineKeys.has(key) || directTwinItemKeys.has(key) || excludeKeys.has(key)) return;
      if (!itemMap[key]) itemMap[key] = { category: r.category, item_name: r.item_name, scores: [] };
      itemMap[key].scores.push(score);
    });
  });

  const scored = Object.values(itemMap).map(entry => {
    const count = entry.scores.length;
    const avgScore = entry.scores.reduce((a, b) => a + b, 0) / count;
    const rarityWeight = rarityWeights[`${entry.category}:${entry.item_name}`] || 1;
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

  const mineKeys = new Set(allTastes.filter(t => t.user_id === myUserId).map(t => `${t.category}:${t.item_name}`));
  const itemMap = {};
  allTastes.forEach(t => {
    if (!peerIds.has(t.user_id) || t.rating < 4) return;
    const key = `${t.category}:${t.item_name}`;
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
  const mineKeys = new Set(allTastes.filter(t => t.user_id === myUserId).map(t => `${t.category}:${t.item_name}`));
  const itemMap = {};
  allTastes.forEach(t => {
    if (t.user_id === myUserId || t.rating < 4) return;
    const key = `${t.category}:${t.item_name}`;
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
    const label = `${archetype.mood} ${archetype.category} ${archetype.behavior}`;
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
  const [subscribeEmail, setSubscribeEmail] = useState(true);
  const [checkingSession, setCheckingSession] = useState(true);
  const [linkSent, setLinkSent] = useState(false);
  const [pendingAuthUser, setPendingAuthUser] = useState(null);

  const [ratings, setRatings] = useState({film:{},games:{},books:{}});
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
        const { data: saved } = await supabase.from('tastes').select('category, item_name, rating').eq('user_id', row.id);
        if (saved && saved.length) {
          const loaded = { film:{}, games:{}, books:{} };
          saved.forEach(t => { if (loaded[t.category]) loaded[t.category][t.item_name] = t.rating; });
          setRatings(loaded);
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

  async function requestMagicLink() {
    setAuthError(null);
    if (!email || !email.includes('@')) { setAuthError('Enter a valid email.'); return; }
    setAuthLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) throw error;
      setLinkSent(true);
    } catch (e) {
      setAuthError('Could not send the link. Check your connection and try again.');
    }
    setAuthLoading(false);
  }

  async function completeNewAccountSetup() {
    setAuthError(null);
    setAuthLoading(true);
    try {
      const { data: created, error } = await supabase.from('users').insert({
        auth_id: pendingAuthUser.id,
        email: pendingAuthUser.email,
        username: username || pendingAuthUser.email.split('@')[0],
        subscribe_weekly_email: subscribeEmail,
      }).select().single();
      if (error) throw error;
      logEvent(created.id, 'signup_completed');
      touchLastActive(created.id);
      setUserId(created.id);
      setStep('quiz');
    } catch (e) {
      setAuthError('Could not finish setting up your account. Try again.');
    }
    setAuthLoading(false);
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
  async function setRating(domain, title, val) {
    const newVal = ratings[domain][title] === val ? undefined : val;
    const nextRatings = {...ratings, [domain]: {...ratings[domain], [title]: newVal}};
    setRatings(nextRatings);
    if (!userId) return;
    if (newVal !== undefined) touchLastActive(userId);
    try {
      if (newVal === undefined) {
        await supabase.from('tastes').delete()
          .eq('user_id', userId).eq('category', domain).eq('item_name', title);
        return;
      }
      const { data: existing } = await supabase
        .from('tastes').select('id')
        .eq('user_id', userId).eq('category', domain).eq('item_name', title).maybeSingle();
      if (existing) {
        await supabase.from('tastes').update({ rating: newVal }).eq('id', existing.id);
      } else {
        await supabase.from('tastes').insert({ user_id: userId, category: domain, item_name: title, rating: newVal });
      }
      // Keep the archetype on file fresh so Tier 3 (archetype trending) has
      // accurate data for this user going forward. Fire-and-forget.
      saveArchetypeForUser(userId, nextRatings);
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
      const fresh = items.filter(i => i.title && i.rating >= 1 && !existingTitles.has(i.title.toLowerCase()));
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
          const match = theirs.find(t => t.category === m.category && t.item_name === m.item_name);
          if (match) {
            const sim = 1 - Math.abs(m.rating - match.rating) / 4;
            const weight = rarityWeights[`${m.category}:${m.item_name}`] || 1;
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
        const mineMap = {}; mine.forEach(t => { mineMap[`${t.category}:${t.item_name}`] = t.rating; });
        const theirMap = {}; theirs.forEach(t => { theirMap[`${t.category}:${t.item_name}`] = t.rating; });
        const shared = mine.filter(t => theirMap[`${t.category}:${t.item_name}`] !== undefined && t.rating >= 4 && theirMap[`${t.category}:${t.item_name}`] >= 4)
          .map(t => {
            const key = `${t.category}:${t.item_name}`;
            return { title: t.item_name, mine: t.rating, theirs: theirMap[key], weight: rarityWeights[key] || 1 };
          })
          .sort((a,b)=>b.weight-a.weight).slice(0,4);
        const onlyMine = mine.filter(t => !theirMap[`${t.category}:${t.item_name}`] && t.rating >= 4).slice(0,3);
        const onlyTheirs = theirs.filter(t => !mineMap[`${t.category}:${t.item_name}`] && t.rating >= 4).slice(0,3);
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
      if (top.length > 0) logEventOnce(userId, 'first_match_unlocked', `${top[0].overall}%`);
    } catch (e) {
      setTwinsError('Could not load taste twins. Check your connection and try again.');
    }
    setTwinsLoading(false);
  }

  useEffect(() => {
    if (step === 'twins' && realTwins === null && !twinsLoading && totalRated() >= TWIN_UNLOCK_THRESHOLD) fetchRealTwins();
  }, [step]);

  async function sharePassport(level, archetype, total) {
    const archetypeLabel = `${archetype.mood} ${archetype.category} ${archetype.behavior}`;
    const lines = [
      'My Kindred Taste Passport',
      archetypeLabel,
      `Level: ${level}`,
      `${total} items rated across film, games, and books`,
      '',
      'Find your own taste twin at kindredmatch.co',
    ];
    const text = lines.join('\n');
    logEvent(userId, 'taste_passport_shared', archetypeLabel);
    if (navigator.share) { try { await navigator.share({ text, title: 'My Kindred Taste Passport' }); return; } catch (e) {} }
    try { await navigator.clipboard.writeText(text); setCopiedId('passport'); setTimeout(()=>setCopiedId(null), 2000); } catch (e) {}
  }

  // SHARE
  async function shareTwin(twin) {
    const lines = [`Kindred Taste Twin Match: ${twin.overall}%`, `Matched with ${twin.handle}`];
    if (twin.why) lines.push(twin.why);
    if (twin.shared?.length) { lines.push('', 'We both loved:'); twin.shared.forEach(s => lines.push(`- ${s.title}`)); }
    lines.push('', 'Find your taste twin at kindredmatch.co');
    const text = lines.join('\n');
    logEvent(userId, 'twin_card_shared', `${twin.overall}%`);
    if (navigator.share) { try { await navigator.share({ text, title: 'My Kindred Taste Twin' }); return; } catch (e) {} }
    try { await navigator.clipboard.writeText(text); setCopiedId(twin.id); setTimeout(()=>setCopiedId(null), 2000); } catch (e) {}
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
      const addToExclude = (items) => items.forEach(i => excludeKeys.add(`${i.category}:${i.item_name}`));
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

      const finalRecs = combined.map((item) => {
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
          reason = `Trending across all of Kindred — ${item.count} people rated it ${item.avgRating.toFixed(1)}★ on average`;
          matchScore = Math.round(item.avgRating * 20);
          tierLabel = 'Kindred Trending';
        }
        return { title: item.item_name, type, reason, matchScore, tier: item.tier, tierLabel };
      });

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
      return (parsed.recommendations || []).map(r => ({ ...r, tier: 5, tierLabel: 'Beyond Your Taste Network' }));
    } catch (e) {
      return [];
    }
  }

  // STYLES
  const s = {
    app:{minHeight:'100vh',background:G.bg,color:G.text,fontFamily:"'Inter',system-ui,sans-serif"},
    center:{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',minHeight:'100vh',padding:'2rem',textAlign:'center'},
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
    .k-btn:hover{background:#7C3AED!important;transform:translateY(-1px)}
    .k-out:hover{border-color:rgba(255,255,255,0.2)!important;color:#F1F5F9!important}
    .k-tab:hover{border-color:rgba(255,255,255,0.15)!important}
    .k-result:hover{border-color:rgba(255,255,255,0.15)!important;background:rgba(255,255,255,0.06)!important}
    .k-star:hover{transform:scale(1.2)!important}
    .k-twin:hover{border-color:rgba(139,92,246,0.3)!important;transform:translateY(-2px)}
    .k-rec:hover{border-color:rgba(139,92,246,0.25)!important}
    .slide-in{animation:slideIn 0.4s ease forwards}
    .fade-up{animation:fadeUp 0.4s ease forwards}
    .k-input:focus{border-color:#8B5CF6!important;outline:none}
    .k-search:focus{border-color:#8B5CF6!important;outline:none}
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
    <div style={s.app}>
      <style>{FONTS+css}</style>
      <div style={s.center}>
        <div style={{fontFamily:"'Cormorant Garamond',serif",fontSize:'2rem',fontWeight:500,marginBottom:'2.5rem',letterSpacing:'0.06em'}}>
          Kind<span style={{color:G.purple}}>r</span>ed
        </div>
        <h1 style={s.h1}>Find your<br/><em style={{color:G.purple,fontStyle:'italic'}}>taste twin.</em></h1>
        <p style={{color:G.muted,lineHeight:1.75,fontSize:'1rem',maxWidth:460,margin:'0 auto 2.25rem'}}>
          Someone who actually gets your taste in movies, shows, books, and games. Get recommendations from them — not an algorithm.
        </p>

        {linkSent ? (
          <div style={{maxWidth:340,width:'100%'}}>
            <div style={{fontSize:'1.75rem',marginBottom:'1rem'}}>📬</div>
            <p style={{color:G.text,fontSize:'0.95rem',marginBottom:'0.5rem',fontWeight:500}}>Check your email</p>
            <p style={{color:G.muted,fontSize:'0.85rem',lineHeight:1.6,marginBottom:'1.25rem'}}>We sent a sign-in link to <strong style={{color:G.text}}>{email}</strong>. Open it on this device to continue.</p>
            <button onClick={()=>setLinkSent(false)} style={{background:'none',border:'none',color:G.dim,fontSize:'0.78rem',cursor:'pointer',fontFamily:'inherit',textDecoration:'underline'}}>Use a different email</button>
          </div>
        ) : (
          <div style={{maxWidth:340,width:'100%'}}>
            <input className="k-input" style={s.input} type="email" placeholder="your@email.com"
              value={email} onChange={e=>setEmail(e.target.value)}
              onKeyDown={e=>e.key==='Enter'&&requestMagicLink()} />
            {authError && <div style={{color:'#FCA5A5',fontSize:'0.78rem',marginBottom:'0.75rem'}}>{authError}</div>}
            <button className="k-btn" style={{...s.btn,transition:'all 0.2s',opacity:authLoading?0.6:1}}
              onClick={requestMagicLink} disabled={authLoading}>
              {authLoading ? 'Sending...' : 'Send me a sign-in link →'}
            </button>
          </div>
        )}
        <p style={{color:G.dim,fontSize:'0.76rem',marginTop:'1rem'}}>No password needed. We'll email you a one-click link.</p>
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
        <h2 style={s.h2}>You're verified — almost there</h2>
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
                const userRating = currentRatings[item.title] || 0;
                const hk = `${quizDomain}:${item.title}`;
                const hovered = hoveredStar[hk] || 0;
                return (
                  <div key={idx} className="k-result" style={{
                    background:G.card,border:`1px solid ${userRating?domInfo.color+'44':G.border}`,
                    borderRadius:12,padding:'0.75rem 1rem',display:'flex',alignItems:'center',gap:'0.875rem',
                    transition:'all 0.2s',cursor:'default'
                  }}>
                    {item.poster && <img src={item.poster} alt="" style={{width:36,height:52,objectFit:'cover',borderRadius:4,flexShrink:0}} onError={e=>e.target.style.display='none'} />}
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
                            onClick={()=>setRating(quizDomain,item.title,star)}
                            onMouseEnter={()=>setHoveredStar(h=>({...h,[hk]:star}))}
                            onMouseLeave={()=>setHoveredStar(h=>({...h,[hk]:0}))}
                            style={{background:'none',border:'none',cursor:'pointer',fontSize:'1rem',padding:'0.1rem',
                              transition:'transform 0.12s',lineHeight:1,color:filled?domInfo.color:'rgba(255,255,255,0.2)'}}>
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
                    <span style={{color:domInfo.color,fontSize:'0.78rem',fontFamily:'Space Mono,monospace',flexShrink:0}}>{'★'.repeat(stars)}{'☆'.repeat(5-stars)}</span>
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
                  <li>Click <strong style={{color:G.text}}>Export Your Data</strong> — a ZIP file downloads</li>
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
                    <span>{it.title}</span><span style={{color:G.purple,fontFamily:'Space Mono,monospace'}}>{'★'.repeat(it.rating)}</span>
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
                  Steam has no star ratings — only playtime. Your Steam profile and game list also need to be set to <strong style={{color:G.text}}>Public</strong> (Steam → Settings → Privacy Settings), or we won't be able to see your library at all.
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
              {importStatus.skipped>0 && <p style={{color:G.dim,fontSize:'0.78rem',marginBottom:'1rem'}}>{importStatus.skipped} skipped — already rated</p>}
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

    return (
      <div style={s.app}>
        <style>{FONTS+css}</style>
        <div style={{maxWidth:560,margin:'0 auto',padding:'2.5rem 1.5rem'}} className="slide-in">

          {/* PASSPORT CARD */}
          <div style={{background:`linear-gradient(135deg, ${G.purpleDim}, rgba(6,182,212,0.06))`,border:`1px solid rgba(139,92,246,0.25)`,borderRadius:20,padding:'1.75rem 1.5rem',marginBottom:'1.25rem',position:'relative',overflow:'hidden'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:'1rem'}}>
              <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.6rem',color:G.purple,textTransform:'uppercase',letterSpacing:'0.12em'}}>Taste Passport</div>
              <div style={{background:'rgba(139,92,246,0.18)',border:'1px solid rgba(139,92,246,0.3)',borderRadius:100,padding:'0.25rem 0.75rem',fontSize:'0.68rem',color:'#C4B5D9',fontFamily:'Space Mono,monospace'}}>{level}</div>
            </div>
            <h2 style={{...s.h2,marginBottom:'0.4rem',fontSize:'clamp(1.5rem,3.5vw,2.1rem)'}}>
              <span style={{color:archetype.moodColor}}>{archetype.mood}</span>{' '}
              <span style={{color:archetype.categoryColor}}>{archetype.category}</span>{' '}
              <span>{archetype.behavior}</span>
            </h2>
            <p style={{color:G.muted,fontSize:'0.82rem',marginBottom:'1.25rem'}}>{total} items rated across film, games, and books</p>
            <CompletionWidget ratings={ratings} />
            <div style={{marginBottom:'1.25rem'}}>
              <div style={{display:'flex',justifyContent:'space-between',fontSize:'0.7rem',color:G.muted,marginBottom:'0.4rem'}}>
                <span>Profile Freshness</span>
                <span style={{fontFamily:'Space Mono,monospace',color:fresh.pct===100?G.green:G.amber}}>{fresh.pct}%</span>
              </div>
              <div style={{height:4,background:'rgba(255,255,255,0.08)',borderRadius:2,overflow:'hidden',marginBottom:'0.5rem'}}>
                <div style={{height:'100%',width:`${fresh.pct}%`,background:fresh.pct===100?G.green:G.amber,borderRadius:2,transition:'width 0.6s ease'}}/>
              </div>
              <p style={{color:G.dim,fontSize:'0.72rem',margin:0}}>
                {fresh.remaining===0 ? 'Your profile is fresh!' : `Rate ${fresh.remaining} more thing${fresh.remaining===1?'':'s'} to refresh it.`}
              </p>
            </div>
            <button onClick={()=>sharePassport(level,archetype,total)} style={{width:'100%',background:'transparent',border:`1px solid rgba(139,92,246,0.3)`,color:copiedId==='passport'?G.green:'#C4B5D9',padding:'0.6rem',borderRadius:10,fontSize:'0.78rem',cursor:'pointer',fontFamily:'inherit',transition:'all 0.2s'}}>
              {copiedId==='passport' ? '✓ Copied — paste it anywhere' : '🔗 Share My Taste Passport'}
            </button>
          </div>

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
              {tags.map(t=>(<span key={t} style={{background:G.purpleDim,border:'1px solid rgba(139,92,246,0.2)',color:'#C4B5D9',padding:'0.35rem 0.875rem',borderRadius:100,fontSize:'0.76rem'}}>{t}</span>))}
            </div>
          </div>
          <div style={{display:'flex',gap:'0.75rem',marginBottom:'1rem'}}>
            <button className="k-out" style={{...s.outBtn,transition:'all 0.2s'}} onClick={()=>setStep('quiz')}>Rate More</button>
            <button className="k-btn" style={{...s.btn,transition:'all 0.2s'}} onClick={()=>setStep('twins')}>
              {total >= TWIN_UNLOCK_THRESHOLD ? 'Find My Taste Twins →' : `🔒 Unlock Twin (${TWIN_UNLOCK_THRESHOLD - total} more)`}
            </button>
          </div>
          <button onClick={handleSignOut} style={{background:'none',border:'none',color:G.dim,fontSize:'0.74rem',cursor:'pointer',fontFamily:'inherit',width:'100%',textAlign:'center',padding:'0.5rem'}}>Sign out</button>
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
            <div style={{fontSize:'2.5rem',marginBottom:'1.25rem'}}>🔒</div>
            <h2 style={s.h2}>Your first twin is close</h2>
            <p style={{color:G.muted,fontSize:'0.9rem',lineHeight:1.7,maxWidth:380,margin:'0 auto 1.75rem'}}>
              Rate {remaining} more thing{remaining===1?'':'s'} to unlock your first twin. We hold off until there's enough signal for a match that actually feels right.
            </p>
            <div style={{maxWidth:280,width:'100%',margin:'0 auto 1.75rem'}}>
              <div style={{height:5,background:'rgba(255,255,255,0.06)',borderRadius:3,overflow:'hidden'}}>
                <div style={{height:'100%',width:`${Math.round((totalNow/TWIN_UNLOCK_THRESHOLD)*100)}%`,background:G.cyan,borderRadius:3,transition:'width 0.6s ease'}}/>
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
              <div style={{fontSize:'1.75rem',marginBottom:'0.75rem'}}>🔍</div>
              <div style={{fontWeight:500,marginBottom:'0.5rem'}}>No taste twins yet</div>
              <p style={{color:G.muted,fontSize:'0.83rem',lineHeight:1.6}}>Nobody else has rated the same titles as you yet. Share Kindred with friends — the more people who rate, the better the matches.</p>
            </div>
          )}
          {!twinsLoading && realTwins && realTwins.length > 0 && (
            <div style={{display:'flex',flexDirection:'column',gap:'0.875rem',marginBottom:'1.25rem'}}>
              {realTwins.map(twin => (
                <div key={twin.id} className="k-twin" style={{...s.card,transition:'all 0.2s',cursor:'default'}}>
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'1.25rem'}}>
                    <div style={{display:'flex',alignItems:'center',gap:'0.875rem'}}>
                      <div style={{width:44,height:44,borderRadius:'50%',background:'rgba(139,92,246,0.15)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'1.15rem',flexShrink:0}}>🧬</div>
                      <div>
                        <div style={{fontWeight:500,fontSize:'0.88rem'}}>{twin.handle}</div>
                        <div style={{color:G.dim,fontSize:'0.73rem',marginTop:'0.15rem'}}>{twin.overlap} titles in common</div>
                      </div>
                    </div>
                    <div style={{textAlign:'right',flexShrink:0,marginLeft:'0.875rem'}}>
                      <div style={{fontFamily:'Space Mono,monospace',fontSize:'1.65rem',color:G.purple,fontWeight:700,lineHeight:1}}>{twin.overall}%</div>
                      <div style={{fontSize:'0.65rem',color:G.dim}}>match</div>
                    </div>
                  </div>
                  {twin.why && (
                    <div style={{background:'rgba(139,92,246,0.06)',border:'1px solid rgba(139,92,246,0.15)',borderRadius:10,padding:'0.7rem 0.875rem',marginBottom:'1rem',fontSize:'0.78rem',color:'#C4B5D9',lineHeight:1.5}}>
                      💡 {twin.why}
                    </div>
                  )}
                  <div style={{display:'flex',gap:'0.5rem',marginBottom:twin.shared?.length?'1rem':'0'}}>
                    {DOMAINS.map(d => twin.domains[d.key]!==null && (
                      <div key={d.key} style={{flex:1,background:'rgba(255,255,255,0.03)',borderRadius:8,padding:'0.5rem',textAlign:'center'}}>
                        <div style={{fontSize:'0.8rem',marginBottom:'0.2rem'}}>{d.icon}</div>
                        <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.7rem',color:G.purple,fontWeight:700}}>{twin.domains[d.key]}%</div>
                      </div>
                    ))}
                  </div>
                  {twin.shared?.length > 0 && (
                    <div style={{marginBottom:'0.875rem'}}>
                      <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.6rem',color:G.dim,textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:'0.5rem'}}>You both loved</div>
                      <div style={{display:'flex',flexWrap:'wrap',gap:'0.4rem'}}>
                        {twin.shared.map((s,i)=>(<span key={i} style={{background:G.purpleDim,border:'1px solid rgba(139,92,246,0.2)',color:'#C4B5D9',padding:'0.25rem 0.7rem',borderRadius:100,fontSize:'0.7rem'}}>{s.title}</span>))}
                      </div>
                    </div>
                  )}
                  <button onClick={()=>shareTwin(twin)} style={{width:'100%',background:'transparent',border:`1px solid ${G.border}`,color:copiedId===twin.id?G.green:G.muted,padding:'0.6rem',borderRadius:10,fontSize:'0.78rem',cursor:'pointer',fontFamily:'inherit',transition:'all 0.2s'}}>
                    {copiedId===twin.id ? '✓ Copied — paste it anywhere' : '🔗 Share this match'}
                  </button>
                </div>
              ))}
            </div>
          )}
          <button className="k-btn" style={{...s.btn,transition:'all 0.2s'}} onClick={()=>setStep('recs')}>Get AI Recommendations →</button>
        </div>
      </div>
    );
  }

  // ─── RECOMMENDATIONS ───────────────────────────────────────
  if (step === 'recs') {
    const typeMap = {film:{label:'Film',color:G.purple,icon:'🎬'},show:{label:'Show',color:G.pink,icon:'📺'},game:{label:'Game',color:G.cyan,icon:'🎮'},book:{label:'Book',color:G.amber,icon:'📚'}};
    const tierColors = { 1:G.purple, 2:G.cyan, 3:G.amber, 4:G.green };
    async function handleBuyClick(rec) {
      logEvent(userId,'affiliate_link_clicked',`${rec.type}:${rec.title}`);
      const href = await buildAffiliateLink(rec.type, rec.title);
      window.open(href, '_blank', 'noopener,noreferrer');
    }
    const hasRealRecs = recs && recs.length > 0;
    const headerEyebrow = hasRealRecs ? 'BASED ON REAL TASTE TWINS' : 'AI-POWERED · CROSS-DOMAIN';
    const headerSub = hasRealRecs
      ? 'From people who actually match your taste — not an algorithm guessing.'
      : "Based on everything you've rated across all domains.";
    return (
      <div style={s.app}>
        <style>{FONTS+css}</style>
        <div style={{maxWidth:620,margin:'0 auto',padding:'2.5rem 1.5rem'}} className="slide-in">
          <div style={{textAlign:'center',marginBottom:'2.25rem'}}>
            <div style={{...s.eyebrow,color:G.purple}}>{headerEyebrow}</div>
            <h2 style={s.h2}>Made for your taste</h2>
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
              <p style={{color:G.dim,fontSize:'0.7rem',lineHeight:1.5,marginBottom:'1rem'}}>Kindred earns a small commission on purchases through these links, at no extra cost to you.</p>
              {hasRealRecs && (
                <div style={{display:'flex',flexDirection:'column',gap:'0.75rem',marginBottom:'1.25rem'}}>
                  {recs.map((rec,i)=>{
                    const cfg=typeMap[rec.type]||typeMap.film;
                    const tierColor = tierColors[rec.tier] || G.purple;
                    return (
                      <div key={i} className="k-rec" style={{...s.card,transition:'all 0.2s'}}>
                        <div style={{display:'flex',gap:'1rem',alignItems:'flex-start'}}>
                          <span style={{fontSize:'1.5rem',flexShrink:0,paddingTop:'0.05rem'}}>{cfg.icon}</span>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{display:'flex',alignItems:'center',gap:'0.625rem',marginBottom:'0.3rem',flexWrap:'wrap'}}>
                              <span style={{fontWeight:600,fontSize:'0.92rem'}}>{rec.title}</span>
                              <span style={{background:`${cfg.color}20`,color:cfg.color,padding:'0.12rem 0.6rem',borderRadius:100,fontSize:'0.62rem',fontFamily:'Space Mono,monospace'}}>{cfg.label}</span>
                            </div>
                            <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.6rem',color:tierColor,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:'0.35rem'}}>{rec.tierLabel}</div>
                            <p style={{color:G.muted,fontSize:'0.8rem',lineHeight:1.6,margin:0}}>{rec.reason}</p>
                          </div>
                          <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.82rem',color:G.purple,fontWeight:700,flexShrink:0}}>{rec.matchScore}%</div>
                        </div>
                        <button onClick={()=>handleBuyClick(rec)} style={{display:'inline-flex',alignItems:'center',gap:'0.4rem',marginTop:'0.75rem',marginLeft:'2.5rem',color:G.cyan,fontSize:'0.76rem',background:'none',border:'none',cursor:'pointer',fontFamily:'inherit',padding:0}}>
                          🛒 {rec.type==='book' ? 'Find it on Bookshop' : 'Find it on Amazon'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              {!hasRealRecs && aiFallbackRecs && aiFallbackRecs.length === 0 && (
                <div style={{...s.card,textAlign:'center',marginBottom:'1.25rem'}}>
                  <div style={{fontSize:'1.75rem',marginBottom:'0.75rem'}}>🌱</div>
                  <div style={{fontWeight:500,marginBottom:'0.5rem'}}>Your taste network is still growing</div>
                  <p style={{color:G.muted,fontSize:'0.83rem',lineHeight:1.6}}>Nobody with overlapping taste has rated enough yet. Rate a few more things or share Kindred with friends — real recs come from real people here.</p>
                </div>
              )}
              {!hasRealRecs && aiFallbackRecs && aiFallbackRecs.length > 0 && (
                <div style={{marginBottom:'1.25rem'}}>
                  <div style={{display:'flex',alignItems:'center',gap:'0.5rem',marginBottom:'0.75rem'}}>
                    <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.65rem',color:G.dim,textTransform:'uppercase',letterSpacing:'0.1em'}}>Beyond Your Taste Network</div>
                    <div style={{flex:1,height:1,background:G.border}}/>
                  </div>
                  <p style={{color:G.dim,fontSize:'0.72rem',lineHeight:1.5,marginBottom:'0.75rem'}}>No human taste-twin matches yet, so these are AI-generated guesses based only on your own ratings — lower trust than picks above this line.</p>
                  <div style={{display:'flex',flexDirection:'column',gap:'0.75rem'}}>
                    {aiFallbackRecs.map((rec,i)=>{
                      const cfg=typeMap[rec.type]||typeMap.film;
                      return (
                        <div key={i} className="k-rec" style={{...s.card,border:`1px dashed ${G.border}`,transition:'all 0.2s'}}>
                          <div style={{display:'flex',gap:'1rem',alignItems:'flex-start'}}>
                            <span style={{fontSize:'1.5rem',flexShrink:0,paddingTop:'0.05rem'}}>{cfg.icon}</span>
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


  return null;
}
