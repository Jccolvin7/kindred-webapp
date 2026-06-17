import { useState, useEffect } from "react";

const G = {
  bg:'#080B16', deep:'#0D1120', card:'rgba(255,255,255,0.04)',
  border:'rgba(255,255,255,0.08)', purple:'#8B5CF6', purpleDim:'rgba(139,92,246,0.12)',
  cyan:'#06B6D4', amber:'#F59E0B', green:'#10B981', pink:'#EC4899',
  text:'#F1F5F9', muted:'#94A3B8', dim:'#475569',
};

const FILM = [
  {id:'interstellar',title:'Interstellar',genre:'Sci-Fi / Drama',emoji:'🌌'},
  {id:'parasite',title:'Parasite',genre:'Thriller / Drama',emoji:'🏠'},
  {id:'darknight',title:'The Dark Knight',genre:'Action / Crime',emoji:'🦇'},
  {id:'her',title:'Her',genre:'Sci-Fi / Romance',emoji:'💿'},
  {id:'furyroad',title:'Mad Max: Fury Road',genre:'Action',emoji:'🔥'},
  {id:'blade2049',title:'Blade Runner 2049',genre:'Neo-Noir Sci-Fi',emoji:'🤖'},
];
const GAMES = [
  {id:'eldenring',title:'Elden Ring',genre:'Action RPG',emoji:'⚔️'},
  {id:'tlou',title:'The Last of Us',genre:'Narrative Action',emoji:'🌿'},
  {id:'rdr2',title:'Red Dead Redemption 2',genre:'Open World',emoji:'🤠'},
  {id:'hades',title:'Hades',genre:'Roguelike',emoji:'💀'},
  {id:'disco',title:'Disco Elysium',genre:'RPG',emoji:'🎲'},
  {id:'celeste',title:'Celeste',genre:'Precision Platformer',emoji:'⛰️'},
];
const BOOKS = [
  {id:'dune',title:'Dune',genre:'Sci-Fi Epic',emoji:'🏜️'},
  {id:'road',title:'The Road',genre:'Post-Apocalyptic',emoji:'🛤️'},
  {id:'hailmary',title:'Project Hail Mary',genre:'Hard Sci-Fi',emoji:'🚀'},
  {id:'sapiens',title:'Sapiens',genre:'Non-Fiction',emoji:'🧠'},
  {id:'wind',title:'The Name of the Wind',genre:'Fantasy',emoji:'🎵'},
  {id:'recursion',title:'Recursion',genre:'Sci-Fi Thriller',emoji:'🔄'},
];

const BASE_TWINS = [
  {handle:'@aria_w',emoji:'🎬',color:'#8B5CF6',bio:'Loves slow-burn sci-fi and morally complex narratives',recs:['Severance','The Murderbot Diaries','Outer Wilds']},
  {handle:'@marcus_v',emoji:'🎮',color:'#06B6D4',bio:'Obsessed with games that feel like interactive novels',recs:['Nier: Automata','Foundation (Apple TV+)','Piranesi']},
  {handle:'@elena_k',emoji:'📚',color:'#F59E0B',bio:'Reads everything, plays anything, watches nothing casually',recs:['The Three-Body Problem','Dark (Netflix)','Hollow Knight']},
];

const FONTS = `@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;1,300;1,400&family=Space+Mono&display=swap');`;

