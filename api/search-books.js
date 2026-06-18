export default async function handler(req, res) {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.status(400).json({ results: [] });

  try {
    const response = await fetch(
      `https://openlibrary.org/search.json?title=${encodeURIComponent(q)}&limit=10&fields=title,author_name,first_publish_year,cover_i,key`
    );
    const data = await response.json();

    const results = (data.docs || []).slice(0, 8).map(b => ({
      title: b.title,
      year: b.first_publish_year ? String(b.first_publish_year) : null,
      type: 'book',
      overview: b.author_name ? `by ${b.author_name[0]}` : '',
      poster: b.cover_i ? `https://covers.openlibrary.org/b/id/${b.cover_i}-S.jpg` : null,
    }));

    res.status(200).json({ results });
  } catch (e) {
    res.status(500).json({ results: [], error: 'Search failed' });
  }
}
