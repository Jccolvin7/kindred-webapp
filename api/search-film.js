export default async function handler(req, res) {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.status(400).json({ results: [] });

  try {
    const [movieRes, tvRes] = await Promise.all([
      fetch(`https://api.themoviedb.org/3/search/movie?api_key=${process.env.TMDB_API_KEY}&query=${encodeURIComponent(q)}&page=1`),
      fetch(`https://api.themoviedb.org/3/search/tv?api_key=${process.env.TMDB_API_KEY}&query=${encodeURIComponent(q)}&page=1`)
    ]);

    const movies = await movieRes.json();
    const tv = await tvRes.json();

    const results = [
      ...(movies.results || []).slice(0, 6).map(m => ({
        title: m.title,
        year: m.release_date ? m.release_date.slice(0, 4) : null,
        type: 'film',
        overview: m.overview ? m.overview.slice(0, 120) + '...' : '',
        poster: m.poster_path ? `https://image.tmdb.org/t/p/w92${m.poster_path}` : null,
      })),
      ...(tv.results || []).slice(0, 4).map(t => ({
        title: t.name,
        year: t.first_air_date ? t.first_air_date.slice(0, 4) : null,
        type: 'show',
        overview: t.overview ? t.overview.slice(0, 120) + '...' : '',
        poster: t.poster_path ? `https://image.tmdb.org/t/p/w92${t.poster_path}` : null,
      })),
    ];

    res.status(200).json({ results });
  } catch (e) {
    res.status(500).json({ results: [], error: 'Search failed' });
  }
}
