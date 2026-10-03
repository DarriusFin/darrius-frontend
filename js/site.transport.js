(function () {
  'use strict';
  var location = window.location;
  if (location.protocol === 'http:' && /^(www\.)?darrius\.ai$/.test(location.hostname)) {
    location.replace('https://' + location.host + location.pathname + location.search + location.hash);
  }
})();
