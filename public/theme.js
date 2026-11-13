// Runs before the page is drawn so a saved light/dark choice applies without a flash.
(function () {
  var saved = null;
  try { saved = localStorage.getItem('theme'); } catch (e) {}
  if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
  // Lets the styling collapse the menu on phones only when scripts are running to reopen it.
  document.documentElement.classList.add('js');
  // Signed in, but this tab was not open a moment ago: the site was closed and reopened.
  // Keep the page hidden until site.js has checked and, if so, locked it.
  var root = document.documentElement;
  if (root.hasAttribute('data-in')) {
    var open = true;
    try {
      if (root.hasAttribute('data-fresh')) sessionStorage.setItem('open', '1');
      open = sessionStorage.getItem('open') === '1';
    } catch (e) {}
    if (!open) root.classList.add('checking');
  }
})();
