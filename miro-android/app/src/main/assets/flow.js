function miroStep() {
  var vis = function (e) {
    var r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  var label = function (e) {
    return ((e.innerText || e.value || e.getAttribute('aria-label') || '') + '').replace(/\s+/g, ' ').trim();
  };
  var stop = function (reason) { return { action: 'stop', reason: reason }; };

  // Signature of this page, so the caller can tell when the next page has appeared.
  var sig = location.href + '|' + ((document.body && document.body.innerText) || '').slice(0, 300);

  var inputs = [].slice.call(document.querySelectorAll('input,select,textarea')).filter(vis);

  // Human checks always stay with the person.
  var humanField = inputs.some(function (e) {
    return /captcha|otp|one.?time|verification.?code|security.?code/i.test(
      [e.name, e.id, e.placeholder, e.getAttribute('aria-label')].join(' '));
  });
  var humanBox = [].slice.call(document.querySelectorAll(
    'iframe[src*="recaptcha"],iframe[src*="hcaptcha"],.g-recaptcha,.h-captcha')).some(vis);
  if (humanField || humanBox) return stop('Please complete the CAPTCHA / OTP yourself, then tap Fill + Continue again.');

  // Required boxes that are still empty, invalid boxes, unticked required consent.
  var empty = inputs.filter(function (e) {
    var t = (e.type || '').toLowerCase();
    if (t === 'hidden' || t === 'checkbox' || t === 'radio' || t === 'file') return false;
    var req = e.required || e.getAttribute('aria-required') === 'true';
    return req && !String(e.value || '').trim();
  });
  if (empty.length) return stop('A required field is empty. Fill it yourself, then tap Fill + Continue again.');
  if (inputs.some(function (e) { return e.getAttribute('aria-invalid') === 'true'; }))
    return stop('A field looks invalid. Please correct it, then tap Fill + Continue again.');
  if (inputs.some(function (e) { return e.type === 'checkbox' && e.required && !e.checked; }))
    return stop('Please tick the required consent box yourself, then tap Fill + Continue again.');

  var buttons = [].slice.call(document.querySelectorAll(
    'button,input[type=submit],input[type=button],a[role=button],[role=button]')).filter(function (e) {
    return vis(e) && !e.disabled && e.getAttribute('aria-disabled') !== 'true';
  });
  var payRe = /\bpay\b|payment|place (your )?order|\bbuy\b|purchase|checkout|donate/i;
  var nextRe = /\b(continue|next|proceed)\b/i;
  var submitRe = /^(submit|confirm|register|apply|send|book( now)?)(\s+\w+){0,3}[\s\u203a>\u00bb\u2192]*$/i;

  var pick = function (re, max) {
    return buttons.filter(function (e) {
      var l = label(e);
      return l && l.length < max && re.test(l) && !payRe.test(l);
    })[0];
  };
  var next = pick(nextRe, 40);
  var sub = pick(submitRe, 40);
  if (sub === next) sub = null;

  var tapped = [];
  var tap = function (e) {
    e.scrollIntoView({ block: 'center' });
    tapped.push(label(e));
    e.click();
  };
  if (next) tap(next);
  if (sub) tap(sub);
  if (tapped.length) return { action: 'clicked', reason: tapped.join('\u201d and \u201c'), sig: sig };

  if (buttons.some(function (e) { return payRe.test(label(e)); }))
    return stop('Reached the payment step. Please complete the payment yourself.');
  return stop('No Continue or Submit button found on this page.');
}