export default function KindredApp() {
  const [step, setStep] = useState('welcome');
  const [ratings, setRatings] = useState({film:{},games:{},books:{}});
  const [recs, setRecs] = useState(null);
  const [recError, setRecError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [procStage, setProcStage] = useState(0);
  const [hoveredStar, setHoveredStar] = useState({});

  const setRating = (domain, id, val) => {
    setRatings(prev => ({...prev, [domain]: {...prev[domain], [id]: prev[domain][id]===val ? undefined : val}}));
  };
  const rated = (d) => Object.values(ratings[d]).filter(Boolean).length;

  const getTwins = () => {
    const fv = Object.values(ratings.film).filter(Boolean);
    const gv = Object.values(ratings.games).filter(Boolean);
    const bv = Object.values(ratings.books).filter(Boolean);
    const fa = fv.length ? fv.reduce((a,b)=>a+b,0)/fv.length : 3;
    const ga = gv.length ? gv.reduce((a,b)=>a+b,0)/gv.length : 3;
    const ba = bv.length ? bv.reduce((a,b)=>a+b,0)/bv.length : 3;
    const offsets = [{f:2,g:-1,b:3},{f:-1,g:4,b:1},{f:1,g:2,b:-2}];
    return BASE_TWINS.map((t,i) => {
      const base = 68 + (fa+ga+ba)*2.8;
      const fs = Math.min(99,Math.round(base+offsets[i].f));
      const gs = Math.min(99,Math.round(base-2+offsets[i].g));
      const bs = Math.min(99,Math.round(base-4+offsets[i].b));
      return {...t,overall:Math.round((fs+gs+bs)/3),domains:{film:fs,games:gs,books:bs}};
    }).sort((a,b)=>b.overall-a.overall);
  };

  useEffect(()=>{
    if(step!=='processing') return;
    const stages=['Analyzing taste fingerprint...','Mapping cross-domain patterns...','Finding your taste twins...','Building your profile...'];
    let i=0; setProcStage(0);
    const iv=setInterval(()=>{
      i++;
      if(i<stages.length) setProcStage(i);
      else { clearInterval(iv); setTimeout(()=>setStep('profile'),700); }
    },900);
    return()=>clearInterval(iv);
  },[step]);

  useEffect(()=>{
    if(step==='recs'&&!recs&&!loading) generateRecs();
  },[step]);

  const generateRecs = async () => {
    setLoading(true); setRecError(null);
    try {
      const fr = FILM.filter(f=>ratings.film[f.id]).map(f=>`${f.title}:${ratings.film[f.id]}/5`).join(', ');
      const gr = GAMES.filter(g=>ratings.games[g.id]).map(g=>`${g.title}:${ratings.games[g.id]}/5`).join(', ');
      const br = BOOKS.filter(b=>ratings.books[b.id]).map(b=>`${b.title}:${ratings.books[b.id]}/5`).join(', ');
      // NOTE: this now calls our own backend proxy (/api/chat) instead of
      // Anthropic's API directly. The proxy holds the real API key on the
      // server so it's never exposed in the browser.
      const res = await fetch("/api/chat",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          messages:[{role:"user",content:`You are Kindred, a cross-domain taste matching platform. Generate exactly 6 personalized recommendations based on this user's ratings. Mix the types (film, show, game, book) based on their taste.

Film ratings: ${fr||'none rated'}
Game ratings: ${gr||'none rated'}
Book ratings: ${br||'none rated'}

Return ONLY a JSON object. No markdown, no backticks, no explanation. Format:
{"recommendations":[{"title":"string","type":"film|show|game|book","reason":"one specific sentence about why based on their exact taste","matchScore":85}]}`}]
        })
      });
      const data = await res.json();
      const tb = data.content?.find(c=>c.type==='text');
      if(!tb) throw new Error('No response');
      const clean = tb.text.replace(/```json|```/g,'').trim();
      const parsed = JSON.parse(clean);
      setRecs(parsed.recommendations);
    } catch(e) {
      setRecError('Could not load recommendations. Check your connection and try again.');
    }
    setLoading(false);
  };

  const s = {
    app:{minHeight:'100vh',background:G.bg,color:G.text,fontFamily:"'Inter',system-ui,sans-serif"},
    center:{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',minHeight:'100vh',padding:'2rem',textAlign:'center'},
    card:{background:G.card,border:`1px solid ${G.border}`,borderRadius:18,padding:'1.5rem'},
    h1:{fontFamily:"'Cormorant Garamond',Georgia,serif",fontSize:'clamp(2.5rem,6vw,4.5rem)',fontWeight:300,lineHeight:1.08,marginBottom:'1rem'},
    h2:{fontFamily:"'Cormorant Garamond',Georgia,serif",fontSize:'clamp(1.75rem,4vw,2.75rem)',fontWeight:300,lineHeight:1.15,marginBottom:'0.875rem'},
    btn:{background:G.purple,color:'white',border:'none',padding:'0.9rem 2rem',borderRadius:12,fontSize:'0.95rem',fontWeight:600,cursor:'pointer',fontFamily:'inherit',width:'100%'},
    outBtn:{background:'transparent',color:G.muted,border:`1px solid ${G.border}`,padding:'0.9rem 2rem',borderRadius:12,fontSize:'0.95rem',cursor:'pointer',fontFamily:'inherit',width:'100%'},
    eyebrow:{fontFamily:'Space Mono,monospace',fontSize:'0.65rem',letterSpacing:'0.12em',textTransform:'uppercase',marginBottom:'0.875rem'},
    mono:{fontFamily:'Space Mono,monospace'},
  };

  const tagStyles = `
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
    @keyframes slideIn{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
    .kindred-btn:hover{background:#7C3AED!important;transform:translateY(-1px)}
    .item-card:hover{border-color:rgba(255,255,255,0.14)!important}
    .twin-card:hover{border-color:rgba(139,92,246,0.3)!important;transform:translateY(-2px)}
    .rec-card:hover{border-color:rgba(139,92,246,0.25)!important;transform:translateY(-1px)}
    .star-btn:hover{transform:scale(1.15)!important}
    .out-btn:hover{border-color:rgba(255,255,255,0.2)!important;color:#F1F5F9!important}
    .slide-in{animation:slideIn 0.45s ease forwards}
  `;

  // WELCOME
  if(step==='welcome') return(
    <div style={s.app}>
      <style>{FONTS+tagStyles}</style>
      <div style={s.center}>
        <div style={{fontFamily:"'Cormorant Garamond',serif",fontSize:'2rem',fontWeight:500,marginBottom:'3rem',letterSpacing:'0.06em'}}>
          Kind<span style={{color:G.purple}}>r</span>ed
        </div>
        <h1 style={s.h1}>Discover your<br/><em style={{color:G.purple,fontStyle:'italic'}}>taste fingerprint.</em></h1>
        <p style={{color:G.muted,lineHeight:1.75,fontSize:'1rem',maxWidth:460,margin:'0 auto 2.5rem'}}>
          Rate movies, games, and books you know. In 3 minutes we'll map your taste across every domain and connect you with your taste twins.
        </p>
        <div style={{display:'flex',gap:'0.75rem',flexWrap:'wrap',justifyContent:'center',marginBottom:'2.5rem'}}>
          {[['🎬','Film & TV'],[' 🎮','Games'],['📚','Books']].map(([ico,lbl])=>(
            <div key={lbl} style={{display:'flex',alignItems:'center',gap:'0.5rem',background:G.card,border:`1px solid ${G.border}`,padding:'0.45rem 1rem',borderRadius:100,fontSize:'0.8rem',color:G.muted}}>
              {ico} {lbl}
            </div>
          ))}
        </div>
        <div style={{maxWidth:340,width:'100%'}}>
          <button className="kindred-btn" style={{...s.btn,transition:'all 0.2s',fontSize:'1rem'}} onClick={()=>setStep('quiz_film')}>
            Start Taste Quiz →
          </button>
        </div>
        <p style={{color:G.dim,fontSize:'0.76rem',marginTop:'1rem'}}>~3 min · Rate what you know, skip what you don't</p>
      </div>
    </div>
  );

  // QUIZ
  if(step.startsWith('quiz_')) {
    const domain = step.replace('quiz_','');
    const items = domain==='film'?FILM:domain==='games'?GAMES:BOOKS;
    const label = domain==='film'?'Film & TV':domain==='games'?'Games':'Books';
    const icon = domain==='film'?'🎬':domain==='games'?'🎮':'📚';
    const color = domain==='film'?G.purple:domain==='games'?G.cyan:G.amber;
    const next = domain==='film'?'quiz_games':domain==='games'?'quiz_books':'processing';
    const num = domain==='film'?1:domain==='games'?2:3;
    const nextLabel = domain==='film'?'Next: Games →':domain==='games'?'Next: Books →':'See My Profile →';

    return(
      <div style={s.app}>
        <style>{FONTS+tagStyles}</style>
        <div style={{maxWidth:640,margin:'0 auto',padding:'2.5rem 1.5rem'}}>
          {/* Progress bar */}
          <div style={{display:'flex',alignItems:'center',gap:'1rem',marginBottom:'2.25rem'}}>
            <div style={{flex:1,height:3,background:G.border,borderRadius:2}}>
              <div style={{width:`${(num/3)*100}%`,height:'100%',background:color,borderRadius:2,transition:'width 0.6s ease'}}/>
            </div>
            <span style={{...s.mono,fontSize:'0.65rem',color:G.dim,whiteSpace:'nowrap'}}>{num} / 3</span>
          </div>

          <div style={{marginBottom:'1.75rem'}}>
            <div style={{...s.eyebrow,color,display:'inline-block',background:`${color}18`,border:`1px solid ${color}30`,padding:'0.3rem 0.875rem',borderRadius:100,marginBottom:'1rem'}}>
              {icon} {label}
            </div>
            <h2 style={s.h2}>Rate what you know</h2>
            <p style={{color:G.muted,fontSize:'0.88rem',lineHeight:1.65}}>Stars 1–5. Haven't seen / played / read it? Just skip.</p>
          </div>

          <div style={{display:'flex',flexDirection:'column',gap:'0.625rem',marginBottom:'1.75rem'}}>
            {items.map(item=>{
              const userRating = ratings[domain][item.id] || 0;
              const hovered = hoveredStar[item.id] || 0;
              return(
                <div key={item.id} className="item-card" style={{...s.card,display:'flex',alignItems:'center',gap:'1rem',padding:'1rem 1.25rem',transition:'border-color 0.2s',borderColor:userRating?`${color}55`:G.border}}>
                  <span style={{fontSize:'1.65rem',flexShrink:0}}>{item.emoji}</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:500,fontSize:'0.9rem'}}>{item.title}</div>
                    <div style={{color:G.dim,fontSize:'0.73rem',marginTop:'0.15rem'}}>{item.genre}</div>
                  </div>
                  <div style={{display:'flex',gap:'0.2rem',alignItems:'center',flexShrink:0}}>
                    {[1,2,3,4,5].map(star=>{
                      const filled = hovered>0 ? star<=hovered : star<=userRating;
                      return(
                        <button key={star} className="star-btn"
                          onClick={()=>setRating(domain,item.id,star)}
                          onMouseEnter={()=>setHoveredStar(h=>({...h,[item.id]:star}))}
                          onMouseLeave={()=>setHoveredStar(h=>({...h,[item.id]:0}))}
                          style={{background:'none',border:'none',cursor:'pointer',fontSize:'1.05rem',padding:'0.1rem',transition:'transform 0.12s',lineHeight:1,color:filled?color:'rgba(255,255,255,0.2)'}}>
                          ★
                        </button>
                      );
                    })}
                    {userRating>0&&(
                      <button onClick={()=>setRating(domain,item.id,undefined)} style={{background:'none',border:'none',cursor:'pointer',color:G.dim,fontSize:'0.65rem',padding:'0 0.25rem',fontFamily:'inherit',marginLeft:'0.2rem'}}>✕</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <span style={{color:G.dim,fontSize:'0.78rem',fontFamily:'Space Mono,monospace'}}>{rated(domain)} rated</span>
            <button className="kindred-btn" style={{...s.btn,width:'auto',padding:'0.75rem 1.5rem',fontSize:'0.88rem',transition:'all 0.2s'}} onClick={()=>setStep(next)}>
              {nextLabel}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // PROCESSING
  if(step==='processing'){
    const stages=['Analyzing taste fingerprint...','Mapping cross-domain patterns...','Finding your taste twins...','Building your profile...'];
    return(
      <div style={s.app}>
        <style>{FONTS+tagStyles+`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>
        <div style={s.center}>
          <div style={{width:52,height:52,border:`2px solid ${G.border}`,borderTop:`2px solid ${G.purple}`,borderRadius:'50%',animation:'spin 1s linear infinite',marginBottom:'2rem'}}/>
          <div key={procStage} style={{fontFamily:'Space Mono,monospace',fontSize:'0.8rem',color:G.purple,marginBottom:'1.25rem',animation:'fadeUp 0.4s ease'}}>
            {stages[procStage]}
          </div>
          <div style={{display:'flex',gap:'0.5rem'}}>
            {stages.map((_,i)=>(
              <div key={i} style={{width:6,height:6,borderRadius:'50%',background:i<=procStage?G.purple:G.border,transition:'background 0.4s'}}/>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // PROFILE
  if(step==='profile'){
    const total = rated('film')+rated('games')+rated('books');
    const avg = (d) => { const v=Object.values(ratings[d]).filter(Boolean); return v.length?v.reduce((a,b)=>a+b,0)/v.length:0; };
    const pct = (d) => Math.round(avg(d)*20);

    const tags=[];
    if((ratings.film.interstellar>=4)||(ratings.film.blade2049>=4)||(ratings.film.her>=4)) tags.push('Sci-Fi Enthusiast');
    if((ratings.games.disco>=4)||(ratings.games.eldenring>=4)) tags.push('Narrative Gamer');
    if((ratings.books.dune>=4)||(ratings.books.hailmary>=4)) tags.push('Hard Sci-Fi Reader');
    if(ratings.film.parasite>=4) tags.push('Art House Fan');
    if((ratings.games.hades>=4)||(ratings.games.celeste>=4)) tags.push('Indie Game Lover');
    if((ratings.books.road>=4)||(ratings.film.furyroad>=4)) tags.push('Post-Apocalyptic Aficionado');
    if(tags.length===0){tags.push('Eclectic Taste','Curious Explorer');}

    return(
      <div style={s.app}>
        <style>{FONTS+tagStyles}</style>
        <div style={{maxWidth:560,margin:'0 auto',padding:'2.5rem 1.5rem'}} className="slide-in">
          <div style={{textAlign:'center',marginBottom:'2.25rem'}}>
            <div style={{...s.eyebrow,color:G.purple}}>TASTE FINGERPRINT</div>
            <h2 style={s.h2}>Your taste profile</h2>
            <p style={{color:G.muted,fontSize:'0.85rem'}}>{total} items rated across 3 domains</p>
          </div>

          <div style={{...s.card,marginBottom:'1rem'}}>
            <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.62rem',color:G.dim,textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:'1.25rem'}}>Domain Breakdown</div>
            {[
              {label:'Film & TV',domain:'film',color:G.purple,icon:'🎬'},
              {label:'Games',domain:'games',color:G.cyan,icon:'🎮'},
              {label:'Books',domain:'books',color:G.amber,icon:'📚'},
            ].map(({label,domain,color,icon})=>{
              const p=pct(domain);
              const n=rated(domain);
              return(
                <div key={domain} style={{marginBottom:'1.25rem'}}>
                  <div style={{display:'flex',justifyContent:'space-between',fontSize:'0.8rem',marginBottom:'0.5rem'}}>
                    <span style={{color:G.muted}}>{icon} {label}</span>
                    <span style={{fontFamily:'Space Mono,monospace',fontSize:'0.72rem',color:n>0?color:G.dim}}>
                      {n>0?`${p}% avg · ${n} rated`:'Not rated'}
                    </span>
                  </div>
                  <div style={{height:5,background:'rgba(255,255,255,0.06)',borderRadius:3,overflow:'hidden'}}>
                    <div style={{height:'100%',width:`${p}%`,background:color,borderRadius:3,transition:'width 1.2s ease'}}/>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{...s.card,marginBottom:'1.25rem'}}>
            <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.62rem',color:G.dim,textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:'1rem'}}>Taste Tags</div>
            <div style={{display:'flex',flexWrap:'wrap',gap:'0.5rem'}}>
              {tags.map(t=>(
                <span key={t} style={{background:G.purpleDim,border:'1px solid rgba(139,92,246,0.2)',color:'#C4B5D9',padding:'0.35rem 0.875rem',borderRadius:100,fontSize:'0.76rem'}}>{t}</span>
              ))}
            </div>
          </div>

          <button className="kindred-btn" style={{...s.btn,transition:'all 0.2s'}} onClick={()=>setStep('twins')}>Find My Taste Twins →</button>
        </div>
      </div>
    );
  }

  // TWINS
  if(step==='twins'){
    const twins=getTwins();
    return(
      <div style={s.app}>
        <style>{FONTS+tagStyles}</style>
        <div style={{maxWidth:600,margin:'0 auto',padding:'2.5rem 1.5rem'}} className="slide-in">
          <div style={{textAlign:'center',marginBottom:'2.25rem'}}>
            <div style={{...s.eyebrow,color:G.cyan}}>TASTE MATCHING</div>
            <h2 style={s.h2}>Your taste twins</h2>
            <p style={{color:G.muted,fontSize:'0.85rem',lineHeight:1.65}}>People whose cross-domain taste fingerprint aligns most closely with yours.</p>
          </div>

          <div style={{display:'flex',flexDirection:'column',gap:'0.875rem',marginBottom:'1.25rem'}}>
            {twins.map((twin,i)=>{
              const rgb = twin.color==='#8B5CF6'?'139,92,246':twin.color==='#06B6D4'?'6,182,212':'245,158,11';
              return(
                <div key={twin.handle} className="twin-card" style={{...s.card,transition:'all 0.2s',cursor:'default'}}>
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'1.25rem'}}>
                    <div style={{display:'flex',alignItems:'center',gap:'0.875rem'}}>
                      <div style={{width:44,height:44,borderRadius:'50%',background:`rgba(${rgb},0.15)`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:'1.15rem',flexShrink:0}}>
                        {twin.emoji}
                      </div>
                      <div>
                        <div style={{fontWeight:500,fontSize:'0.88rem'}}>{twin.handle}</div>
                        <div style={{color:G.dim,fontSize:'0.73rem',marginTop:'0.15rem'}}>{twin.bio}</div>
                      </div>
                    </div>
                    <div style={{textAlign:'right',flexShrink:0,marginLeft:'0.875rem'}}>
                      <div style={{fontFamily:'Space Mono,monospace',fontSize:'1.65rem',color:twin.color,fontWeight:700,lineHeight:1}}>{twin.overall}%</div>
                      <div style={{fontSize:'0.65rem',color:G.dim}}>match</div>
                    </div>
                  </div>
                  <div style={{display:'flex',gap:'0.5rem',marginBottom:'1.25rem'}}>
                    {[['🎬',twin.domains.film,G.purple],['🎮',twin.domains.games,G.cyan],['📚',twin.domains.books,G.amber]].map(([ico,score,clr])=>(
                      <div key={ico} style={{flex:1,background:'rgba(255,255,255,0.03)',borderRadius:8,padding:'0.5rem',textAlign:'center'}}>
                        <div style={{fontSize:'0.8rem',marginBottom:'0.2rem'}}>{ico}</div>
                        <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.7rem',color:clr,fontWeight:700}}>{score}%</div>
                      </div>
                    ))}
                  </div>
                  <div>
                    <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.6rem',color:G.dim,textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:'0.625rem'}}>They'd recommend</div>
                    <div style={{display:'flex',flexWrap:'wrap',gap:'0.4rem'}}>
                      {twin.recs.map(r=>(
                        <span key={r} style={{background:G.purpleDim,border:'1px solid rgba(139,92,246,0.2)',color:'#C4B5D9',padding:'0.25rem 0.75rem',borderRadius:100,fontSize:'0.72rem'}}>{r}</span>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <button className="kindred-btn" style={{...s.btn,transition:'all 0.2s'}} onClick={()=>setStep('recs')}>Get AI Recommendations →</button>
        </div>
      </div>
    );
  }

  // RECOMMENDATIONS
  if(step==='recs'){
    const typeMap={
      film:{label:'Film',color:G.purple,icon:'🎬'},
      show:{label:'Show',color:G.pink,icon:'📺'},
      game:{label:'Game',color:G.cyan,icon:'🎮'},
      book:{label:'Book',color:G.amber,icon:'📚'},
    };
    return(
      <div style={s.app}>
        <style>{FONTS+tagStyles}</style>
        <div style={{maxWidth:620,margin:'0 auto',padding:'2.5rem 1.5rem'}} className="slide-in">
          <div style={{textAlign:'center',marginBottom:'2.25rem'}}>
            <div style={{...s.eyebrow,color:G.purple}}>AI-POWERED · CROSS-DOMAIN</div>
            <h2 style={s.h2}>Made for your taste</h2>
            <p style={{color:G.muted,fontSize:'0.85rem',lineHeight:1.65}}>Kindred analyzed your fingerprint across all domains and found these just for you.</p>
          </div>

          {loading&&(
            <div style={{textAlign:'center',padding:'4rem 0'}}>
              <div style={{width:40,height:40,border:`2px solid ${G.border}`,borderTop:`2px solid ${G.purple}`,borderRadius:'50%',animation:'spin 1s linear infinite',margin:'0 auto 1rem'}}/>
              <div style={{fontFamily:'Space Mono,monospace',fontSize:'0.72rem',color:G.dim}}>Generating recommendations...</div>
            </div>
          )}

          {recError&&(
            <div style={{background:'rgba(239,68,68,0.08)',border:'1px solid rgba(239,68,68,0.2)',borderRadius:14,padding:'1.25rem',textAlign:'center',marginBottom:'1.25rem'}}>
              <div style={{color:'#FCA5A5',marginBottom:'0.75rem',fontSize:'0.85rem'}}>{recError}</div>
              <button className="kindred-btn" style={{...s.btn,width:'auto',padding:'0.6rem 1.25rem',fontSize:'0.85rem',transition:'all 0.2s'}} onClick={generateRecs}>Try Again</button>
            </div>
          )}

          {recs&&(
            <>
              <div style={{display:'flex',flexDirection:'column',gap:'0.75rem',marginBottom:'1.25rem'}}>
                {recs.map((rec,i)=>{
                  const cfg=typeMap[rec.type]||typeMap.film;
                  return(
                    <div key={i} className="rec-card" style={{...s.card,display:'flex',gap:'1rem',alignItems:'flex-start',transition:'all 0.2s',cursor:'default'}}>
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
                <button className="out-btn" style={{...s.outBtn,transition:'all 0.2s'}} onClick={()=>{setStep('welcome');setRatings({film:{},games:{},books:{}});setRecs(null);}}>
                  Start Over
                </button>
                <button className="kindred-btn" style={{...s.btn,transition:'all 0.2s'}} onClick={()=>{setRecs(null);generateRecs();}}>
                  Refresh Recs ↺
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return null;
}
