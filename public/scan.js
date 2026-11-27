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

  var held = false;      // a scan is being dealt with on the camera screen: further reads wait
  var last = { code: '', at: 0 };

  function close() {
    overlay.hidden = true;
    held = false;
    var s = scanner;
    scanner = null;
    if (s) { try { if (s.getState && s.getState() === 3) s.resume(); } catch (e) {} s.stop().then(function () { s.clear(); }).catch(function () {}); }
    if (window.partsForm && window.partsForm.onClose) window.partsForm.onClose();
  }

  function found(text) {
    var value = String(text || '').trim();
    var page = window.partsForm || {};
    if (!value || held) return;
    // The count sheet deals with a scan on the camera screen itself, then asks for the next one.
    if (page.onScan) {
      if (value === last.code && Date.now() - last.at < 2500) return;   // the one just saved, still in view
      held = true;
      try { if (scanner) scanner.pause(true); } catch (e) {}
      page.onScan(value, { next: function () { last = { code: value, at: Date.now() }; held = false; try { if (scanner) scanner.resume(); } catch (e) {} } });
      return;
    }
    close();
    if (!page.addPart) return;
    // A barcode someone has matched to a part before goes in as that part's number.
    fetch('/parts/lookup?code=' + encodeURIComponent(value), { credentials: 'same-origin' }).then(function (r) { return r.json(); })
      .then(function (d) { page.addPart(d && d.found ? d.part_number : value); }, function () { page.addPart(value); });
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
