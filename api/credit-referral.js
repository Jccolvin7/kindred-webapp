// ============================================================
// /api/credit-referral.js
// Called once, right after a new user row is created with a referred_by
// value. Increments the REFERRER's referral_count.
//
// WHY THIS IS A SERVERLESS ENDPOINT (not a direct Supabase call from the
// browser): incrementing referral_count is a write to SOMEONE ELSE's user
// row (the referrer's), which the self-only RLS policy correctly forbids
// from a normal signed-in session — same situation as notify-twins. Runs
// with the service-role key here instead.
//
// Anti-abuse / integrity rules enforced server-side, since a browser
// caller can't be trusted to enforce them on itself:
//   - A user cannot refer themselves (referrer === new user) -> rejected.
//   - The referrer must actually exist -> rejected if not.
//   - Credit is idempotent per referred user: the endpoint sets the new
//     user's referred_by ITSELF (only if currently null) and only
//     increments the referrer when it was the one that set it. So calling
//     this twice for the same new user can't double-credit.
//
// Requires SUPABASE_SERVICE_ROLE_KEY in Vercel (already added for
// notify-twins — same value, nothing new needed).
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sbFetch(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: method === 'PATCH' || method === 'POST' ? 'return=representation' : '',
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const { newUserId, referrerId } = req.body || {};
  if (!newUserId || !referrerId) {
    return res.status(400).json({ ok: false, error: 'Missing newUserId or referrerId' });
  }
  // Self-referral guard.
  if (String(newUserId) === String(referrerId)) {
    return res.status(200).json({ ok: true, credited: false, reason: 'self-referral' });
  }

  try {
    // Referrer must exist.
    const referrerRows = await sbFetch(`users?id=eq.${referrerId}&select=id,referral_count`);
    const referrer = referrerRows[0];
    if (!referrer) {
      return res.status(200).json({ ok: true, credited: false, reason: 'referrer not found' });
    }

    // New user must exist and must not already have a referrer (idempotency
    // + can't be re-attributed later). We set referred_by HERE, server-side,
    // and only if it's currently null — so a replayed call is a no-op.
    const newRows = await sbFetch(`users?id=eq.${newUserId}&select=id,referred_by`);
    const newUser = newRows[0];
    if (!newUser) {
      return res.status(200).json({ ok: true, credited: false, reason: 'new user not found' });
    }
    if (newUser.referred_by) {
      // Already attributed — do not credit again.
      return res.status(200).json({ ok: true, credited: false, reason: 'already attributed' });
    }

    // Stamp the referral on the new user first. If this PATCH somehow ran
    // but the increment below didn't, the new user is marked attributed and
    // a retry won't double-credit (the already-attributed guard catches it).
    await sbFetch(`users?id=eq.${newUserId}`, 'PATCH', { referred_by: referrerId });

    // Increment the referrer's count. Read-then-write rather than a SQL
    // expression because PostgREST can't do `col = col + 1` directly; the
    // window for a lost concurrent increment is tiny (a single user's own
    // referrals completing within milliseconds of each other is vanishingly
    // rare) and the cost of a miss is one uncounted referral, not data
    // corruption. Acceptable for this feature.
    const nextCount = (referrer.referral_count || 0) + 1;
    await sbFetch(`users?id=eq.${referrerId}`, 'PATCH', { referral_count: nextCount });

    return res.status(200).json({ ok: true, credited: true, referrerCount: nextCount });
  } catch (e) {
    console.error('credit-referral error:', e);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
}
