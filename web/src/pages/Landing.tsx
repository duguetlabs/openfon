import { useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../App';
import '../landing.css';

const examples = [
  { label: 'The opening-hours call', caller: 'Are you open on Saturday?', reply: 'Yes, from 9 until 2. Is there anything else you’d like to know?', note: 'An answer from your business facts.' },
  { label: 'The callback request', caller: 'Could someone call me about a repair?', reply: 'I can take a message. What’s your name and the best number to reach you?', note: 'A message your team can follow up on.' },
  { label: 'The honest “I don’t know”', caller: 'Can you repair a vintage espresso machine?', reply: 'I don’t have that information yet. Shall I take a message for the team?', note: 'An unknown question becomes something to improve.' },
];
const repo = 'https://github.com/duguetlabs/openfon';

export default function Landing() {
  const { me } = useSession();
  const [example, setExample] = useState(0);
  const [tilt, setTilt] = useState({ x: -12, y: -19 });
  const selected = examples[example];
  return <div className="landing">
    <a className="landing-skip" href="#main">Skip to content</a>
    <header className="landing-header">
      <Link className="wordmark" to="/" aria-label="OpenFon home"><span className="brand-symbol" aria-hidden="true">of</span>openfon<span className="brand-period">.</span></Link>
      <nav aria-label="Main navigation"><a href="#how-it-works">How it works</a><a href="#ownership">Why open?</a><a href="#questions">Questions</a></nav>
      <Link className="header-action" to={me ? '/overview' : '/auth?mode=login'}>{me ? 'Your studio' : 'Sign in'} <span aria-hidden="true">↗</span></Link>
    </header>
    <main id="main">
      <section className="landing-hero" aria-labelledby="hero-title">
        <div className="hero-copy"><p className="eyebrow"><span className="signal-dot" /> OPEN SOURCE. OPEN FOR CONVERSATION.</p>
          <h1 id="hero-title">A little more<br/>human.<br/><em>Even when<br/>you’re busy.</em></h1>
          <p className="hero-description">The open-source voice assistant for your business. Answer routine questions, take messages, and review what callers needed — starting with a browser call link.</p>
          <div className="hero-actions"><Link className="landing-button" to={me ? '/overview' : '/auth'}>{me ? 'Open your studio' : 'Create your assistant'} <span aria-hidden="true">↗</span></Link><a className="text-action" href="#listen">See a conversation <span aria-hidden="true">↓</span></a></div>
          <p className="hero-footnote">Browser calling today · Self-hostable · MIT licensed</p>
        </div>
        <div className="hero-art" onPointerMove={e => { if (e.pointerType === 'touch' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return; const r = e.currentTarget.getBoundingClientRect(); setTilt({ x: -12 + ((e.clientY - r.top) / r.height - .5) * -10, y: -19 + ((e.clientX - r.left) / r.width - .5) * 16 }); }} onPointerLeave={() => setTilt({ x: -12, y: -19 })}>
          <div className="art-orbit orbit-one"/><div className="art-orbit orbit-two"/>
          <span className="art-coordinate">01 / THE OPEN LINE</span>
          <div className="phone-shadow"/>
          <div className="phone-object" role="img" aria-label="Sculptural blue telephone with a glowing orange voice dial" style={{ '--tilt-x': `${tilt.x}deg`, '--tilt-y': `${tilt.y}deg` } as CSSProperties}>
            <div className="phone-side"/><div className="phone-face"><div className="phone-topline"><span>OPENFON</span><span>● READY</span></div><div className="speaker-grille">{Array.from({ length: 35 }, (_, i) => <i key={i}/>)}</div><div className="voice-dial"><div className="dial-inner"><div className="dial-wave">{[20,34,50,28,58,42,24].map((h,i) => <i key={i} style={{ height: h, animationDelay: `${i * -.17}s` }}/>)}</div></div><span className="dial-label">HERE TO LISTEN</span></div><div className="phone-bottom"><span>your business.<br/>your voice.</span><span className="phone-plus">+</span></div></div>
            <div className="handset"><div className="handset-bridge"/><div className="handset-ear ear-one"/><div className="handset-ear ear-two"/></div>
          </div>
          <div className="art-caption"><span className="caption-star">✳</span><span>A good conversation<br/>starts with listening.</span></div>
        </div>
      </section>
      <div className="manifesto-strip"><span>Less repeating yourself.</span><span aria-hidden="true">✳</span><span>More being there.</span><span aria-hidden="true">✳</span><span>Always your knowledge.</span></div>
      <section className="conversation-section landing-section" id="listen">
        <div className="section-intro"><p className="eyebrow">SMALL CALLS. REAL DIFFERENCE.</p><h2>Make room for<br/><em>the conversation.</em></h2><p>Your assistant handles familiar questions and takes a message when it needs a human. You stay in the loop.</p><span className="example-disclosure">Illustrative conversation · not a live call</span></div>
        <div className="conversation-demo"><div className="example-tabs" role="group" aria-label="Choose an example conversation">{examples.map((item, i) => <button key={item.label} aria-pressed={example === i} onClick={() => setExample(i)}><span>0{i+1}</span>{item.label}</button>)}</div><div className="conversation-body" aria-live="polite"><div className="conversation-turn caller"><span>CALLER</span><p>{selected.caller}</p></div><div className="conversation-turn assistant"><span><i/> YOUR ASSISTANT</span><p>{selected.reply}</p></div><p className="conversation-note">↳ {selected.note}</p></div><Link className="demo-action" to={me ? '/test' : '/auth'}>Try it with your own business <span aria-hidden="true">↗</span></Link></div>
      </section>
      <section className="workflow-section landing-section" id="how-it-works"><div className="workflow-heading"><p className="eyebrow">FROM YOUR KNOW-HOW TO “HELLO”.</p><h2>Nothing to script.<br/><em>Plenty to say.</em></h2></div><div className="workflow-grid">{[
        ['01','Give it the facts.','Add your hours, services, and the questions you answer every day. Choose a voice and write a welcome that sounds like you.','FACTS → KNOWLEDGE'],
        ['02','Have a word.','Test your assistant in the studio before sharing it. Read the transcript, spot the gaps, and refine the answers.','TEST → REFINE'],
        ['03','Open the line.','Publish your assistant and share its browser call link. Review conversations and turn unanswered questions into better knowledge.','PUBLISH → LEARN'],
      ].map(([n,title,body,tag]) => <article key={n}><span className="step-number">{n}</span><h3>{title}</h3><p>{body}</p><span className="step-tag">{tag}</span></article>)}</div></section>
      <section className="ownership-section landing-section" id="ownership"><div className="ownership-graphic" aria-hidden="true"><div className="ownership-ring ring-a"/><div className="ownership-ring ring-b"/><span>yours<span>from the first hello.</span></span></div><div className="ownership-copy"><p className="eyebrow">AN OPEN LINE. NOT A BLACK BOX.</p><h2>Your business.<br/>Your knowledge.<br/><em>Your call.</em></h2><p>OpenFon is open-source software. Host it in your own Cloudflare account, choose a compatible AI provider, and keep your call records in your own database.</p><dl><div><dt>Software</dt><dd>Free, under the MIT license</dd></div><div><dt>Running costs</dt><dd>Hosting, AI and speech usage; carrier costs if enabled</dd></div><div><dt>Phone numbers</dt><dd>Browser calls today; telephone adapters require a verified carrier pilot</dd></div></dl><a className="text-action" href={repo} target="_blank" rel="noreferrer">Explore the source <span aria-hidden="true">↗</span></a></div></section>
      <section className="faq-section landing-section" id="questions"><div><p className="eyebrow">BEFORE YOU PICK UP.</p><h2>A few<br/><em>good questions.</em></h2></div><div className="faq-list">{[
        ['Does it answer my existing phone number?','Not yet. Today, callers use a link and speak from their browser, or type if they prefer. Connecting an existing telephone number requires a telephony integration that is still in development.'],
        ['Why is Kataleptic the default?','Kataleptic is the OpenFon founder’s paid inference service. It is an optional convenience, with a separate account and usage bill. Alternative providers need the right text, speech or realtime capability; the repository documents their verification status.'],
        ['What does my assistant know?','The business details and active knowledge you give it. You can add FAQs, service information, and notes, then test its answers. AI can still make mistakes, so review important information and keep your knowledge current.'],
        ['Does OpenFon make bookings?','It can capture a booking request and caller details for your team. It does not confirm appointments or connect to a calendar.'],
        ['Do I need to be technical?','Using the studio is designed to be straightforward. Self-hosting requires setting up Cloudflare and an AI provider. The repository includes the installation steps and configuration guide.'],
        ['Is everything free?','The OpenFon software is free and MIT licensed. Hosting, speech, language-model, and any future telephony services have their own usage costs. Those depend on your providers and traffic.'],
        ['Where do conversations go?','Transcripts and summaries are stored in the instance’s database. Your configured speech and AI providers process the conversation to respond. If you self-host, you choose and manage those providers.'],
      ].map(([q,a]) => <details key={q}><summary>{q}<span aria-hidden="true">+</span></summary><p>{a}</p></details>)}</div></section>
      <section className="closing-section"><p className="eyebrow">YOUR NEXT GOOD CONVERSATION STARTS HERE.</p><h2>Go on.<br/><em>Say hello.</em><span aria-hidden="true">↗</span></h2><Link className="landing-button light-button" to={me ? '/overview' : '/auth'}>{me ? 'Open your studio' : 'Create your assistant'} <span aria-hidden="true">↗</span></Link><a href={`${repo}#self-hosting`} target="_blank" rel="noreferrer">Or make yourself at home. Self-host OpenFon ↗</a></section>
    </main>
    <footer className="landing-footer"><Link className="wordmark" to="/">openfon.</Link><p>An open line to your business.</p><div><a href={repo} target="_blank" rel="noreferrer">GitHub ↗</a><a href={`${repo}/blob/main/LICENSE`} target="_blank" rel="noreferrer">MIT license ↗</a><a href={`${repo}/issues`} target="_blank" rel="noreferrer">Feedback ↗</a></div><span>BY DUGUET LABS</span></footer>
  </div>;
}
