// Scan a part's barcode with the phone camera and drop the number into the parts form.
// The scanning library is only downloaded the first time Scan is pressed.
(function () {
  var btn = document.getElementById('scan-btn');
  var overlay = document.getElementById('scan-overlay');
  if (!btn || !overlay || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  var msg = document.getElementById('scan-msg');
  var scanner = null;
  var loading = null;
  btn.hidden = false;

  function loadLibrary() {
    if (window.Html5Qrcode) return Promise.resolve();
    if (!loading) {
      loading = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = '/vendor/html5-qrcode.min.js';
        s.onload = resolve;
        s.onerror = function () { loading = null; reject(new Error('load')); };
        document.head.appendChild(s);
      });
    }
    return loading;
  }

  function close() {
    overlay.hidden = true;
    var s = scanner;
    scanner = null;
    if (s) s.stop().then(function () { s.clear(); }).catch(function () {});
  }

  function found(text) {
    var value = String(text || '').trim();
    if (!value) return;
    close();
    if (window.partsForm) window.partsForm.addPart(value);
  }
  // Lets the result handler be exercised without a camera.
  window.partsScan = { found: found };

  btn.addEventListener('click', function () {
    overlay.hidden = false;
    msg.textContent = 'Starting the camera…';
    loadLibrary().then(function () {
      scanner = new window.Html5Qrcode('scan-view');
      return scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: function (w, h) { return { width: Math.round(Math.min(w, 420) * 0.9), height: Math.round(Math.min(h, 300) * 0.45) }; } },
        found,
        function () {} // called for every frame with no barcode in it
      );
    }).then(function () {
      msg.textContent = 'Hold steady with the barcode inside the box.';
    }).catch(function (err) {
      scanner = null;
      msg.textContent = /Permission|NotAllowed/i.test(String(err))
        ? 'The camera is blocked for this site. Allow it in your browser settings, or type the part number.'
        : 'The camera could not be started. Type the part number instead.';
    });
  });
  document.getElementById('scan-close').addEventListener('click', close);
})();
