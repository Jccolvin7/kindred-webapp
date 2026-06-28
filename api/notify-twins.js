// ============================================================
// /api/notify-twins.js
// Called (fire-and-forget) by the web app right after ANY 4-5 star rating
// is saved. Checks whether the person who just rated something is anyone
// else's #1 Taste Neighbor, and if so, writes a notification row for them.
//
// WHY THIS HAS TO BE A SERVERLESS ENDPOINT, NOT A DIRECT SUPABASE CALL:
// the rater's own browser session can only write rows where user_id is
// their own account (that's the whole point of the RLS policies already
// live on every table). But a notification is inherently a cross-user
// write — User A's rating action creates a row for User B's account. The
// only safe way to do that is server-side, with the service-role key,
// same pattern the bot already uses for /link's account merge.
//
// REQUIRES a new Vercel env var: SUPABASE_SERVICE_ROLE_KEY — the same key
// value already set as SUPABASE_KEY on the Discord bot's Railway project,
// just added here under its own name. This key must NEVER be exposed to
// the browser; it only ever lives in this serverless function's env.
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Resend config for email notifications. The domain (send.kindredmatch.co)
// is already DNS-verified. RESEND_API_KEY must be added to Vercel — without
// it, email simply no-ops (the in-app notification still gets created), so
// the feature degrades gracefully rather than erroring if the key is
// missing or email isn't set up yet.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = 'Kindred <notify@send.kindredmatch.co>';
const APP_URL = 'https://kindredmatch.co';

async function sbFetch(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=representation' : '',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase error (${res.status}): ${err}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

// Sends one "your twin rated something" email via Resend's REST API (no
// SDK needed in a serverless function). Entirely best-effort: any failure
// (missing key, Resend down, bad address) is swallowed so it can never
// affect the in-app notification that already succeeded, or the rating
// that triggered all this. Returns true only if Resend accepted it.
async function sendTwinEmail(toEmail, twinName, itemName, category, rating) {
  if (!RESEND_API_KEY || !toEmail) return false;
  const icon = category === 'film' ? '🎬' : category === 'games' ? '🎮' : '📚';
  const stars = '★'.repeat(rating);
  const subject = `${twinName} just rated ${itemName}`;
  // Plain, single-purpose HTML — one update, one clear link back. Kept
  // deliberately simple: the goal is to pull the person back to the app,
  // not to be a newsletter. Includes a one-line note on how to turn these
  // off, both because it's the right thing and because it helps
  // deliverability/spam reputation.
  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a2e;">
      <p style="font-size: 15px; line-height: 1.5;">
        ${icon} <strong>${twinName}</strong>, your #1 Taste Neighbor, just rated
        <strong>${itemName}</strong> <span style="color:#F59E0B;">${stars}</span>.
      </p>
      <p style="font-size: 15px; line-height: 1.5;">
        It's something you haven't rated yet — which makes it a strong bet for your taste.
      </p>
      <p style="margin: 28px 0;">
        <a href="${APP_URL}" style="background:#7C3AED; color:#fff; text-decoration:none; padding:12px 22px; border-radius:10px; font-size:14px; font-weight:600;">
          See it on Kindred →
        </a>
      </p>
      <p style="font-size: 12px; color: #888; line-height: 1.5;">
        You're getting this because you turned on email updates in Kindred.
        Turn them off anytime in your Settings.
      </p>
    </div>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: EMAIL_FROM, to: toEmail, subject, html }),
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

// Same matchKey convention as kindred-app.jsx and kindred-bot.js — must
// stay identical across all three places or "the same item" stops meaning
// the same thing depending on which code path computed it.
function matchKey(category, itemName) {
  return `${category}:${itemName.toLowerCase()}`;
}

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

