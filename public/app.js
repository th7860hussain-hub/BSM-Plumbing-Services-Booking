const form = document.getElementById('quote');
const msg = document.getElementById('msg');
document.getElementById('yr').textContent = new Date().getFullYear();
document.getElementById('reviews').hidden = true;

fetch('/schema.json').then((r) => r.text()).then((t) => {
  const s = document.createElement('script');
  s.type = 'application/ld+json';
  s.textContent = t;
  document.head.appendChild(s);
}).catch(() => {});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = 'Sending...';
  const res = await fetch('/api/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.fromEntries(new FormData(form))),
  });
  const j = await res.json().catch(() => ({}));
  if (res.ok) { msg.textContent = `Thanks! Reference ${j.reference}. We'll be in touch.`; form.reset(); }
  else msg.textContent = j.details ? j.details.map((d) => `${d.field}: ${d.message}`).join('; ') : (j.error || 'Error');
});

fetch('/api/reviews').then((r) => (r.ok ? r.json() : null)).then((d) => {
  if (!d) return;
  const el = document.getElementById('reviews');
  el.hidden = false;
  const h = document.createElement('h2');
  h.textContent = `Google reviews: ${d.rating} ★ (${d.count})`;
  el.appendChild(h);
  d.reviews.forEach((v) => {
    const b = document.createElement('blockquote');
    b.textContent = `${'★'.repeat(v.rating)} ${v.text || ''} - ${v.author}`;
    el.appendChild(b);
  });
});
