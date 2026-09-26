import { useState } from 'react';
import { Logo } from '../ui';
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
  const selected = examples[example];
  return <div className="landing">
    <a className="landing-skip" href="#main">Skip to content</a>
    <header className="landing-header">
      <Link className="wordmark" to="/" aria-label="OpenFon home"><Logo /></Link>
      <nav aria-label="Main navigation"><a href="#how-it-works">How it works</a><a href="#ownership">Why open?</a><a href="#questions">Questions</a></nav>
      <Link className="header-action" to={me ? '/overview' : '/auth?mode=login'}>{me ? 'Your studio' : 'Sign in'} <span aria-hidden="true">↗</span></Link>
    </header>
    <main id="main">
      <section className="landing-hero" aria-labelledby="hero-title">
        <div className="hero-copy"><p className="eyebrow"><span className="signal-dot" /> A voice assistant for your business</p>
          <h1 id="hero-title">Be there for callers.<br/><em>Even when you’re busy.</em></h1>
          <p className="hero-description">The open-source voice assistant for your business. Answer routine questions, take messages, and review what callers needed — starting with a browser call link.</p>
          <div className="hero-actions"><Link className="landing-button" to={me ? '/overview' : '/auth'}>{me ? 'Open your studio' : 'Create your assistant'} <span aria-hidden="true">↗</span></Link><a className="text-action" href="#listen">See a conversation <span aria-hidden="true">↓</span></a></div>
          <p className="hero-footnote">Browser calling today · Self-hostable · MIT licensed</p>
        </div>
        <div className="hero-workspace" aria-label="Illustrative assistant conversation">
          <div className="hero-workspace-header"><span className="hero-workspace-mark" aria-hidden="true">G</span><div><strong>Dr. Gruber Zahnarzt</strong><span>Example assistant · German</span></div></div>
          <div className="hero-call-state"><span className="signal-dot" /> A question, answered</div>
          <div className="hero-message"><span>Caller</span><p>Guten Tag! Haben Sie am Samstag geöffnet?</p></div>
          <div className="hero-message hero-message-assistant"><span>Assistant</span><p>Guten Tag! Samstags sind wir von 9 bis 14 Uhr für Sie da. Wie kann ich Ihnen helfen?</p></div>
          <div className="hero-workspace-footer"><span>From your business knowledge</span><span>Illustrative conversation</span></div>
        </div>
      </section>

      <section className="conversation-section landing-section" id="listen">
        <div className="section-intro"><p className="eyebrow">Built around your everyday calls</p><h2>Familiar questions.<br/><em>Thoughtful answers.</em></h2><p>Your assistant handles familiar questions and takes a message when it needs a human. You stay in the loop.</p><span className="example-disclosure">Illustrative conversation · not a live call</span></div>
        <div className="conversation-demo"><div className="example-tabs" role="group" aria-label="Choose an example conversation">{examples.map((item, i) => <button key={item.label} aria-pressed={example === i} onClick={() => setExample(i)}>{item.label}</button>)}</div><div className="conversation-body" aria-live="polite"><div className="conversation-turn caller"><span>Caller</span><p>{selected.caller}</p></div><div className="conversation-turn assistant"><span><i/> Your assistant</span><p>{selected.reply}</p></div><p className="conversation-note">↳ {selected.note}</p></div><Link className="demo-action" to={me ? '/test' : '/auth'}>Try it with your own business <span aria-hidden="true">↗</span></Link></div>
      </section>
      <section className="workflow-section landing-section" id="how-it-works"><div className="workflow-heading"><p className="eyebrow">Set up, try it, then share it</p><h2>Your assistant,<br/><em>in three steps.</em></h2></div><div className="workflow-grid">{[
        ['01','Give it the facts.','Add your hours, services, and the questions you answer every day. Choose a voice and write a welcome that sounds like you.','FACTS → KNOWLEDGE'],
        ['02','Have a word.','Test your assistant in the studio before sharing it. Read the transcript, spot the gaps, and refine the answers.','TEST → REFINE'],
        ['03','Open the line.','Publish your assistant and share its browser call link. Review conversations and turn unanswered questions into better knowledge.','PUBLISH → LEARN'],
      ].map(([n,title,body,tag]) => <article key={n}><span className="step-number">{n}</span><h3>{title}</h3><p>{body}</p><span className="step-tag">{tag}</span></article>)}</div></section>
      <section className="ownership-section landing-section" id="ownership"><div className="ownership-intro"><p className="eyebrow">Open source, by design</p><h2>Your business.<br/>Your knowledge.<br/><em>Your call.</em></h2></div><div className="ownership-copy"><p>OpenFon is open-source software. Host it in your own Cloudflare account, choose a compatible AI provider, and keep your call records in your own database.</p><dl><div><dt>Software</dt><dd>Free, under the MIT license</dd></div><div><dt>Running costs</dt><dd>Hosting, AI and speech usage; carrier costs if enabled</dd></div><div><dt>Phone numbers</dt><dd>Browser calls today; telephone adapters require a verified carrier pilot</dd></div></dl><a className="text-action" href={repo} target="_blank" rel="noreferrer">Explore the source <span aria-hidden="true">↗</span></a></div></section>
      <section className="faq-section landing-section" id="questions"><div><p className="eyebrow">Before you get started</p><h2>Good questions.<br/><em>Clear answers.</em></h2></div><div className="faq-list">{[
        ['Does it answer my existing phone number?','Not yet. Today, callers use a link and speak from their browser, or type if they prefer. Connecting an existing telephone number requires a telephony integration that is still in development.'],
        ['Why is Kataleptic the default?','Kataleptic is the OpenFon founder’s paid inference service. It is an optional convenience, with a separate account and usage bill. Alternative providers need the right text, speech or realtime capability; the repository documents their verification status.'],
        ['What does my assistant know?','The business details and active knowledge you give it. You can add FAQs, service information, and notes, then test its answers. AI can still make mistakes, so review important information and keep your knowledge current.'],
        ['Does OpenFon make bookings?','It can capture a booking request and caller details for your team. It does not confirm appointments or connect to a calendar.'],
        ['Do I need to be technical?','Using the studio is designed to be straightforward. Self-hosting requires setting up Cloudflare and an AI provider. The repository includes the installation steps and configuration guide.'],
        ['Is everything free?','The OpenFon software is free and MIT licensed. Hosting, speech, language-model, and any future telephony services have their own usage costs. Those depend on your providers and traffic.'],
        ['Where do conversations go?','Transcripts and summaries are stored in the instance’s database. Your configured speech and AI providers process the conversation to respond. If you self-host, you choose and manage those providers.'],
      ].map(([q,a]) => <details key={q}><summary>{q}<span aria-hidden="true">+</span></summary><p>{a}</p></details>)}</div></section>
      <section className="closing-section"><p className="eyebrow">Start with a conversation</p><h2>Meet your next<br/><em>helpful team member.</em></h2><Link className="landing-button light-button" to={me ? '/overview' : '/auth'}>{me ? 'Open your studio' : 'Create your assistant'} <span aria-hidden="true">↗</span></Link><a href={`${repo}#self-hosting`} target="_blank" rel="noreferrer">Or make yourself at home. Self-host OpenFon ↗</a></section>
    </main>
    <footer className="landing-footer"><Link className="wordmark" to="/">openfon.</Link><p>An open line to your business.</p><div><a href={repo} target="_blank" rel="noreferrer">GitHub ↗</a><a href={`${repo}/blob/main/LICENSE`} target="_blank" rel="noreferrer">MIT license ↗</a><a href={`${repo}/issues`} target="_blank" rel="noreferrer">Feedback ↗</a></div><span>By Duguet Labs</span></footer>
  </div>;
}
