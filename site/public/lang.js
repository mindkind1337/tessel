/* Language before the first paint: a saved choice, then #fr / #en, then the browser's language. */
(function () {
  var l = null;
  try { l = localStorage.getItem('tessel-lang'); } catch (e) {}
  if (location.hash === '#fr') l = 'fr';
  else if (location.hash === '#en') l = 'en';
  if (l !== 'fr' && l !== 'en') {
    var b = (navigator.languages && navigator.languages[0]) || navigator.language || '';
    l = /^fr\b/i.test(b) ? 'fr' : 'en';
  }
  document.documentElement.lang = l;
})();
