export default async function handler(req, res) {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.status(400).json({ results: [] });

  try {
    const response = await fetch(
      `https://api.rawg.io/api/games?key=${process.env.RAWG_API_KEY}&search=${encodeURIComponent(q)}&page_size=10&ordering=-rating`
    );
    const data = await response.json();

    const results = (data.results || []).slice(0, 8).map(g => ({
      title: g.name,
      year: g.released ? g.released.slice(0, 4) : null,
      type: 'game',
      overview: g.genres ? g.genres.map(x => x.name).join(', ') : '',
      poster: g.background_image || null,
    }));

    res.status(200).json({ results });
  } catch (e) {
    res.status(500).json({ results: [], error: 'Search failed' });
  }
}
