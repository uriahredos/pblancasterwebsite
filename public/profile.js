// Profile photo: choose a picture, then zoom and drag it so the round frame shows the part you want.
// The cropped square is what gets sent, shrunk on the phone first.
(function () {
  var input = document.getElementById('photo-input');
  var preview = document.getElementById('photo-preview');
  var tools = document.getElementById('photo-crop');
  var zoom = document.getElementById('photo-zoom');
  if (!input || !window.FileReader || !window.DataTransfer || !HTMLCanvasElement.prototype.toBlob) return;
  var VIEW = 208, OUT = 600;
  var img = null, z = 1, cx = 0, cy = 0, canvas = null, timer = null;

  function side() { return Math.min(img.naturalWidth, img.naturalHeight) / z; }
  function clamp() {
    var half = side() / 2;
    cx = Math.min(img.naturalWidth - half, Math.max(half, cx));
    cy = Math.min(img.naturalHeight - half, Math.max(half, cy));
  }
  function draw(target, size) {
    var s = side();
    target.width = size; target.height = size;
    target.getContext('2d').drawImage(img, cx - s / 2, cy - s / 2, s, s, 0, 0, size, size);
  }
  function show() { clamp(); draw(canvas, VIEW * 2); }
  // Puts the cropped square into the form in place of the file that was picked.
  function apply() {
    var out = document.createElement('canvas');
    draw(out, Math.round(Math.min(OUT, side())));
    out.toBlob(function (blob) {
      if (!blob) return;
      try { var dt = new DataTransfer(); dt.items.add(new File([blob], 'photo.jpg', { type: 'image/jpeg' })); input.files = dt.files; } catch (e) {}
    }, 'image/jpeg', 0.85);
  }
  function later() { clearTimeout(timer); timer = setTimeout(apply, 150); }

  input.addEventListener('change', function () {
    var file = input.files && input.files[0];
    if (!file || !/^image\//.test(file.type)) return;
    var url = URL.createObjectURL(file);
    var loaded = new Image();
    loaded.onload = function () {
      img = loaded; z = 1; cx = img.naturalWidth / 2; cy = img.naturalHeight / 2;
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.className = 'photo-canvas'; canvas.setAttribute('aria-label', 'Your photo. Drag to move it.');
        var start = null;
        canvas.addEventListener('pointerdown', function (e) { start = { x: e.clientX, y: e.clientY, cx: cx, cy: cy }; canvas.setPointerCapture(e.pointerId); });
        canvas.addEventListener('pointermove', function (e) {
          if (!start) return;
          var scale = side() / canvas.getBoundingClientRect().width;
          cx = start.cx - (e.clientX - start.x) * scale; cy = start.cy - (e.clientY - start.y) * scale;
          show();
        });
        var end = function () { if (start) { start = null; later(); } };
        canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
        if (preview) { preview.innerHTML = ''; preview.appendChild(canvas); }
      }
      if (zoom) zoom.value = '1';
      if (tools) tools.hidden = false;
      show(); apply();
    };
    loaded.src = url;
  });
  if (zoom) zoom.addEventListener('input', function () { if (!img) return; z = Number(zoom.value) || 1; show(); later(); });
})();
