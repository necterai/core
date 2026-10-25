// The demo site's own JavaScript: a trusted origin (/static/) for the harvest module.
(function () {
  var btn = document.getElementById('load-more');
  if (btn) {
    btn.addEventListener('click', function () {
      var status = document.getElementById('api-status');
      status.textContent = 'loading…';
      fetch('/api/products').then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); }).then(function (d) {
        status.textContent = d.items.length + ' prices loaded';
      }).catch(function (e) { status.textContent = 'API refused (' + e + ')'; });
    });
  }
  document.querySelectorAll('[data-add]').forEach(function (b) {
    b.addEventListener('click', function () { b.textContent = 'Added'; });
  });
})();
