// Runs before the page is drawn so the light/dark choice applies without a flash.
// The site is dark unless this person has chosen light with the switch (the page itself arrives marked dark).
(function () {
  var saved = null;
  try { saved = localStorage.getItem('theme'); } catch (e) {}
  document.documentElement.setAttribute('data-theme', saved === 'light' ? 'light' : 'dark');
  // A touch screen with no mouse is a phone or tablet, and the site locks sooner on those than on a desk computer.
  // An iPad tells websites it is a Mac, so the site cannot work this out by itself: this note tells it.
  try {
    var touch = Boolean(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    document.cookie = 'portal.touch=' + (touch ? '1' : '0') + '; path=/; max-age=' + (touch ? 31536000 : 0) + '; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
  } catch (e) {}
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
