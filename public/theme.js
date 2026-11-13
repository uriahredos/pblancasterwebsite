// Runs before the page is drawn so a saved light/dark choice applies without a flash.
(function () {
  var saved = null;
  try { saved = localStorage.getItem('theme'); } catch (e) {}
  if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
  // Lets the styling collapse the menu on phones only when scripts are running to reopen it.
  document.documentElement.classList.add('js');
})();
