// Návštěvnost webu bez cookies (admin Reporty -> Návštěvnost, server routes/navstevnost.js).
// Při načtení stránky pošle adresu stránky a odkud návštěvník přišel. Nic neukládá
// do prohlížeče kromě příznaku, že jde o prohlížeč majitelky (nastaví admin).
// E-shop navíc hlásí otevření detailu boty přes window.dkNavsteva(slug).
(function () {
  var API = 'https://detskekrucky1.onrender.com/api/navstevnost';

  function nepocitat() {
    // Web vložený jako náhled do jiné stránky (např. portfolio studiosalena.cz) není návštěva
    try { if (window.self !== window.top) return true; } catch (e) { return true; }
    try { return localStorage.getItem('dkNepocitatNavstevy') === '1'; } catch (e) { return false; }
  }

  function poslat(data) {
    if (nepocitat()) return;
    try {
      // text/plain = jednoduchý požadavek bez CORS preflightu
      fetch(API, { method: 'POST', body: JSON.stringify(data), headers: { 'Content-Type': 'text/plain' }, keepalive: true, mode: 'cors', credentials: 'omit' }).catch(function () {});
    } catch (e) {}
  }

  var q = new URLSearchParams(location.search);
  var kampan = q.get('utm_source') || (q.get('fbclid') ? 'facebook' : '') || (q.get('gclid') ? 'google' : '');
  var cesta = document.querySelector('meta[name="dk-stranka"]');
  poslat({
    stranka: cesta ? cesta.content : location.pathname,
    odkaz: document.referrer,
    kampan: kampan
  });

  // Otevření detailu boty v e-shopu (přechod uvnitř webu, ne nový příchod)
  window.dkNavsteva = function (produkt) {
    poslat({ stranka: location.pathname, produkt: produkt, odkaz: location.href });
  };
})();
