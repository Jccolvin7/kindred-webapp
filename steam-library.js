export default async function handler(req, res) {
  const { steamid } = req.query;
  if (!steamid) return res.status(400).json({ error: 'Missing Steam profile or ID.' });

  try {
    let resolvedId = steamid.trim();

    // Accept a raw SteamID64 (17 digits) or a full/partial profile URL / vanity name.
    if (!/^\d{17}$/.test(resolvedId)) {
      const vanity = resolvedId
        .replace(/^https?:\/\/(www\.)?steamcommunity\.com\/(id|profiles)\//, '')
        .replace(/\/+$/, '');

      // If what's left is still 17 digits (a /profiles/76561... URL), use it directly.
      if (/^\d{17}$/.test(vanity)) {
        resolvedId = vanity;
      } else {
        const vanityRes = await fetch(
          `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/?key=${process.env.STEAM_API_KEY}&vanityurl=${encodeURIComponent(vanity)}`
        );
        const vanityData = await vanityRes.json();
        if (vanityData.response?.success === 1) {
          resolvedId = vanityData.response.steamid;
        } else {
          return res.status(404).json({ error: 'Could not find that Steam profile. Double-check the URL or ID.' });
        }
      }
    }

    const libRes = await fetch(
      `https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key=${process.env.STEAM_API_KEY}&steamid=${resolvedId}&include_appinfo=true&include_played_free_games=true&format=json`
    );
    const libData = await libRes.json();
    const games = (libData.response?.games || []).map(g => ({
      title: g.name,
      minutes: g.playtime_forever || 0,
    }));

    if (games.length === 0) {
      return res.status(404).json({ error: 'No games found. Your Steam profile or game list may be set to private.' });
    }

    res.status(200).json({ games });
  } catch (e) {
    res.status(500).json({ error: 'Could not reach Steam right now. Try again in a moment.' });
  }
}
