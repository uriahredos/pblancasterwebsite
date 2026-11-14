// Photos picked on a phone are huge. Shrink each one before it is sent, so posting is quick on a weak signal.
(function () {
  if (!window.DataTransfer || !window.File || !HTMLCanvasElement.prototype.toBlob) return;
  function shrink(file, max) {
    return new Promise(function (resolve) {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return resolve(file);
      var url = URL.createObjectURL(file), img = new Image();
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.onload = function () {
        var scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        if (scale === 1 && file.size < 900000) { URL.revokeObjectURL(url); return resolve(file); }
        var c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (blob) { resolve(blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file); }, 'image/jpeg', 0.82);
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
