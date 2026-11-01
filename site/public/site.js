/* Language switch for the home page. Both languages are in the HTML; the CSS
   shows the one that <html lang> names. The choice stays in this browser only. */
(function () {
  'use strict';
  var TEXT = {
    en: {
      title: 'Tessel: AI coding agents and terminals, side by side',
      description:
        'Tessel is a Windows desktop app for working with terminals and AI coding agents side by side: split one window into panes, run Claude Code, Codex, Gemini CLI and 20+ other agents, and let them work as a team. Tessel Agents connects your Gmail, Google Calendar and Google Drive to the agents on your own computer.'
    },
    fr: {
      title: "Tessel : agents d’IA pour le code et terminaux, côte à côte",
      description:
        "Tessel est une application de bureau Windows pour travailler avec des terminaux et des agents d’IA pour le code, côte à côte : divisez une fenêtre en panneaux, lancez Claude Code, Codex, Gemini CLI et plus de 20 autres agents, et laissez-les travailler en équipe. Tessel Agents connecte votre Gmail, Google Agenda et Google Drive aux agents de votre propre ordinateur."
    }
  };

  function apply(lang) {
    var doc = document.documentElement;
    doc.lang = lang;
    document.title = TEXT[lang].title;
    var meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', TEXT[lang].description);
    var buttons = document.querySelectorAll('[data-set-lang]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-pressed', String(buttons[i].getAttribute('data-set-lang') === lang));
    }
    document.dispatchEvent(new CustomEvent('tessel:lang', { detail: lang }));
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-set-lang]') : null;
    if (!b) return;
    var lang = b.getAttribute('data-set-lang');
    try {
      localStorage.setItem('tessel-lang', lang);
    } catch (err) {
      /* The choice just lasts for this page. */
    }
    if (location.hash === '#fr' || location.hash === '#en') {
      history.replaceState(null, '', location.pathname + location.search);
    }
    apply(lang);
  });

  apply(document.documentElement.lang === 'fr' ? 'fr' : 'en');
})();

/* The demo: Tessel's real interface in a frame (demo/, built from the app's own
   source). Loaded only when it is about to be seen, so the page stays fast; paused
   while out of sight. Tessel is a desktop window of a fixed minimum size, so a narrower
   frame shows it scaled down, whole. */
(function () {
  'use strict';
  var box = document.getElementById('demo');
  if (!box) return;
  var WIDTH = 1200; // below this, the window is scaled down
  var HEIGHT = 760;
  var SMALL = 0.6; // below this scale it is too small to use
  var frame = null;
  var lang = document.documentElement.lang === 'fr' ? 'fr' : 'en';

  function fit() {
    var room = box.clientWidth;
    if (!room) return;
    var width = Math.max(room, WIDTH);
    var scale = room / width;
    box.style.height = Math.round(HEIGHT * scale) + 'px';
    box.classList.toggle('is-small', scale < SMALL);
    if (!frame) return;
    frame.style.width = width + 'px';
    frame.style.height = HEIGHT + 'px';
    frame.style.transform = scale < 1 ? 'scale(' + scale + ')' : '';
  }

  function load() {
    if (frame) return;
    frame = document.createElement('iframe');
    frame.title = lang === 'fr' ? 'Démo de Tessel' : 'Tessel demo';
    /* Its own scripts and files, and no popup, no navigation of this page. */
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.src = 'demo/?lang=' + lang;
    /* Loaded ahead of being seen: its agents wait until they are. */
    frame.addEventListener('load', tell);
    box.appendChild(frame);
    fit();
  }

  var seen = false;
  function tell() {
    if (frame && frame.contentWindow) frame.contentWindow.postMessage({ type: 'tessel-demo', visible: seen }, location.origin);
  }

  fit();
  window.addEventListener('resize', fit);

  document.addEventListener('tessel:lang', function (e) {
    if (e.detail === lang) return;
    lang = e.detail;
    if (frame) {
      frame.title = lang === 'fr' ? 'Démo de Tessel' : 'Tessel demo';
      frame.src = 'demo/?lang=' + lang;
    }
  });

  if (!('IntersectionObserver' in window)) {
    seen = true;
    return load();
  }
  new IntersectionObserver(
    function (entries) {
      for (var i = 0; i < entries.length; i++) if (entries[i].isIntersecting) load();
    },
    { rootMargin: '600px 0px' }
  ).observe(box);
  new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) seen = entries[i].isIntersecting;
    tell();
  }).observe(box);
})();