// Returns this user's #1 twin's id, or null if they have none yet (below
// the unlock threshold, or zero overlap with anyone). Mirrors
// buildTwinGraph's scoring exactly — score is symmetric (score(A,B) ===
// score(B,A)), which is what makes the reverse-lookup below valid: if A
// is B's #1 twin, that's true regardless of which direction we compute
// the score from.
function findNumberOneTwin(userId, allTastes, rarityWeights) {
  const meKey = String(userId);
  const mine = allTastes.filter(t => String(t.user_id) === meKey);
  if (mine.length === 0) return null;

  const byUser = {};
  allTastes.forEach(t => {
    if (String(t.user_id) === meKey) return;
    if (!byUser[t.user_id]) byUser[t.user_id] = [];
    byUser[t.user_id].push(t);
  });

  let bestId = null;
  let bestScore = 0;
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
    if (overall > bestScore) {
      bestScore = overall;
      bestId = otherId;
    }
  }
  return bestScore > 0 ? bestId : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const { raterId, category, itemName, rating, sourceId } = req.body || {};
  if (!raterId || !category || !itemName || !rating) {
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  }
  // Only 4-5 star ratings are notification-worthy — matches the same
  // "loved it" threshold used everywhere else in the recs/matching engine.
  if (rating < 4) return res.status(200).json({ ok: true, notified: 0, skipped: 'rating below 4' });

  try {
    const allTastes = await sbFetch('tastes?select=user_id,category,item_name,rating,source_id');
    const rarityWeights = computeRarityWeights(allTastes);

    // Resolve the rater's display name once — used as "X just rated..." in
    // any emails sent this run. Fetched here rather than per-recipient
    // since it's the same name for all of them.
    const raterRows = await sbFetch(`users?id=eq.${raterId}&select=username`);
    const raterName = raterRows[0]?.username || 'Your taste twin';

    // Only need to check users who have SOME overlap with the rater at all
    // (computeRarityWeights/findNumberOneTwin already filters to that), so
    // candidate set is naturally small rather than every user on the
    // platform. Each candidate still needs their OWN #1 twin recomputed
    // from scratch (not just "do they overlap with the rater") — being a
    // high match isn't the same as being the highest match.
    const overlapUserIds = new Set();
    allTastes.forEach(t => {
      if (String(t.user_id) !== String(raterId)) overlapUserIds.add(t.user_id);
    });

    const toNotify = [];
    for (const candidateId of overlapUserIds) {
      const top = findNumberOneTwin(candidateId, allTastes, rarityWeights);
      if (top === null || String(top) !== String(raterId)) continue;

      // Don't notify if this candidate has already rated the exact item.
      //
      // FIXED while re-auditing: this previously claimed to check source_id
      // "when available" but never actually did — it always matched on
      // title alone, the exact same leaky-fallback mistake fixed in the web
      // app's setRating earlier today. Concretely: if the rater's new
      // rating has a real sourceId, but the candidate has an existing row
      // for a DIFFERENT item that just happens to share the title text,
      // title-only matching would wrongly treat that as "already rated"
      // and silently skip a notification the candidate should have gotten.
      // Now: when the new rating has a sourceId, ONLY a matching source_id
      // on the candidate's own rows counts as "already rated." Title-only
      // matching is used ONLY when the new rating has no sourceId at all
      // (manual entry, import, or a catalog source with no stable id) —
      // the same narrow, unavoidable fallback case used everywhere else.
      const candidateRatings = allTastes.filter(t => String(t.user_id) === String(candidateId));
      const alreadyRated = sourceId
        ? candidateRatings.some(t => t.source_id === sourceId)
        : candidateRatings.some(t => matchKey(t.category, t.item_name) === matchKey(category, itemName));
      if (alreadyRated) continue;

      toNotify.push(candidateId);
    }

    let notified = 0;
    let emailed = 0;
    for (const recipientId of toNotify) {
      // Dedup: don't create a second notification for the exact same
      // (recipient, twin, item) combination if one already exists. Same
      // check-before-insert discipline used elsewhere in this codebase
      // (logEventOnce, upsertUser, saveRating) rather than relying on a DB
      // constraint that doesn't exist yet.
      const existing = await sbFetch(
        `notifications?user_id=eq.${recipientId}&twin_user_id=eq.${raterId}&category=eq.${encodeURIComponent(category)}&item_name=eq.${encodeURIComponent(itemName)}&select=id&limit=1`
      );
      if (existing.length > 0) continue;

      await sbFetch('notifications', 'POST', {
        user_id: recipientId,
        twin_user_id: raterId,
        category,
        item_name: itemName,
        rating,
        source_id: sourceId || null,
      });
      notified++;

      // Email is OPT-IN and entirely secondary to the in-app notification
      // above (which always happens). Only send if the recipient turned on
      // email_notifications AND we have an address for them. Fetched
      // per-recipient because both the preference and the address live on
      // their user row. Any failure is swallowed inside sendTwinEmail — a
      // bounced or un-sendable email must never roll back the in-app
      // notification we just created.
      try {
        const recipRows = await sbFetch(`users?id=eq.${recipientId}&select=email,email_notifications`);
        const recip = recipRows[0];
        if (recip && recip.email_notifications && recip.email) {
          const sent = await sendTwinEmail(recip.email, raterName, itemName, category, rating);
          if (sent) emailed++;
        }
      } catch (e) { /* email is best-effort; in-app notification already stands */ }
    }

    return res.status(200).json({ ok: true, notified, emailed });
  } catch (e) {
    // Fire-and-forget from the caller's perspective — log server-side but
    // never let a notification failure surface as an error to the rater,
    // who is just trying to save a rating.
    console.error('notify-twins error:', e);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
}
