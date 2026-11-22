// Photos picked on a phone are huge, and carry hidden details: where and when they were taken, and on which phone.
// Each one is redrawn here before it is sent, the right way up. That makes it quick to post on a weak signal and
// leaves the hidden details behind, however small the picture already was. It is saved in the smallest form the
// browser can write, so the site's disk goes further.
(function () {
  if (!window.DataTransfer || !window.File || !HTMLCanvasElement.prototype.toBlob) return;
  function shrink(file, max) {
    return new Promise(function (resolve) {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return resolve(file);
      var url = URL.createObjectURL(file), img = new Image();
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.onload = function () {
        var scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas'), ctx = c.getContext('2d');
        c.width = Math.max(1, Math.round(img.naturalWidth * scale)); c.height = Math.max(1, Math.round(img.naturalHeight * scale));
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);   // a see-through picture gets a white background, not a black one
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        var name = file.name.replace(/\.\w+$/, '');
        var asJpeg = function () { c.toBlob(function (blob) { resolve(blob ? new File([blob], name + '.jpg', { type: 'image/jpeg' }) : file); }, 'image/jpeg', 0.8); };
        // WebP makes the same picture a good deal smaller than JPEG, so it is tried first. A browser that cannot write
        // WebP (Safari on an iPhone) hands back something else instead, and then the picture goes as a JPEG as before.
        c.toBlob(function (blob) {
          if (blob && blob.type === 'image/webp') resolve(new File([blob], name + '.webp', { type: 'image/webp' })); else asJpeg();
        }, 'image/webp', 0.8);
      };
      img.src = url;
    });
  }
  document.querySelectorAll('input[type=file][data-shrink]').forEach(function (input) {
    var max = Number(input.getAttribute('data-shrink')) || 1600;
    input.addEventListener('change', function () {
      var files = Array.prototype.slice.call(input.files || []);
      if (!files.length) return;
      Promise.all(files.map(function (f) { return shrink(f, max); })).then(function (done) {
        try { var dt = new DataTransfer(); done.forEach(function (f) { dt.items.add(f); }); input.files = dt.files; } catch (e) {}
      });
    });
  });
})();
