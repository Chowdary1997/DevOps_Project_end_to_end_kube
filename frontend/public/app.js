(() => {
  'use strict';

  const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
  const $ = (selector) => document.querySelector(selector);
  const form = $('#subscribe-form');
  const card = $('#subscribe');
  const emailInput = $('#email');
  const emailError = $('#email-error');
  const statusEl = $('#form-status');
  const submitBtn = form.querySelector('button[type="submit"]');
  const countdown = $('#countdown');
  const dateEl = $('#launch-date');
  const headline = $('#headline');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  $('#year').textContent = new Date().getFullYear();

  // Pointer effects. Values are set through CSSOM, which the CSP permits (inline style attributes are not).
  if (!reduceMotion && matchMedia('(pointer: fine)').matches) {
    const root = document.documentElement;
    addEventListener('pointermove', (event) => {
      root.style.setProperty('--px', (event.clientX / innerWidth - 0.5).toFixed(3));
      root.style.setProperty('--py', (event.clientY / innerHeight - 0.5).toFixed(3));
    }, { passive: true });
    card.addEventListener('pointermove', (event) => {
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${event.clientX - rect.left}px`);
      card.style.setProperty('--my', `${event.clientY - rect.top}px`);
    }, { passive: true });
  }

  // Countdown. Each changed digit plays a short entrance animation.
  let launchAt = null;
  let timer = null;
  const units = {};
  countdown.querySelectorAll('[data-unit]').forEach((el) => { units[el.dataset.unit] = el; });
  const pad = (n) => String(n).padStart(2, '0');

  function setUnit(name, value) {
    const el = units[name];
    const next = pad(value);
    if (el.textContent === next) return;
    el.textContent = next;
    if (!reduceMotion) {
      el.classList.remove('tick');
      void el.offsetWidth;
      el.classList.add('tick');
    }
  }

  function renderCountdown() {
    const diff = Math.max(0, launchAt - Date.now());
    setUnit('days', Math.floor(diff / 864e5));
    setUnit('hours', Math.floor((diff % 864e5) / 36e5));
    setUnit('minutes', Math.floor((diff % 36e5) / 6e4));
    setUnit('seconds', Math.floor((diff % 6e4) / 1e3));
    if (diff === 0) clearInterval(timer);
  }

  async function loadConfig() {
    try {
      const res = await fetch('/api/config', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('Config request failed');
      const cfg = await res.json();
      if (cfg.launched) {
        headline.textContent = "We're live.";
        dateEl.textContent = 'The site is now open to everyone.';
        card.hidden = true;
        countdown.hidden = true;
        return;
      }
      if (cfg.launchAt) {
        launchAt = Date.parse(cfg.launchAt);
        countdown.hidden = false;
        dateEl.textContent = `Launching ${new Date(launchAt).toLocaleString(undefined, {
          dateStyle: 'full', timeStyle: 'short',
        })}`;
        renderCountdown();
        timer = setInterval(renderCountdown, 1000);
      }
    } catch (err) {
      dateEl.textContent = 'Launch date to be announced';
    }
  }

  function setStatus(message, type = '') {
    statusEl.textContent = message;
    statusEl.className = `status ${type}`.trim();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    emailError.textContent = '';
    emailInput.removeAttribute('aria-invalid');
    setStatus('');

    const data = new FormData(form);
    const values = {
      email: String(data.get('email') ?? '').trim().toLowerCase(),
      notifyLaunch: data.has('notifyLaunch'),
      notifyUpdates: data.has('notifyUpdates'),
      consent: data.has('consent'),
      website: String(data.get('website') ?? ''),
    };

    if (!EMAIL_RE.test(values.email) || values.email.length > 254) {
      emailError.textContent = 'Please enter a valid email address.';
      emailInput.setAttribute('aria-invalid', 'true');
      emailInput.focus();
      return;
    }
    if (!values.consent) {
      setStatus('Please accept the privacy notice to subscribe.', 'error');
      return;
    }

    submitBtn.disabled = true;
    setStatus('Submitting…');
    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(values),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Something went wrong. Please try again.');
      form.reset();
      setStatus(body.message, 'success');
    } catch (err) {
      setStatus(err.message || 'Network error. Please try again.', 'error');
    } finally {
      submitBtn.disabled = false;
    }
  });

  loadConfig();
})();
