const stage = document.querySelector('#logo-stage');
const specimen = document.querySelector('#logo-specimen');
const download = document.querySelector('#logo-download');
document.querySelectorAll('[data-logo]').forEach(button => {
  button.addEventListener('click', () => {
    const treatment = button.dataset.logo;
    document.querySelectorAll('[data-logo]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    stage.classList.toggle('inverse', treatment === 'inverse');
    specimen.src = `assets/openfon-logo-${treatment}.svg`;
    download.href = specimen.getAttribute('src');
  });
});

const samples = {
  en: {
    welcome: ['Introducing OpenFon', 'A warm welcome. A clear next step.', 'An AI receptionist for small businesses.'],
    teach: ['Teaching the receptionist', 'Start with the questions you hear most.', 'Add your opening hours, services and useful business details. Then try a conversation.'],
    failure: ['A save didn’t work', 'We couldn’t save your changes.', 'Try again.'],
    unknown: ['An answer is missing', 'I don’t have that information.', 'May I take a message?']
  },
  de: {
    welcome: ['OpenFon vorstellen', 'Freundlich empfangen. Klar weiterhelfen.', 'Eine KI-Rezeption für kleine Unternehmen.'],
    teach: ['Die Rezeption vorbereiten', 'Beginnen Sie mit häufigen Fragen.', 'Ergänzen Sie Öffnungszeiten, Leistungen und wichtige Informationen zu Ihrem Unternehmen. Testen Sie anschließend ein Gespräch.'],
    failure: ['Speichern fehlgeschlagen', 'Ihre Änderungen konnten nicht gespeichert werden.', 'Versuchen Sie es erneut.'],
    unknown: ['Eine Antwort fehlt', 'Diese Information liegt mir nicht vor.', 'Darf ich eine Nachricht aufnehmen?']
  }
};
let language = 'en';
const situation = document.querySelector('#voice-situation');
function updateVoice() {
  const [label, line, detail] = samples[language][situation.value];
  document.querySelector('.voice-example').lang = language;
  document.querySelector('#voice-label').textContent = label;
  document.querySelector('#voice-line').textContent = line;
  document.querySelector('#voice-detail').textContent = detail;
}
document.querySelectorAll('[data-lang]').forEach(button => {
  button.addEventListener('click', () => {
    language = button.dataset.lang;
    document.querySelectorAll('[data-lang]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    updateVoice();
  });
});
situation.addEventListener('change', updateVoice);
let toastTimer;
document.querySelectorAll('[data-color]').forEach(button => {
  button.addEventListener('click', async () => {
    const toast = document.querySelector('#toast');
    try {
      await navigator.clipboard.writeText(button.dataset.color);
      toast.textContent = `${button.dataset.color} copied`;
    } catch {
      toast.textContent = `Color code: ${button.dataset.color}. Select and copy it manually.`;
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.textContent = ''; }, 5000);
  });
});
