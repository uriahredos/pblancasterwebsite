// Profile photo: shrink it on the phone before it is sent, and show it straight away.
(function () {
  var input = document.getElementById('photo-input');
  var preview = document.getElementById('photo-preview');
  if (!input || !window.FileReader || !window.DataTransfer) return;
  input.addEventListener('change', function () {
    var file = input.files && input.files[0];
    if (!file || !/^image\//.test(file.type)) return;
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      var side = Math.min(img.naturalWidth, img.naturalHeight);
      var out = Math.min(600, side);
      var canvas = document.createElement('canvas');
      canvas.width = out; canvas.height = out;
      // A centred square, so every photo fits the round frame the same way.
      canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, out, out);
      URL.revokeObjectURL(url);
      canvas.toBlob(function (blob) {
        if (!blob) return;
        try {
          var dt = new DataTransfer();
          dt.items.add(new File([blob], 'photo.jpg', { type: 'image/jpeg' }));
          input.files = dt.files;
        } catch (e) { return; }
        if (preview) {
          var shown = document.createElement('img');
          shown.className = 'avatar xl'; shown.alt = ''; shown.src = URL.createObjectURL(blob);
          preview.innerHTML = ''; preview.appendChild(shown);
        }
      }, 'image/jpeg', 0.85);
    };
    img.src = url;
  });
})();
