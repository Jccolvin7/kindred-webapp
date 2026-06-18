import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";

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

  const [ratings, setRatings] = useState({film:{},games:{},books:{}});
  const [quizDomain, setQuizDomain] = useState('film');
  const [searchQuery, setSearchQuery] = useState({film:'',games:'',books:''});
  const [searchResults, setSearchResults] = useState({film:[],games:[],books:[]});
  const [searchLoading, setSearchLoading] = useState({film:false,games:false,books:false});
  const [hoveredStar, setHoveredStar] = useState({});

  const [realTwins, setRealTwins] = useState(null);
  const [twinsLoading, setTwinsLoading] = useState(false);
  const [twinsError, setTwinsError] = useState(null);
  const [copiedId, setCopiedId] = useState(null);

  const [recs, setRecs] = useState(null);
  const [recError, setRecError] = useState(null);
  const [recLoading, setRecLoading] = useState(false);
  const [procStage, setProcStage] = useState(0);

  const debounceRef = useRef({});

  useEffect(() => {
    const saved = window.localStorage.getItem('kindred_email');
    if (saved) setEmail(saved);
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

  // AUTH
  async function handleAuth() {
    setAuthError(null);
    if (!email || !email.includes('@')) { setAuthError('Enter a valid email.'); return; }
    setAuthLoading(true);
    try {
      const { data: existing, error: findErr } = await supabase
        .from('users').select('id, username').eq('email', email).maybeSingle();
      if (findErr) throw findErr;
      let uid;
      if (existing) {
        uid = existing.id;
      } else {
        const { data: created, error: insErr } = await supabase
          .from('users')
          .insert({ email, username: username || email.split('@')[0] })
          .select('id').single();
        if (insErr) throw insErr;
        uid = created.id;
      }
      const { data: saved } = await supabase
        .from('tastes').select('category, item_name, rating').eq('user_id', uid);
      if (saved && saved.length) {
        const loaded = {film:{},games:{},books:{}};
        saved.forEach(t => { if (loaded[t.category]) loaded[t.category][t.item_name] = t.rating; });
        setRatings(loaded);
      }
      window.localStorage.setItem('kindred_email', email);
      setUserId(uid);
      setStep('quiz');
    } catch (e) {
      setAuthError('Could not sign in. Check your connection and try again.');
    }
    setAuthLoading(false);
  }

  // RATING — title is used as item_name key
  async function setRating(domain, title, val) {
    const newVal = ratings[domain][title] === val ? undefined : val;
    setRatings(prev => ({...prev, [domain]: {...prev[domain], [title]: newVal}}));
    if (!userId) return;
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
    } catch (e) { console.error('Save failed', e); }
  }

  const rated = (d) => Object.values(ratings[d]).filter(Boolean).length;
  const totalRated = () => DOMAINS.reduce((sum, d) => sum + rated(d.key), 0);

  // REAL TWIN MATCHING
  async function fetchRealTwins() {
    setTwinsLoading(true); setTwinsError(null);
    try {
      const { data: all, error } = await supabase.from('tastes').select('user_id, category, item_name, rating');
      if (error) throw error;
      const mine = all.filter(t => t.user_id === userId);
      const byUser = {};
      all.forEach(t => {
        if (t.user_id === userId) return;
        if (!byUser[t.user_id]) byUser[t.user_id] = [];
        byUser[t.user_id].push(t);
      });
      const candidates = [];
      for (const otherId in byUser) {
        const theirs = byUser[otherId];
        const domainSims = {film:[],games:[],books:[]};
        mine.forEach(m => {
          const match = theirs.find(t => t.category === m.category && t.item_name === m.item_name);
          if (match) {
            const sim = 1 - Math.abs(m.rating - match.rating) / 4;
            domainSims[m.category]?.push(sim);
          }
        });
        const allSims = Object.values(domainSims).flat();
        if (allSims.length === 0) continue;
        const overall = Math.round((allSims.reduce((a,b)=>a+b,0)/allSims.length)*100);
        const domains = {};
        Object.keys(domainSims).forEach(d => {
          const arr = domainSims[d];
          domains[d] = arr.length ? Math.round((arr.reduce((a,b)=>a+b,0)/arr.length)*100) : null;
        });
        const mineMap = {}; mine.forEach(t => { mineMap[`${t.category}:${t.item_name}`] = t.rating; });
        const theirMap = {}; theirs.forEach(t => { theirMap[`${t.category}:${t.item_name}`] = t.rating; });
        const shared = mine.filter(t => theirMap[`${t.category}:${t.item_name}`] !== undefined && t.rating >= 4 && theirMap[`${t.category}:${t.item_name}`] >= 4)
          .map(t => ({title: t.item_name, mine: t.rating, theirs: theirMap[`${t.category}:${t.item_name}`]}))
          .sort((a,b)=>(b.mine+b.theirs)-(a.mine+a.theirs)).slice(0,4);
        const onlyMine = mine.filter(t => !theirMap[`${t.category}:${t.item_name}`] && t.rating >= 4).slice(0,3);
        const onlyTheirs = theirs.filter(t => !mineMap[`${t.category}:${t.item_name}`] && t.rating >= 4).slice(0,3);
        candidates.push({ id: otherId, overall, domains, overlap: allSims.length, shared, onlyMine, onlyTheirs });
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
    } catch (e) {
      setTwinsError('Could not load taste twins. Check your connection and try again.');
    }
    setTwinsLoading(false);
  }

  useEffect(() => {
    if (step === 'twins' && realTwins === null && !twinsLoading) fetchRealTwins();
  }, [step]);

  // SHARE
  async function shareTwin(twin) {
    const lines = [`Kindred Taste Twin Match: ${twin.overall}%`, `Matched with ${twin.handle}`];
    if (twin.shared?.length) { lines.push('', 'We both loved:'); twin.shared.forEach(s => lines.push(`- ${s.title}`)); }
    lines.push('', 'Find your taste twin at kindredmatch.co');
    const text = lines.join('\n');
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
      const fmt = (d) => Object.entries(ratings[d]).filter(([,v])=>v).map(([k,v])=>`${k}:${v}/5`).join(', ');
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6", max_tokens: 1000,
          messages: [{ role: "user", content: `You are Kindred, a cross-domain taste matching platform. Generate exactly 6 personalized recommendations.

Film & TV ratings: ${fmt('film') || 'none rated'}
Game ratings: ${fmt('games') || 'none rated'}
Book ratings: ${fmt('books') || 'none rated'}

Return ONLY a JSON object, no markdown, no backticks:
{"recommendations":[{"title":"string","type":"film|show|game|book","reason":"one sentence why","matchScore":85}]}` }]
        })
      });
      const data = await res.json();
      const tb = data.content?.find(c => c.type === 'text');
      if (!tb) throw new Error('No response');
      const parsed = JSON.parse(tb.text.replace(/```json|```/g,'').trim());
      setRecs(parsed.recommendations);
    } catch (e) {
      setRecError('Could not load recommendations. Check your connection and try again.');
    }
    setRecLoading(false);
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
        <div style={{maxWidth:340,width:'100%'}}>
          <input className="k-input" style={s.input} type="email" placeholder="your@email.com"
            value={email} onChange={e=>setEmail(e.target.value)}
            onKeyDown={e=>e.key==='Enter'&&handleAuth()} />
          <input className="k-input" style={s.input} type="text" placeholder="Display name (optional)"
            value={username} onChange={e=>setUsername(e.target.value)} />
          {authError && <div style={{color:'#FCA5A5',fontSize:'0.78rem',marginBottom:'0.75rem'}}>{authError}</div>}
          <button className="k-btn" style={{...s.btn,transition:'all 0.2s',opacity:authLoading?0.6:1}}
            onClick={handleAuth} disabled={authLoading}>
            {authLoading ? 'Signing in...' : 'Continue →'}
          </button>
        </div>
        <p style={{color:G.dim,fontSize:'0.76rem',marginTop:'1rem'}}>No password needed. We'll remember you by email.</p>
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

  // ─── PROFILE ───────────────────────────────────────────────
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

    return (
      <div style={s.app}>
        <style>{FONTS+css}</style>
        <div style={{maxWidth:560,margin:'0 auto',padding:'2.5rem 1.5rem'}} className="slide-in">
          <div style={{textAlign:'center',marginBottom:'2rem'}}>
            <div style={{...s.eyebrow,color:G.purple}}>TASTE FINGERPRINT</div>
            <h2 style={s.h2}>Your taste profile</h2>
            <p style={{color:G.muted,fontSize:'0.85rem'}}>{total} items rated and saved</p>
          </div>
          <CompletionWidget ratings={ratings} />
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
          <div style={{display:'flex',gap:'0.75rem'}}>
            <button className="k-out" style={{...s.outBtn,transition:'all 0.2s'}} onClick={()=>setStep('quiz')}>Rate More</button>
            <button className="k-btn" style={{...s.btn,transition:'all 0.2s'}} onClick={()=>setStep('twins')}>Find My Taste Twins →</button>
          </div>
        </div>
      </div>
    );
  }

  // ─── TWINS ─────────────────────────────────────────────────
  if (step === 'twins') {
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
    return (
      <div style={s.app}>
        <style>{FONTS+css}</style>
        <div style={{maxWidth:620,margin:'0 auto',padding:'2.5rem 1.5rem'}} className="slide-in">
          <div style={{textAlign:'center',marginBottom:'2.25rem'}}>
            <div style={{...s.eyebrow,color:G.purple}}>AI-POWERED · CROSS-DOMAIN</div>
            <h2 style={s.h2}>Made for your taste</h2>
            <p style={{color:G.muted,fontSize:'0.85rem',lineHeight:1.65}}>Based on everything you've rated across all domains.</p>
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
              <div style={{display:'flex',flexDirection:'column',gap:'0.75rem',marginBottom:'1.25rem'}}>
                {recs.map((rec,i)=>{
                  const cfg=typeMap[rec.type]||typeMap.film;
                  return (
                    <div key={i} className="k-rec" style={{...s.card,display:'flex',gap:'1rem',alignItems:'flex-start',transition:'all 0.2s',cursor:'default'}}>
                      <span style={{fontSize:'1.5rem',flexShrink:0,paddingTop:'0.05rem'}}>{cfg.icon}</span>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:'flex',alignItems:'center',gap:'0.625rem',marginBottom:'0.35rem',flexWrap:'wrap'}}>
                          <span style={{fontWeight:600,fontSize:'0.92rem'}}>{rec.title}</span>
                          <span style={{background:`${cfg.color}20`,color:cfg.color,padding:'0.12rem 0.6rem',borderRadius:100,fontSize:'0.62rem',fontFamily:'Space Mono,monospace'}}>{cfg.label}</span>
                        </div>
                        <p style={{color:G.muted,fontSize:'0.8rem',lineHeight:1.6,margin:0}}>{rec.reason}</p>
                      </div>
                      <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.82rem',color:G.purple,fontWeight:700,flexShrink:0}}>{rec.matchScore}%</div>
                    </div>
                  );
                })}
              </div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 2fr',gap:'0.75rem'}}>
                <button className="k-out" style={{...s.outBtn,transition:'all 0.2s'}} onClick={()=>setStep('quiz')}>Rate More</button>
                <button className="k-btn" style={{...s.btn,transition:'all 0.2s'}} onClick={()=>{setRecs(null);generateRecs();}}>Refresh Recs ↺</button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return null;
}
